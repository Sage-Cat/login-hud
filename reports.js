/* Pure report, status, alert, and cleanup presentation helpers. */
const STATUS_DIRECTORY = 'workspace-state';
const STATUS_FILENAME = 'login-hud-status.json';
const ALERTS_FILENAME = 'alerts.json';
const GC_STATUS_FILENAME = 'status.json';
const DISMISSED_FILENAME = 'startup-hud-dismissed.json';
const CANCEL_FILENAME = 'shutdown-cancel.json';
const REQUEST_FILENAME = 'shutdown-request.json';
const RENDERED_FILENAME = 'shutdown-hud-rendered.json';
const COMMIT_FILENAME = 'shutdown-commit.json';
const PREPARED_FILENAME = 'shutdown-prepared.json';
const SESSION_MANAGER_NAME = 'org.gnome.SessionManager';
const SHUTDOWN_COORDINATOR_UNIT = 'wsctl-gnome-session.service';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const SYSTEMD_NAME = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager';
const SYSTEMD_UNIT_INTERFACE = 'org.freedesktop.systemd1.Unit';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';
const STATES = new Set([
    'pending', 'waiting', 'running', 'ready', 'degraded', 'failed', 'skipped',
]);
const TERMINAL_STATES = new Set(['ready', 'degraded', 'failed', 'skipped']);
const MODES = new Set(['startup', 'shutdown']);
const SHUTDOWN_ACTIONS = new Set(['poweroff', 'restart']);
const SHUTDOWN_ORIGINS = new Set(['preflight']);
const SHUTDOWN_COUNTDOWN_SECONDS = 5;
const PREFLIGHT_STATUS_TIMEOUT_MS = 15000;
// The coordinator has a 30-second app-drain budget after countdown commit.
// Keep a bounded margin for publishing its result before cancelling handoff.
const PREPARED_POLL_TIMEOUT_MS = 35000;
const STALE_STARTUP_PRESENTATION_MS = 5 * 60 * 1000;
const GC_STALE_AFTER_MS = 30 * 1000;
const GC_FUTURE_TOLERANCE_MS = 5 * 1000;
const GC_MAX_STATUS_BYTES = 2 * 1024 * 1024;
const GC_MAX_PROFILES = 256;
const GC_STATES = new Set(['pending', 'running', 'ok', 'failed', 'disabled']);

function text(value, fallback = '') {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function fraction(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    return Math.max(0, Math.min(1, value));
}

function stageProgress(stage) {
    if (stage.fraction !== null)
        return stage.fraction;
    return TERMINAL_STATES.has(stage.state) ? 1 : 0;
}

function aggregateState(stages) {
    const states = stages.map(stage => stage.state);
    if (states.includes('failed'))
        return 'failed';
    if (states.includes('running'))
        return 'running';
    if (states.includes('waiting'))
        return 'waiting';
    if (states.includes('pending'))
        return 'pending';
    if (states.includes('degraded'))
        return 'degraded';
    if (states.every(state => state === 'skipped'))
        return 'skipped';
    return 'ready';
}

function groupStages(stages) {
    const jobs = [];
    const groups = new Map();
    for (const stage of stages) {
        if (!stage.groupId) {
            jobs.push({...stage, children: []});
            continue;
        }
        let group = groups.get(stage.groupId);
        if (!group) {
            group = {
                id: `group:${stage.groupId}`,
                name: stage.groupLabel || stage.groupId,
                groupId: stage.groupId,
                children: [],
                events: [],
            };
            groups.set(stage.groupId, group);
            jobs.push(group);
        }
        group.children.push(stage);
    }

    for (const group of groups.values()) {
        group.state = aggregateState(group.children);
        group.fraction = group.children.reduce(
            (sum, child) => sum + stageProgress(child), 0
        ) / group.children.length;
        const finished = group.children.filter(child => TERMINAL_STATES.has(child.state)).length;
        const active = group.children.find(child => child.state === 'failed') ||
            group.children.find(child => child.state === 'running') ||
            group.children.find(child => child.state === 'waiting') ||
            group.children.find(child => child.state === 'pending');
        group.message = `${finished}/${group.children.length} steps complete`;
        if (active)
            group.message += ` · ${active.name}: ${active.message}`;
        group.events = group.children.flatMap(child => child.events.map(event => ({
            ...event,
            source: child.name,
        }))).sort((left, right) => left.at.localeCompare(right.at)).slice(-64);
    }
    return jobs;
}

function shutdownRecoveryPending(status, locallyCancelled = false) {
    if (status?.mode !== 'shutdown')
        return false;
    if (status.recoveryPending === true ||
        ['cancelling', 'recovering', 'recovery-failed'].includes(status.operationState))
        return true;
    // A scoped terminal publication can settle recovery even when untouched
    // category rows still say pending. A stale prepared report cannot settle
    // a later local cancellation merely because recovery was previously false.
    if (status.operationContext && status.recoveryPending === false &&
        ['completed', 'cancelled', 'failed'].includes(status.operationState))
        return false;
    if (locallyCancelled && !status.cancelled)
        return true;
    return status.stages.length > 0 &&
        status.stages.some(stage => !TERMINAL_STATES.has(stage.state));
}

function operationContext(raw, mode, operationId) {
    if (raw === undefined)
        return null; // Old status remains presentation-only during upgrades.
    const fields = ['boot_id', 'login_generation', 'operation_id', 'mode', 'attempt', 'deadline'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).length !== fields.length || fields.some(field => !(field in raw)) ||
        ['boot_id', 'login_generation', 'operation_id'].some(field =>
            typeof raw[field] !== 'string' || !raw[field]) ||
        raw.mode !== mode || (operationId && raw.operation_id !== operationId) ||
        !Number.isInteger(raw.attempt) || raw.attempt < 1 ||
        !Number.isFinite(raw.deadline) || raw.deadline <= 0)
        throw new Error('Invalid operation context.');
    return Object.freeze(Object.fromEntries(fields.map(field => [field, raw[field]])));
}

function sameOperationContext(left, right) {
    return Boolean(left && right) && Object.keys(left).length === 6 &&
        Object.keys(right).length === 6 && ['boot_id', 'login_generation', 'operation_id',
        'mode', 'attempt', 'deadline'].every(field => left[field] === right[field]);
}

function gcViewKey(profiles, error) {
    return JSON.stringify({error, data: profiles ? {
        profiles: profiles.profiles, stale: profiles.stale, truncated: profiles.truncated,
        daemonAvailable: profiles.daemonAvailable,
    } : null});
}

function normaliseStatus(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('The status document must be a JSON object.');

    if (raw.schema_version !== 1)
        throw new Error(`Unsupported status schema version: ${String(raw.schema_version)}.`);

    const mode = raw.mode ?? 'startup';
    if (!MODES.has(mode))
        throw new Error(`Unknown HUD mode: ${String(mode)}.`);

    const required = [
        'session_id', 'started_at', 'updated_at', 'overall_state', 'overall_message',
        'stages', 'error_log_path',
    ];
    for (const field of required) {
        if (!(field in raw))
            throw new Error(`The status document is missing ${field}.`);
    }
    if (!STATES.has(raw.overall_state))
        throw new Error(`Unknown overall state: ${String(raw.overall_state)}.`);
    if (!Array.isArray(raw.stages))
        throw new Error('The stages field must be an array.');
    const operationId = mode === 'shutdown' ? text(raw.operation_id) : null;
    if (mode === 'shutdown' && !operationId)
        throw new Error('The shutdown status is missing operation_id.');
    const shutdownAction = mode === 'shutdown' && SHUTDOWN_ACTIONS.has(raw.shutdown_action)
        ? raw.shutdown_action : null;
    const shutdownOrigin = mode === 'shutdown' && SHUTDOWN_ORIGINS.has(raw.shutdown_origin)
        ? raw.shutdown_origin : null;
    if (mode === 'shutdown' && !shutdownAction)
        throw new Error(`Unknown shutdown action: ${String(raw.shutdown_action)}.`);
    if (mode === 'shutdown' && !SHUTDOWN_ORIGINS.has(raw.shutdown_origin))
        throw new Error(`Unknown shutdown origin: ${String(raw.shutdown_origin)}.`);

    const stages = raw.stages.slice(0, 64).map((item, index) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item))
            throw new Error(`Stage ${index + 1} must be an object.`);
        for (const field of ['id', 'state', 'message']) {
            if (!(field in item))
                throw new Error(`Stage ${index + 1} is missing ${field}.`);
        }
        if (!STATES.has(item.state))
            throw new Error(`Stage ${index + 1} has an unknown state.`);
        const input = item;
        const explicitFraction = fraction(input.fraction);
        const countedFraction = typeof input.current === 'number' &&
            typeof input.total === 'number' && input.total > 0
            ? fraction(input.current / input.total) : null;
        const events = Array.isArray(input.events)
            ? input.events.slice(-32).flatMap(event => {
                if (event === null || typeof event !== 'object' || Array.isArray(event))
                    return [];
                const eventState = STATES.has(event.state) ? event.state : input.state;
                const message = text(event.message);
                if (!message)
                    return [];
                return [{
                    at: text(event.at),
                    state: eventState,
                    message,
                    source: '',
                }];
            })
            : [];
        return {
            id: text(input.id, `stage-${index + 1}`),
            name: text(input.name, text(input.label, `Stage ${index + 1}`)),
            state: input.state,
            message: text(input.message),
            fraction: explicitFraction ?? countedFraction,
            groupId: text(input.group_id) || null,
            groupLabel: text(input.group_label),
            events,
        };
    });
    const jobs = groupStages(stages);

    return {
        schemaVersion: 1,
        sessionId: text(raw.session_id, 'unknown session'),
        startedAt: text(raw.started_at),
        updatedAt: text(raw.updated_at),
        overallState: raw.overall_state,
        overallMessage: text(raw.overall_message,
            mode === 'shutdown' ? 'Saving your workspace…' : 'Preparing your session…'),
        errorLogPath: typeof raw.error_log_path === 'string' && raw.error_log_path.startsWith('/')
            ? raw.error_log_path : null,
        stages: jobs,
        mode,
        operationId,
        operationContext: operationContext(raw.operation_context, mode, operationId),
        operationState: text(raw.operation_state) || null,
        recoveryPending: typeof raw.recovery_pending === 'boolean' ? raw.recovery_pending : null,
        shutdownAction,
        shutdownOrigin,
        shutdownActionExplicit: raw.shutdown_action !== undefined,
        shutdownOriginExplicit: raw.shutdown_origin !== undefined,
        cancelled: raw.cancelled === true,
        showOnStartup: raw.show_startup_hud !== false,
    };
}

function elapsedSince(isoTimestamp) {
    const began = Date.parse(isoTimestamp);
    if (!Number.isFinite(began))
        return 'Elapsed —';

    const seconds = Math.max(0, Math.floor((Date.now() - began) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes > 0
        ? `Elapsed ${minutes}m ${String(remainder).padStart(2, '0')}s`
        : `Elapsed ${remainder}s`;
}

function displayState(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function eventTime(value) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        return '--:--:--';
    return new Date(parsed).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function stateIcon(value) {
    switch (value) {
    case 'ready':
        return 'object-select-symbolic';
    case 'degraded':
        return 'dialog-warning-symbolic';
    case 'failed':
        return 'dialog-error-symbolic';
    case 'skipped':
        return 'media-skip-forward-symbolic';
    case 'running':
        return 'system-run-symbolic';
    default:
        return 'go-next-symbolic';
    }
}

function overallFraction(stages) {
    if (stages.length === 0)
        return 0;
    const total = stages.reduce((sum, stage) => {
        if (stage.fraction !== null)
            return sum + stage.fraction;
        return sum + (TERMINAL_STATES.has(stage.state) ? 1 : 0);
    }, 0);
    return total / stages.length;
}

// Work-area coordinates are stage pixels; St CSS lengths are logical pixels.
function normalizeAlerts(raw) {
    if (raw?.schema_version !== 1 || !Array.isArray(raw.sources) ||
        !Array.isArray(raw.incidents) || raw.sources.length > 64 || raw.incidents.length > 200)
        throw new Error('Invalid owned-system report');
    const sources = raw.sources.filter(source => source && typeof source === 'object' &&
        source.ownership === 'first-party' && typeof source.id === 'string' &&
        /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(source.id) && typeof source.label === 'string').map(source => ({
        ...source, label: source.label.slice(0, 120), host: String(source.host ?? 'local').slice(0, 80),
        source_ref: String(source.source_ref ?? '').slice(0, 300),
        detail: String(source.detail ?? '').slice(0, 1500),
    }));
    const ids = new Set(sources.map(source => source.id));
    const severities = {"auth-required": "blocker", "service-failed": "critical",
        "service-unavailable": "blocker", "restart-loop": "critical", "plugin-failed": "critical", "critical-log": "critical"};
    const incidents = raw.incidents.filter(item => item && typeof item === 'object' && ids.has(item.source) &&
        typeof item.code === 'string' &&
        /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(item.code) &&
        typeof item.message === 'string' && (item.active === true || item.active === 1) &&
        ['blocker', 'critical'].includes(item.severity ?? severities[item.code])).map(item => ({
        ...item, severity: item.severity ?? severities[item.code] ?? 'warning', active: true, acknowledged: Boolean(item.acknowledged),
        message: item.message.slice(0, 300), detail: String(item.detail ?? '').slice(0, 1500),
    }));
    const lastScan = Date.parse(raw.last_scan_at ?? '');
    return {sources, incidents, updatedAt: String(raw.last_scan_at ?? ''),
        stale: !raw.boot_id || raw.last_scan_boot_id !== raw.boot_id ||
            !Number.isFinite(lastScan) || Date.now() - lastScan > 15 * 60 * 1000,
        scanning: raw.scanning === true, scanError: String(raw.scan_error ?? '').slice(0, 500),
        incomplete: raw.verification_incomplete === true,
        unread: incidents.filter(item => !item.acknowledged).length,
        total: incidents.length};
}

function safeGcName(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return cleaned ? cleaned.slice(0, 160) : fallback;
}

function gcTimestamp(value) {
    return value === null ? null : typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? value : null;
}

function normalizeGcProfiles(raw, now = Date.now()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
        raw.schema_version !== 1 || typeof raw.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(raw.updated_at)) ||
        raw.daemon === null || typeof raw.daemon !== 'object' || Array.isArray(raw.daemon) ||
        !['running', 'stopped'].includes(raw.daemon.state) ||
        !Number.isInteger(raw.daemon.pid) || raw.daemon.pid < 0 ||
        !Array.isArray(raw.profiles))
        throw new Error('Некоректний звіт GC-профілів.');
    const age = now - Date.parse(raw.updated_at);
    const stale = age > GC_STALE_AFTER_MS || age < -GC_FUTURE_TOLERANCE_MS;
    const daemonAvailable = raw.daemon.state === 'running' && !stale;
    const profiles = raw.profiles.slice(0, GC_MAX_PROFILES).map((item, index) => {
        const fallback = `Профіль ${index + 1}`;
        if (item === null || typeof item !== 'object' || Array.isArray(item) ||
            typeof item.name !== 'string' || !item.name.trim() ||
            typeof item.enabled !== 'boolean' || !GC_STATES.has(item.state) ||
            typeof item.message !== 'string') {
            return {name: fallback, enabled: true, state: 'failed', invalid: true,
                lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null,
                lastFailureAt: null, nextRunAt: null, message: 'Некоректний запис профілю.'};
        }
        const timestampFields = ['last_started_at', 'last_finished_at', 'last_success_at',
            'last_failure_at', 'next_run_at'];
        const invalidTimestamp = timestampFields.some(field =>
            item[field] !== null && gcTimestamp(item[field]) === null);
        return {
            name: safeGcName(item.name, fallback), enabled: item.enabled, state: invalidTimestamp
                ? 'failed' : item.state, invalid: invalidTimestamp,
            lastStartedAt: gcTimestamp(item.last_started_at),
            lastFinishedAt: gcTimestamp(item.last_finished_at),
            lastSuccessAt: gcTimestamp(item.last_success_at),
            lastFailureAt: gcTimestamp(item.last_failure_at),
            nextRunAt: gcTimestamp(item.next_run_at),
            message: invalidTimestamp ? 'Некоректний час у записі профілю.' : safeGcName(item.message, ''),
        };
    });
    return {updatedAt: raw.updated_at, daemon: {...raw.daemon}, profiles, stale,
        truncated: raw.profiles.length > GC_MAX_PROFILES, daemonAvailable, error: ''};
}

function gcProfilePresentation(profile, daemonAvailable = true) {
    const successTime = profile.lastSuccessAt ||
        (profile.state === 'ok' ? profile.lastFinishedAt : null);
    if (!daemonAvailable) {
        const failure = profile.lastFailureAt;
        return {icon: 'dialog-warning-symbolic', style: 'failed', label: 'Недоступний',
            timeLabel: failure ? 'Остання помилка' : successTime ? 'Останнє очищення' : '',
            time: failure || successTime};
    }
    if (profile.invalid || profile.state === 'failed')
        return {icon: 'dialog-warning-symbolic', style: 'failed', label: 'Помилка',
            timeLabel: profile.lastFailureAt ? 'Остання помилка' : successTime ? 'Останнє очищення' : '',
            time: profile.lastFailureAt || successTime};
    if (profile.state === 'ok')
        return {icon: 'object-select-symbolic', style: 'ok', label: 'OK',
            timeLabel: successTime ? 'Останнє очищення' : '', time: successTime};
    if (profile.state === 'disabled')
        return {icon: 'media-playback-stop-symbolic', style: 'disabled', label: 'Вимкнено',
            timeLabel: successTime ? 'Останнє очищення' : '', time: successTime};
    if (profile.state === 'running')
        return {icon: 'process-working-symbolic', style: 'running', label: 'Виконується',
            timeLabel: successTime ? 'Останнє очищення' : '', time: successTime};
    return {icon: 'content-loading-symbolic', style: 'pending', label: 'Очікує',
        timeLabel: successTime ? 'Останнє очищення' : '', time: successTime};
}

function gcEventTime(value) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        return '--';
    return new Date(parsed).toLocaleString([], {dateStyle: 'medium', timeStyle: 'medium'});
}

function hudBounds(workArea, scaleFactor) {
    const scale = Math.max(1, scaleFactor);
    return {
        width: Math.max(1, Math.min(900, Math.floor(workArea.width / scale) - 48)),
        height: Math.max(1, Math.floor(workArea.height / scale) - 48),
    };
}


export {
    STATUS_DIRECTORY, STATUS_FILENAME, ALERTS_FILENAME, GC_STATUS_FILENAME,
    DISMISSED_FILENAME, CANCEL_FILENAME, REQUEST_FILENAME, RENDERED_FILENAME,
    COMMIT_FILENAME, PREPARED_FILENAME, SESSION_MANAGER_NAME,
    SHUTDOWN_COORDINATOR_UNIT, DBUS_NAME, DBUS_PATH, DBUS_INTERFACE, SYSTEMD_NAME,
    SYSTEMD_PATH, SYSTEMD_MANAGER_INTERFACE, SYSTEMD_UNIT_INTERFACE,
    PROPERTIES_INTERFACE, STATES, TERMINAL_STATES, MODES, SHUTDOWN_ACTIONS,
    SHUTDOWN_ORIGINS, SHUTDOWN_COUNTDOWN_SECONDS, PREFLIGHT_STATUS_TIMEOUT_MS,
    PREPARED_POLL_TIMEOUT_MS, STALE_STARTUP_PRESENTATION_MS, GC_STALE_AFTER_MS,
    GC_FUTURE_TOLERANCE_MS, GC_MAX_STATUS_BYTES, GC_MAX_PROFILES, GC_STATES,
    text, fraction, stageProgress, aggregateState, groupStages,
    shutdownRecoveryPending, operationContext, sameOperationContext, gcViewKey,
    normaliseStatus, elapsedSince, displayState, eventTime, stateIcon,
    overallFraction, normalizeAlerts, safeGcName, gcTimestamp,
    normalizeGcProfiles, gcProfilePresentation, gcEventTime, hudBounds,
};
