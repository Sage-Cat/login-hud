/* exported default */
/* global console TextEncoder */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import {State as ModalDialogState} from 'resource:///org/gnome/shell/ui/modalDialog.js';

const STATUS_DIRECTORY = 'workspace-state';
const STATUS_FILENAME = 'login-hud-status.json';
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
const SHUTDOWN_COUNTDOWN_SECONDS = 3;
const PREFLIGHT_STATUS_TIMEOUT_MS = 15000;
const PREPARED_POLL_TIMEOUT_MS = 15000;
const STALE_STARTUP_PRESENTATION_MS = 5 * 60 * 1000;

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

const LoginHud = GObject.registerClass(
class LoginHud extends St.Widget {
    _init() {
        super._init({
            style_class: 'login-hud-overlay',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        this._status = null;
        this._transportNotice = '';
        this._onCloseRequested = null;
        this._onOpenLogRequested = null;
        this._onCancelRequested = null;
        this._cancelPending = false;
        this._primaryAction = null;
        this._expandedJobs = new Set();
        this._overallProgressFillId = 0;
        this._shutdownCountdown = null;
        this._handoffStarted = false;

        this._panel = new St.BoxLayout({
            style_class: 'login-hud-panel',
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: 650,
        });
        this.add_child(this._panel);

        this._kicker = new St.Label({
            style_class: 'login-hud-kicker',
            text: 'SESSION / STARTUP TELEMETRY',
        });
        this._title = new St.Label({
            style_class: 'login-hud-title',
            text: 'Restoring workspace',
        });
        this._elapsed = new St.Label({
            style_class: 'login-hud-elapsed',
            text: 'Elapsed —',
        });
        this._overall = new St.Label({
            style_class: 'login-hud-overall',
            text: 'Waiting for session status…',
        });
        this._overallProgressLabel = new St.Label({
            style_class: 'login-hud-overall-progress-label',
            text: 'Overall progress 0%',
        });
        this._overallProgressTrack = new St.Widget({
            style_class: 'login-hud-overall-progress-track',
            x_expand: true,
            height: 7,
            layout_manager: new Clutter.BinLayout(),
        });
        this._overallProgressFill = new St.Widget({
            style_class: 'login-hud-overall-progress-fill',
            x_align: Clutter.ActorAlign.START,
            y_expand: true,
        });
        this._overallProgressTrack.add_child(this._overallProgressFill);
        this._overallProgressTrack.connect('notify::width', () => this._updateOverallProgressFill());
        this._notice = new St.Label({
            style_class: 'login-hud-notice',
            visible: false,
        });
        this._rows = new St.BoxLayout({
            style_class: 'login-hud-rows',
            vertical: true,
        });
        this._rowsScroll = new St.ScrollView({
            style_class: 'login-hud-rows-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            enable_mouse_scrolling: true,
            x_expand: true,
        });
        this._rowsScroll.add_child(this._rows);
        this._actions = new St.BoxLayout({
            style_class: 'login-hud-actions',
            x_align: Clutter.ActorAlign.END,
        });

        this._panel.add_child(this._kicker);
        this._panel.add_child(this._title);
        this._panel.add_child(this._elapsed);
        this._panel.add_child(this._overall);
        this._panel.add_child(this._overallProgressLabel);
        this._panel.add_child(this._overallProgressTrack);
        this._panel.add_child(this._notice);
        this._panel.add_child(this._rowsScroll);
        this._panel.add_child(this._actions);
    }

    setCallbacks(onCloseRequested, onOpenLogRequested, onCancelRequested) {
        this._onCloseRequested = onCloseRequested;
        this._onOpenLogRequested = onOpenLogRequested;
        this._onCancelRequested = onCancelRequested;
    }

    setStatus(status) {
        this._status = status;
        this._transportNotice = '';
        this._shutdownCountdown = null;
        this._handoffStarted = false;
        if (status.cancelled)
            this._cancelPending = false;
        const isShutdown = status.mode === 'shutdown';
        this._kicker.text = isShutdown
            ? 'SYSTEM / SHUTDOWN TELEMETRY'
            : 'SESSION / STARTUP TELEMETRY';
        this._title.text = status.overallState === 'failed'
            ? isShutdown ? 'System shutdown needs attention' : 'Session startup needs attention'
            : status.overallState === 'degraded'
                ? isShutdown
                    ? 'System shutdown ready with safe fallbacks'
                    : 'Session systems ready with safe fallbacks'
            : TERMINAL_STATES.has(status.overallState)
                ? isShutdown ? 'System shutdown complete' : 'Session systems ready'
                : isShutdown ? 'Deinitializing system' : 'Restoring workspace';
        this._overall.text = isShutdown
            ? `System shutdown: ${status.overallMessage}`
            : status.overallMessage;
        this._overallProgress = overallFraction(status.stages);
        this._overallProgressLabel.text = `Overall progress ${Math.round(this._overallProgress * 100)}%`;
        this.scheduleProgressFill();
        this._renderRows(status.stages);
        this._renderActions(status);
        this._refreshElapsed();
        this._renderNotice();
    }

    setTransportNotice(message) {
        this._transportNotice = message;
        this._renderNotice();
    }

    setCancellationPending(pending) {
        this._cancelPending = pending;
        if (this._status)
            this._renderActions(this._status);
    }

    setShutdownCountdown(action, seconds) {
        this._shutdownCountdown = {action, seconds};
        const verb = action === 'restart'
            ? 'Restarting'
            : action === 'poweroff' ? 'Powering off' : 'Completing shutdown';
        this._title.text = action === 'restart'
            ? 'Ready to restart'
            : action === 'poweroff' ? 'Ready to power off' : 'Ready for shutdown';
        this._overall.text = `${verb} in ${seconds}…`;
        if (this._status)
            this._renderActions(this._status);
    }

    setHandoffStarted(action) {
        this._shutdownCountdown = null;
        this._handoffStarted = true;
        this._overall.text = action === 'restart'
            ? 'Handing control to GNOME for restart…'
            : action === 'poweroff'
                ? 'Handing control to GNOME for power off…'
                : 'Handing control back to GNOME…';
        if (this._status)
            this._renderActions(this._status);
    }

    setAwaitingPrepared(action) {
        this._shutdownCountdown = null;
        this._title.text = action === 'restart' ? 'Ready to restart' : 'Ready to power off';
        this._overall.text = 'Preparation complete · verifying final safety marker…';
        if (this._status)
            this._renderActions(this._status);
    }

    resetExpansion() {
        this._expandedJobs.clear();
    }

    getInteractiveActor() {
        return this._panel;
    }

    focusPrimaryAction() {
        this._primaryAction?.grab_key_focus();
    }

    reportLogLaunchFailure(message) {
        this._transportNotice = `Could not open error log: ${message}`;
        this._renderNotice();
    }

    refreshClock() {
        this._refreshElapsed();
    }

    scheduleProgressFill() {
        if (this._overallProgressFillId)
            return;
        this._overallProgressFillId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._overallProgressFillId = 0;
            this._updateOverallProgressFill();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelDeferredUpdates() {
        if (this._overallProgressFillId)
            GLib.Source.remove(this._overallProgressFillId);
        this._overallProgressFillId = 0;
    }

    _refreshElapsed() {
        this._elapsed.text = this._status ? elapsedSince(this._status.startedAt) : 'Elapsed —';
    }

    _updateOverallProgressFill() {
        if (!this._overallProgressTrack.get_stage() || !this._overallProgressTrack.mapped)
            return;
        const width = this._overallProgressTrack.width;
        this._overallProgressFill.set_width(Math.round(width * (this._overallProgress ?? 0)));
    }

    _renderNotice() {
        this._notice.text = this._transportNotice;
        this._notice.visible = Boolean(this._transportNotice);
    }

    _renderRows(stages) {
        this._rows.destroy_all_children();
        if (stages.length === 0) {
            this._rows.add_child(new St.Label({
                style_class: 'login-hud-empty',
                text: this._status?.mode === 'shutdown'
                    ? 'No shutdown stages have been published yet.'
                    : 'No startup stages have been published yet.',
            }));
            return;
        }

        for (const stage of stages)
            this._rows.add_child(this._makeStageRow(stage));
    }

    _makeStageRow(stage) {
        const row = new St.BoxLayout({
            style_class: `login-hud-row login-hud-row-${stage.state}`,
            vertical: true,
        });
        const expanded = this._expandedJobs.has(stage.id);
        const headingContent = new St.BoxLayout({style_class: 'login-hud-row-heading'});
        const expander = new St.Icon({
            style_class: 'login-hud-row-expander',
            icon_name: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
            icon_size: 12,
        });
        const icon = new St.Icon({
            style_class: 'login-hud-row-icon',
            icon_name: stateIcon(stage.state),
            icon_size: 16,
        });
        const name = new St.Label({
            style_class: 'login-hud-row-name',
            text: stage.name,
            x_expand: true,
        });
        const status = new St.Label({
            style_class: 'login-hud-row-state',
            text: displayState(stage.state),
        });
        headingContent.add_child(expander);
        headingContent.add_child(icon);
        headingContent.add_child(name);
        headingContent.add_child(status);
        const heading = new St.Button({
            style_class: 'login-hud-row-heading-button',
            child: headingContent,
            reactive: true,
            can_focus: true,
            x_expand: true,
            accessible_name: `${expanded ? 'Collapse' : 'Expand'} ${stage.name}`,
        });
        heading.connect('clicked', () => {
            if (this._expandedJobs.has(stage.id))
                this._expandedJobs.delete(stage.id);
            else
                this._expandedJobs.add(stage.id);
            if (this._status)
                this._renderRows(this._status.stages);
        });
        row.add_child(heading);

        if (stage.message) {
            row.add_child(new St.Label({
                style_class: 'login-hud-row-message',
                text: stage.message,
            }));
        }

        if (stage.fraction !== null) {
            const track = new St.Widget({
                style_class: 'login-hud-progress-track',
                x_expand: true,
                height: 5,
                layout_manager: new Clutter.BinLayout(),
            });
            const fill = new St.Widget({
                style_class: 'login-hud-progress-fill',
                x_align: Clutter.ActorAlign.START,
                y_expand: true,
            });
            const updateFill = () => {
                if (!track.get_stage() || !track.mapped)
                    return;
                fill.set_width(Math.round(track.width * stage.fraction));
            };
            track.add_child(fill);
            track.connect('notify::width', updateFill);
            track.connect('notify::mapped', updateFill);
            row.add_child(track);
        } else if (!TERMINAL_STATES.has(stage.state)) {
            const indeterminate = new St.BoxLayout({style_class: 'login-hud-indeterminate'});
            const spinner = new Spinner(14, {animate: true});
            spinner.add_style_class_name('login-hud-spinner');
            spinner.play();
            indeterminate.add_child(spinner);
            indeterminate.add_child(new St.Label({
                style_class: 'login-hud-indeterminate-label',
                text: 'In progress',
            }));
            row.add_child(indeterminate);
        }

        if (expanded)
            row.add_child(this._makeJobDetails(stage));

        return row;
    }

    _makeJobDetails(stage) {
        const details = new St.BoxLayout({
            style_class: 'login-hud-job-details',
            vertical: true,
        });
        if (stage.children.length > 0) {
            details.add_child(new St.Label({
                style_class: 'login-hud-detail-heading',
                text: 'INTERNAL STEPS',
            }));
            for (const child of stage.children) {
                const substep = new St.BoxLayout({style_class: 'login-hud-substep'});
                substep.add_child(new St.Icon({
                    style_class: 'login-hud-substep-icon',
                    icon_name: stateIcon(child.state),
                    icon_size: 13,
                }));
                substep.add_child(new St.Label({
                    style_class: 'login-hud-substep-name',
                    text: child.name,
                    x_expand: true,
                }));
                substep.add_child(new St.Label({
                    style_class: 'login-hud-substep-state',
                    text: displayState(child.state),
                }));
                details.add_child(substep);
                details.add_child(new St.Label({
                    style_class: 'login-hud-substep-message',
                    text: child.message,
                }));
            }
        }

        details.add_child(new St.Label({
            style_class: 'login-hud-detail-heading',
            text: 'ACTIVITY LOG',
        }));
        if (stage.events.length === 0) {
            details.add_child(new St.Label({
                style_class: 'login-hud-log-empty',
                text: 'No activity has been reported yet.',
            }));
            return details;
        }
        for (const event of stage.events) {
            const source = event.source ? `${event.source} · ` : '';
            details.add_child(new St.Label({
                style_class: `login-hud-log-line login-hud-log-${event.state}`,
                text: `${eventTime(event.at)}  ${source}${displayState(event.state)} — ${event.message}`,
            }));
        }
        return details;
    }

    _renderActions(status) {
        this._actions.destroy_all_children();
        this._primaryAction = null;
        const hasFailure = status.overallState === 'failed' || status.stages.some(stage => stage.state === 'failed');
        const allTerminal = status.stages.length > 0 && status.stages.every(stage => TERMINAL_STATES.has(stage.state));

        if (hasFailure) {
            const button = new St.Button({
                style_class: 'login-hud-button',
                label: 'Show full error log',
                can_focus: true,
                reactive: true,
            });
            button.connect('clicked', () => this._onOpenLogRequested?.(status.errorLogPath));
            this._actions.add_child(button);
            this._primaryAction = button;
            if (status.mode === 'shutdown') {
                this._actions.add_child(new St.Label({
                    style_class: 'login-hud-action-status',
                    text: 'Shutdown stopped · review the error and retry power off',
                }));
            } else {
                this._addCloseButton('Close');
            }
        } else if (status.mode === 'shutdown' && this._handoffStarted) {
            this._actions.add_child(new St.Label({
                style_class: 'login-hud-action-status',
                text: 'Shutdown handoff in progress',
            }));
        } else if (status.mode === 'shutdown' && !status.cancelled) {
            const button = new St.Button({
                style_class: 'login-hud-button login-hud-button-cancel',
                label: this._cancelPending
                    ? 'Cancelling safely…'
                    : this._shutdownCountdown
                        ? `Cancel (${this._shutdownCountdown.seconds}s)`
                        : 'Cancel shutdown',
                can_focus: true,
                reactive: !this._cancelPending,
            });
            button.connect('clicked', () => this._onCancelRequested?.(status));
            this._actions.add_child(button);
            this._primaryAction = button;
        } else if (status.mode === 'shutdown' && status.cancelled) {
            this._addCloseButton(allTerminal ? 'Close' : 'Hide (recovery continues)');
        } else if (allTerminal && status.mode !== 'shutdown') {
            this._addCloseButton('OK', true);
        }
    }

    _addCloseButton(label, primary = false) {
        const button = new St.Button({
            style_class: `login-hud-button${primary ? ' login-hud-button-primary' : ''}`,
            label,
            can_focus: true,
            reactive: true,
        });
        button.connect('clicked', () => this._onCloseRequested?.());
        this._actions.add_child(button);
        if (!this._primaryAction)
            this._primaryAction = button;
    }
});

export default class LoginHudExtension extends Extension {
    enable() {
        // One session may retain the old UUID's JavaScript module in memory
        // after an in-place update on Wayland. Keep that UUID as a passive
        // migration alias on future logins; the v2 UUID owns all HUD work.
        if (this.uuid === 'login-hud@sagecat.local') {
            this._legacyPassive = true;
            return;
        }
        const runtimeDirectory = GLib.get_user_runtime_dir();
        this._statusDirectory = Gio.File.new_for_path(GLib.build_filenamev([
            runtimeDirectory, STATUS_DIRECTORY,
        ]));
        this._statusFile = this._statusDirectory.get_child(STATUS_FILENAME);
        this._dismissedFile = this._statusDirectory.get_child(DISMISSED_FILENAME);
        this._cancelFile = this._statusDirectory.get_child(CANCEL_FILENAME);
        this._requestFile = this._statusDirectory.get_child(REQUEST_FILENAME);
        this._renderedFile = this._statusDirectory.get_child(RENDERED_FILENAME);
        this._commitFile = this._statusDirectory.get_child(COMMIT_FILENAME);
        this._preparedFile = this._statusDirectory.get_child(PREPARED_FILENAME);
        this._loadSerial = 0;
        this._reloadTimeout = 0;
        this._clockId = 0;
        this._shutdownCountdownId = 0;
        this._shutdownCountdownOperationId = null;
        this._shutdownCountdownSeconds = 0;
        this._renderAckScheduledOperationId = null;
        this._renderAckWrittenOperationId = null;
        this._commitWrittenOperationId = null;
        this._preparedCheckPending = false;
        this._preparedPollId = 0;
        this._nativeHandoffOperationId = null;
        this._preflightOperationId = null;
        this._preflightAction = null;
        this._preflightSignal = null;
        this._preflightStarting = false;
        this._preflightWatchdogId = 0;
        this._endSessionDialog = null;
        this._originalEndSessionConfirm = null;
        this._wrappedEndSessionConfirm = null;
        this._originalBootOptionsConfirm = null;
        this._wrappedBootOptionsConfirm = null;
        this._confirmBypass = false;
        this._lastGoodStatus = null;
        this._dismissed = false;
        this._activeSessionId = null;
        this._activeMode = null;
        this._activeOperationId = null;
        this._activeStartedAt = null;
        this._modalGrab = null;
        this._cancelRequestPending = false;
        this._nativeCancelledOperationId = null;
        this._locallyCancelledOperationId = null;
        this._chromeInstalled = false;
        this._panelChromeTracked = false;
        this._currentSessionId = null;
        this._sessionIdResolvePending = false;
        this._sessionIdRetryId = 0;

        try {
            GLib.mkdir_with_parents(this._statusDirectory.get_path(), 0o700);
        } catch (error) {
            // Monitoring/loading below remains fail-open and reports the issue.
            console.warn(`Login HUD could not create its runtime directory: ${error.message}`);
        }

        this._hud = new LoginHud();
        this._hud.setCallbacks(
            () => this._dismissHud(),
            path => this._openErrorLog(path),
            status => this._requestCancel(status)
        );
        this._hud.visible = false;
        this._hudKeyPressId = this._hud.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            const status = this._lastGoodStatus;
            const hasFailure = status?.overallState === 'failed' ||
                status?.stages.some(stage => stage.state === 'failed');
            if (status?.mode === 'shutdown' && !status.cancelled && !hasFailure) {
                this._requestCancel(status);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
            this._syncVisibility();
        });

        try {
            this._monitor = this._statusDirectory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorChangedId = this._monitor.connect('changed', (_monitor, file, otherFile) => {
                const names = new Set([file?.get_basename(), otherFile?.get_basename()]);
                if (names.has(STATUS_FILENAME))
                    this._scheduleLoad();
                if (names.has(PREPARED_FILENAME))
                    this._checkPreparedHandoff();
            });
        } catch (error) {
            this._hud.setTransportNotice(`Status directory is not available yet: ${error.message}`);
        }

        this._resolveCurrentSessionId();
        this._installEndSessionInterceptor();
    }

    disable() {
        if (this._legacyPassive) {
            this._legacyPassive = false;
            return;
        }
        if (this._reloadTimeout)
            GLib.Source.remove(this._reloadTimeout);
        if (this._sessionIdRetryId)
            GLib.Source.remove(this._sessionIdRetryId);
        if (this._preflightWatchdogId)
            GLib.Source.remove(this._preflightWatchdogId);
        this._stopPreparedPolling();
        this._cancelShutdownCountdown();
        this._abortActivePreflightOnDisable();
        this._restoreEndSessionInterceptor();
        if (this._clockId)
            GLib.Source.remove(this._clockId);
        if (this._monitorChangedId)
            this._monitor?.disconnect(this._monitorChangedId);
        this._monitor?.cancel();
        if (this._stageSizeChangedId)
            global.stage.disconnect(this._stageSizeChangedId);
        if (this._stageHeightChangedId)
            global.stage.disconnect(this._stageHeightChangedId);
        if (this._sessionModeUpdatedId)
            Main.sessionMode.disconnect(this._sessionModeUpdatedId);
        this._releaseModal();
        if (this._hud) {
            this._hud.cancelDeferredUpdates();
            if (this._hudKeyPressId)
                this._hud.disconnect(this._hudKeyPressId);
            if (this._panelChromeTracked)
                Main.layoutManager.untrackChrome(this._hud.getInteractiveActor());
            if (this._chromeInstalled)
                Main.layoutManager.removeChrome(this._hud);
            this._hud.destroy();
        }

        this._reloadTimeout = 0;
        this._sessionIdRetryId = 0;
        this._shutdownCountdownId = 0;
        this._clockId = 0;
        this._monitorChangedId = 0;
        this._sessionModeUpdatedId = 0;
        this._hudKeyPressId = 0;
        this._monitor = null;
        this._hud = null;
        this._chromeInstalled = false;
        this._panelChromeTracked = false;
        this._currentSessionId = null;
        this._sessionIdResolvePending = false;
        this._statusFile = null;
        this._dismissedFile = null;
        this._cancelFile = null;
        this._requestFile = null;
        this._renderedFile = null;
        this._commitFile = null;
        this._preparedFile = null;
        this._statusDirectory = null;
        this._activeSessionId = null;
        this._activeMode = null;
        this._activeOperationId = null;
        this._activeStartedAt = null;
        this._modalGrab = null;
        this._cancelRequestPending = false;
        this._nativeCancelledOperationId = null;
        this._locallyCancelledOperationId = null;
        this._shutdownCountdownOperationId = null;
        this._shutdownCountdownSeconds = 0;
        this._renderAckScheduledOperationId = null;
        this._renderAckWrittenOperationId = null;
        this._commitWrittenOperationId = null;
        this._preparedCheckPending = false;
        this._preparedPollId = 0;
        this._nativeHandoffOperationId = null;
        this._preflightOperationId = null;
        this._preflightAction = null;
        this._preflightSignal = null;
        this._preflightStarting = false;
        this._preflightWatchdogId = 0;
        this._endSessionDialog = null;
        this._originalEndSessionConfirm = null;
        this._wrappedEndSessionConfirm = null;
        this._originalBootOptionsConfirm = null;
        this._wrappedBootOptionsConfirm = null;
        this._confirmBypass = false;
    }

    _installEndSessionInterceptor() {
        const dialog = Main.endSessionDialog;
        if (!dialog || typeof dialog._confirm !== 'function') {
            console.warn('Login HUD cannot install the GNOME end-session preflight interceptor.');
            return;
        }

        this._endSessionDialog = dialog;
        this._originalEndSessionConfirm = dialog._confirm;
        this._wrappedEndSessionConfirm = async signal => {
            if (this._confirmBypass)
                return this._originalEndSessionConfirm.call(dialog, signal);
            return this._interceptEndSessionConfirm(signal);
        };
        dialog._confirm = this._wrappedEndSessionConfirm;

        // "Boot Options" mutates logind state before calling _confirm(). It
        // cannot be safely cancellable once that mutation has happened, so it
        // retains GNOME's native path and is deliberately outside preflight.
        if (typeof dialog._confirmRebootToBootLoaderMenu === 'function') {
            this._originalBootOptionsConfirm = dialog._confirmRebootToBootLoaderMenu;
            this._wrappedBootOptionsConfirm = (...args) => {
                this._confirmBypass = true;
                try {
                    return this._originalBootOptionsConfirm.call(dialog, ...args);
                } finally {
                    this._confirmBypass = false;
                }
            };
            dialog._confirmRebootToBootLoaderMenu = this._wrappedBootOptionsConfirm;
        }
    }

    _restoreEndSessionInterceptor() {
        if (
            this._endSessionDialog &&
            this._endSessionDialog._confirm === this._wrappedEndSessionConfirm
        )
            this._endSessionDialog._confirm = this._originalEndSessionConfirm;
        if (
            this._endSessionDialog &&
            this._endSessionDialog._confirmRebootToBootLoaderMenu ===
                this._wrappedBootOptionsConfirm
        )
            this._endSessionDialog._confirmRebootToBootLoaderMenu =
                this._originalBootOptionsConfirm;
    }

    _readProtocolFileSync(file) {
        try {
            const [loaded, bytes] = file.load_contents(null);
            if (!loaded)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (_error) {
            return null;
        }
    }

    _resolveCurrentSessionIdSync() {
        if (this._currentSessionId)
            return this._currentSessionId;
        try {
            const result = Gio.DBus.session.call_sync(
                DBUS_NAME,
                DBUS_PATH,
                DBUS_INTERFACE,
                'GetNameOwner',
                new GLib.Variant('(s)', [SESSION_MANAGER_NAME]),
                new GLib.VariantType('(s)'),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );
            const [owner] = result.deepUnpack();
            this._currentSessionId = GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256,
                String(owner),
                -1
            ).slice(0, 16);
        } catch (error) {
            console.warn(`Login HUD could not identify the session for shutdown: ${error.message}`);
        }
        return this._currentSessionId;
    }

    _writeProtocolFile(destination, temporaryPrefix, payload) {
        const temporary = this._statusDirectory.get_child(
            `.${temporaryPrefix}.${GLib.uuid_string_random()}`
        );
        try {
            temporary.replace_contents(
                new TextEncoder().encode(JSON.stringify(payload)),
                null,
                false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            temporary.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (error) {
            try {
                temporary.delete(null);
            } catch (_cleanupError) {
                // Runtime files disappear with the user session.
            }
            throw error;
        }
    }

    _closeNativeDialogBeforePreflight() {
        const dialog = this._endSessionDialog;
        dialog._stopTimer?.();
        dialog._stopAltCapture?.();
        if (dialog.state === ModalDialogState.CLOSED)
            return Promise.resolve();

        return new Promise((resolve, reject) => {
            let closedId = 0;
            let timeoutId = 0;
            let settled = false;
            const finish = error => {
                if (settled)
                    return;
                settled = true;
                if (closedId) {
                    dialog.disconnect(closedId);
                    closedId = 0;
                }
                if (timeoutId) {
                    GLib.Source.remove(timeoutId);
                    timeoutId = 0;
                }
                if (error)
                    reject(error);
                else
                    resolve();
            };
            closedId = dialog.connect('closed', () => finish());
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                timeoutId = 0;
                if (dialog.state === ModalDialogState.CLOSED)
                    finish();
                else
                    finish(new Error('the native GNOME confirmation did not close'));
                return GLib.SOURCE_REMOVE;
            });
            dialog.close(true);
            if (dialog.state === ModalDialogState.CLOSED)
                finish();
        });
    }

    async _interceptEndSessionConfirm(signal) {
        const action = signal === 'ConfirmedShutdown'
            ? 'poweroff'
            : signal === 'ConfirmedReboot' ? 'restart' : null;
        if (!action)
            return this._originalEndSessionConfirm.call(this._endSessionDialog, signal);

        // The extension is safe to install on its own. If the companion
        // coordinator is missing or inactive, preserve GNOME's native action
        // instead of retaining it for a preflight that cannot complete.
        if (!this._shutdownCoordinatorIsActive()) {
            console.warn(
                'Login HUD shutdown coordinator is unavailable; using GNOME native shutdown.'
            );
            return this._originalEndSessionConfirm.call(this._endSessionDialog, signal);
        }

        // GNOME may show a second "Power Off Anyway" dialog after another
        // application adds a JIT inhibitor. That confirmation continues the
        // already prepared operation and must never start a second preflight.
        if (this._nativeHandoffOperationId)
            return this._originalEndSessionConfirm.call(this._endSessionDialog, signal);

        if (this._preflightStarting ||
            (this._preflightOperationId && !this._nativeHandoffOperationId))
            return;

        this._preflightStarting = true;
        const sessionId = this._resolveCurrentSessionIdSync();
        const operationId = GLib.uuid_string_random().replaceAll('-', '');
        try {
            if (!sessionId)
                throw new Error('the current GNOME session could not be identified');
            // The normal button path calls _confirm from the dialog's closed
            // signal. The automatic timer calls it while the dialog is still
            // open, so wait for that modal to be fully gone before publishing
            // any request that can make the HUD visible.
            await this._closeNativeDialogBeforePreflight();
            this._writeProtocolFile(this._requestFile, 'shutdown-request', {
                schema_version: 1,
                operation_id: operationId,
                session_id: sessionId,
                action,
                requested_at: new Date().toISOString(),
            });
            this._preflightOperationId = operationId;
            this._preflightAction = action;
            this._preflightSignal = signal;
            this._startPreflightWatchdog(operationId, sessionId);
            this._nativeHandoffOperationId = null;
            this._renderAckScheduledOperationId = null;
            this._renderAckWrittenOperationId = null;
            this._commitWrittenOperationId = null;
            this._cancelShutdownCountdown();
        } catch (error) {
            console.error(`Login HUD could not start shutdown preflight: ${error.message}`);
            if (this._preflightOperationId === operationId) {
                try {
                    this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                        schema_version: 1,
                        operation_id: operationId,
                        session_id: sessionId,
                        requested_at: new Date().toISOString(),
                    });
                } catch (cancelError) {
                    console.warn(`Login HUD could not cancel backend work: ${cancelError.message}`);
                }
                this._locallyCancelledOperationId = operationId;
                if (this._preflightWatchdogId)
                    GLib.Source.remove(this._preflightWatchdogId);
                this._preflightWatchdogId = 0;
                this._preflightOperationId = null;
                this._preflightAction = null;
                this._preflightSignal = null;
            }
            Main.notifyError(
                'Shutdown cancelled safely',
                `The shutdown HUD could not start: ${error.message}`
            );
            // The SessionManager already has an open DBus request. Explicitly
            // cancel it on startup failure so GNOME does not remain wedged.
            this._cancelNativeEndSessionOnce(operationId);
        } finally {
            this._preflightStarting = false;
        }
    }

    _shutdownCoordinatorIsActive() {
        try {
            const unitResult = Gio.DBus.session.call_sync(
                SYSTEMD_NAME,
                SYSTEMD_PATH,
                SYSTEMD_MANAGER_INTERFACE,
                'GetUnit',
                new GLib.Variant('(s)', [SHUTDOWN_COORDINATOR_UNIT]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );
            const [unitPath] = unitResult.deepUnpack();
            const stateResult = Gio.DBus.session.call_sync(
                SYSTEMD_NAME,
                unitPath,
                PROPERTIES_INTERFACE,
                'Get',
                new GLib.Variant('(ss)', [SYSTEMD_UNIT_INTERFACE, 'ActiveState']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );
            const [activeState] = stateResult.recursiveUnpack();
            return activeState === 'active';
        } catch (error) {
            console.warn(`Login HUD could not verify shutdown coordinator: ${error.message}`);
            return false;
        }
    }

    _startPreflightWatchdog(operationId, sessionId) {
        if (this._preflightWatchdogId)
            GLib.Source.remove(this._preflightWatchdogId);
        this._preflightWatchdogId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PREFLIGHT_STATUS_TIMEOUT_MS,
            () => {
                this._preflightWatchdogId = 0;
                if (!this._hud || this._preflightOperationId !== operationId ||
                    this._activeOperationId === operationId)
                    return GLib.SOURCE_REMOVE;
                try {
                    this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                        schema_version: 1,
                        operation_id: operationId,
                        session_id: sessionId,
                        requested_at: new Date().toISOString(),
                    });
                } catch (error) {
                    console.warn(`Login HUD preflight timeout cleanup failed: ${error.message}`);
                }
                this._locallyCancelledOperationId = operationId;
                this._cancelNativeEndSessionOnce(operationId);
                this._preflightOperationId = null;
                this._preflightAction = null;
                this._preflightSignal = null;
                Main.notifyError(
                    'Shutdown cancelled safely',
                    'The shutdown coordinator did not publish HUD status in time.'
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _syncHudSize() {
        this._hud?.set_size(global.stage.width, global.stage.height);
    }

    _startupCanAutoDismiss(status) {
        if (status?.mode !== 'startup')
            return false;
        const hasFailure = status.overallState === 'failed' ||
            status.stages.some(stage => stage.state === 'failed');
        return !hasFailure && status.stages.length > 0 &&
            status.stages.every(stage => TERMINAL_STATES.has(stage.state));
    }

    _startupDismissalMatches(status) {
        if (status?.mode !== 'startup' || !this._dismissedFile)
            return false;
        const dismissal = this._readProtocolFileSync(this._dismissedFile);
        return dismissal?.schema_version === 1 &&
            dismissal.session_id === status.sessionId &&
            dismissal.started_at === status.startedAt;
    }

    _startupPresentationIsStale(status) {
        if (!this._startupCanAutoDismiss(status))
            return false;
        const updatedAt = Date.parse(status.updatedAt);
        return Number.isFinite(updatedAt) && Date.now() - updatedAt >=
            STALE_STARTUP_PRESENTATION_MS;
    }

    _recordStartupDismissal(status, reason) {
        if (status?.mode !== 'startup')
            return;
        this._dismissed = true;
        try {
            this._writeProtocolFile(this._dismissedFile, 'startup-hud-dismissed', {
                schema_version: 1,
                session_id: status.sessionId,
                started_at: status.startedAt,
                reason,
                dismissed_at: new Date().toISOString(),
            });
        } catch (error) {
            // Keep the current Shell session usable even if runtime storage is
            // temporarily unavailable. A future extension reload may show the
            // completed HUD again, but shutdown interception remains intact.
            console.warn(`Login HUD could not persist startup dismissal: ${error.message}`);
        }
    }

    _dismissHud() {
        const status = this._lastGoodStatus;
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        if (status?.mode === 'shutdown' && hasFailure) {
            this._hud?.setTransportNotice(
                'A failed shutdown report remains open until a new shutdown attempt or logout.'
            );
            return;
        }
        if (this._lastGoodStatus?.mode === 'startup')
            this._recordStartupDismissal(this._lastGoodStatus, 'user');
        else
            this._dismissed = true;
        this._syncVisibility();
    }

    _installHudChrome() {
        if (!this._hud || this._chromeInstalled)
            return;

        // Keep the stage-sized container out of the Shell input region.  The
        // panel itself is tracked below, so startup controls remain usable
        // without making the rest of the desktop an input surface.
        Main.layoutManager.addChrome(this._hud, {
            affectsStruts: false,
            trackFullscreen: false,
            affectsInputRegion: false,
        });
        Main.layoutManager.trackChrome(this._hud.getInteractiveActor(), {
            affectsStruts: false,
            trackFullscreen: false,
            affectsInputRegion: true,
        });
        this._chromeInstalled = true;
        this._panelChromeTracked = true;
        this._syncHudSize();
        this._stageSizeChangedId = global.stage.connect('notify::width', () => this._syncHudSize());
        this._stageHeightChangedId = global.stage.connect('notify::height', () => this._syncHudSize());
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._hud?.refreshClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncVisibility() {
        if (!this._hud)
            return;
        const atSessionBoundary = Main.sessionMode.isLocked || Main.sessionMode.isGreeter;
        if (!this._dismissed && atSessionBoundary &&
            this._startupCanAutoDismiss(this._lastGoodStatus))
            this._recordStartupDismissal(this._lastGoodStatus, 'session-boundary');
        // Do not render or reserve input before a complete, valid document is
        // available.  In particular, extension enablement must be passive
        // while GNOME is bringing up the session and display stack.
        const eligible = this._lastGoodStatus?.mode === 'shutdown' ||
            this._lastGoodStatus?.showOnStartup === true;
        const visible = Boolean(this._lastGoodStatus) && eligible && !this._dismissed &&
            !atSessionBoundary;
        if (!visible)
            this._releaseModal();
        this._hud.visible = visible;
        if (visible) {
            this._hud.scheduleProgressFill();
            this._syncModal();
            this._scheduleRenderedShutdownAck(this._lastGoodStatus);
        }
    }

    _syncModal() {
        const status = this._lastGoodStatus;
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        const shouldBeModal = this._hud?.visible && status?.mode === 'shutdown' &&
            !status.cancelled && !hasFailure;
        if (!shouldBeModal) {
            this._releaseModal();
            return;
        }
        this._hud.reactive = true;
        if (this._modalGrab) {
            this._hud.focusPrimaryAction();
            return;
        }
        const grab = Main.pushModal(this._hud, {
            actionMode: Shell.ActionMode.SYSTEM_MODAL,
        });
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            this._hud.setTransportNotice(
                'Exclusive keyboard/pointer control is temporarily unavailable; ' +
                'cancellation remains available without an input grab.'
            );
            return;
        }
        this._modalGrab = grab;
        Main.layoutManager.emit('system-modal-opened');
        this._hud.focusPrimaryAction();
    }

    _releaseModal() {
        if (this._modalGrab) {
            Main.popModal(this._modalGrab);
            this._modalGrab = null;
        }
        if (this._hud)
            this._hud.reactive = false;
    }

    _scheduleLoad() {
        if (this._reloadTimeout)
            return;
        this._reloadTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._reloadTimeout = 0;
            this._loadStatus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleSessionIdRetry() {
        if (this._sessionIdRetryId || !this._hud)
            return;
        this._sessionIdRetryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000,
            () => {
                this._sessionIdRetryId = 0;
                this._resolveCurrentSessionId();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _resolveCurrentSessionId() {
        if (!this._hud || this._currentSessionId || this._sessionIdResolvePending)
            return;
        this._sessionIdResolvePending = true;
        Gio.DBus.session.call(
            DBUS_NAME,
            DBUS_PATH,
            DBUS_INTERFACE,
            'GetNameOwner',
            new GLib.Variant('(s)', [SESSION_MANAGER_NAME]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            2000,
            null,
            (connection, result) => {
                if (!this._hud)
                    return;
                this._sessionIdResolvePending = false;
                try {
                    const [owner] = connection.call_finish(result).deepUnpack();
                    this._currentSessionId = GLib.compute_checksum_for_string(
                        GLib.ChecksumType.SHA256,
                        String(owner),
                        -1
                    ).slice(0, 16);
                    this._recoverPendingPreflightRequest();
                    this._loadStatus();
                } catch (error) {
                    console.warn(
                        `Login HUD could not identify the current GNOME session: ${error.message}`
                    );
                    this._scheduleSessionIdRetry();
                }
            }
        );
    }

    _recoverPendingPreflightRequest() {
        if (this._preflightOperationId || !this._requestFile)
            return;
        const request = this._readProtocolFileSync(this._requestFile);
        const requestedAt = Date.parse(request?.requested_at);
        const age = Date.now() - requestedAt;
        const recent = Number.isFinite(requestedAt) && age >= 0 && age <= 120000;
        if (request?.schema_version !== 1 ||
            !/^[0-9a-f]{32}$/.test(request.operation_id) ||
            request.session_id !== this._currentSessionId ||
            !SHUTDOWN_ACTIONS.has(request.action) || !recent)
            return;
        const cancellation = this._readProtocolFileSync(this._cancelFile);
        if (cancellation?.schema_version === 1 &&
            cancellation.operation_id === request.operation_id &&
            cancellation.session_id === request.session_id)
            return;

        this._preflightOperationId = request.operation_id;
        this._preflightAction = request.action;
        this._preflightSignal = request.action === 'restart'
            ? 'ConfirmedReboot' : 'ConfirmedShutdown';
        this._startPreflightWatchdog(request.operation_id, request.session_id);
    }

    _shutdownStatusReady(status) {
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        return status?.mode === 'shutdown' && !status.cancelled && !hasFailure &&
            status.operationId !== this._locallyCancelledOperationId &&
            status.stages.length > 0 &&
            status.stages.every(stage => TERMINAL_STATES.has(stage.state));
    }

    _cancelShutdownCountdown() {
        if (this._shutdownCountdownId)
            GLib.Source.remove(this._shutdownCountdownId);
        this._shutdownCountdownId = 0;
        this._shutdownCountdownOperationId = null;
        this._shutdownCountdownSeconds = 0;
    }

    _scheduleRenderedShutdownAck(status) {
        if (!this._shutdownStatusReady(status)) {
            if (status?.operationId === this._shutdownCountdownOperationId)
                this._cancelShutdownCountdown();
            return;
        }
        if (!this._hud?.visible || status.operationId === this._renderAckWrittenOperationId ||
            status.operationId === this._renderAckScheduledOperationId)
            return;

        const operationId = status.operationId;
        this._renderAckScheduledOperationId = operationId;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._hud || this._activeOperationId !== operationId ||
                !this._shutdownStatusReady(this._lastGoodStatus)) {
                if (this._renderAckScheduledOperationId === operationId)
                    this._renderAckScheduledOperationId = null;
                return GLib.SOURCE_REMOVE;
            }
            const panel = this._hud.getInteractiveActor();
            if (!this._hud.visible) {
                this._renderAckScheduledOperationId = null;
                return GLib.SOURCE_REMOVE;
            }
            if (!this._hud.mapped || !panel.mapped || panel.width <= 0 || panel.height <= 0)
                return GLib.SOURCE_CONTINUE;

            global.stage.queue_redraw();
            Clutter.threads_add_repaint_func_full(
                Clutter.RepaintFlags.POST_PAINT,
                () => {
                    if (!this._hud || this._activeOperationId !== operationId ||
                        !this._shutdownStatusReady(this._lastGoodStatus))
                        return false;
                    try {
                        this._writeProtocolFile(this._renderedFile, 'shutdown-hud-rendered', {
                            schema_version: 1,
                            operation_id: operationId,
                            session_id: this._lastGoodStatus.sessionId,
                            rendered_at: new Date().toISOString(),
                        });
                        this._renderAckWrittenOperationId = operationId;
                        this._startShutdownCountdown(this._lastGoodStatus);
                    } catch (error) {
                        this._renderAckScheduledOperationId = null;
                        this._hud.setTransportNotice(
                            `Ready, but the visual acknowledgement failed: ${error.message}`
                        );
                    }
                    return false;
                }
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _startShutdownCountdown(status) {
        if (this._shutdownCountdownId ||
            this._shutdownCountdownOperationId === status.operationId ||
            this._commitWrittenOperationId === status.operationId)
            return;
        const operationId = status.operationId;
        const action = status.shutdownAction ||
            (this._preflightOperationId === operationId ? this._preflightAction : null);
        let seconds = SHUTDOWN_COUNTDOWN_SECONDS;
        this._shutdownCountdownOperationId = operationId;
        this._shutdownCountdownSeconds = seconds;
        this._hud.setShutdownCountdown(action, seconds);
        this._hud.focusPrimaryAction();
        global.stage.queue_redraw();
        Clutter.threads_add_repaint_func_full(
            Clutter.RepaintFlags.POST_PAINT,
            () => {
                if (!this._hud || this._shutdownCountdownOperationId !== operationId ||
                    !this._shutdownStatusReady(this._lastGoodStatus))
                    return false;
                const began = GLib.get_monotonic_time();
                this._shutdownCountdownId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    100,
                    () => {
                        if (!this._hud || this._activeOperationId !== operationId ||
                            !this._shutdownStatusReady(this._lastGoodStatus)) {
                            this._shutdownCountdownId = 0;
                            this._shutdownCountdownOperationId = null;
                            this._shutdownCountdownSeconds = 0;
                            return GLib.SOURCE_REMOVE;
                        }
                        const elapsed = (GLib.get_monotonic_time() - began) / 1000000;
                        const remaining = Math.ceil(SHUTDOWN_COUNTDOWN_SECONDS - elapsed);
                        if (remaining > 0) {
                            if (remaining !== seconds) {
                                seconds = remaining;
                                this._shutdownCountdownSeconds = seconds;
                                this._hud.setShutdownCountdown(action, seconds);
                                this._hud.focusPrimaryAction();
                            }
                            return GLib.SOURCE_CONTINUE;
                        }
                        this._shutdownCountdownId = 0;
                        this._shutdownCountdownOperationId = null;
                        this._shutdownCountdownSeconds = 0;
                        this._commitShutdown(this._lastGoodStatus);
                        return GLib.SOURCE_REMOVE;
                    }
                );
                return false;
            }
        );
    }

    _commitShutdown(status) {
        if (!this._shutdownStatusReady(status) ||
            this._commitWrittenOperationId === status.operationId)
            return;
        try {
            this._writeProtocolFile(this._commitFile, 'shutdown-commit', {
                schema_version: 1,
                operation_id: status.operationId,
                session_id: status.sessionId,
                committed_at: new Date().toISOString(),
            });
            this._commitWrittenOperationId = status.operationId;
            this._hud.setAwaitingPrepared(status.shutdownAction || this._preflightAction);
            this._startPreparedPolling(status.operationId);
            this._checkPreparedHandoff();
        } catch (error) {
            this._hud.setTransportNotice(
                `Shutdown remains stopped because commit failed: ${error.message}`
            );
        }
    }

    _startPreparedPolling(operationId) {
        this._stopPreparedPolling();
        const began = GLib.get_monotonic_time();
        this._preparedPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,
            () => {
                if (!this._hud || this._activeOperationId !== operationId ||
                    this._commitWrittenOperationId !== operationId ||
                    this._nativeHandoffOperationId ||
                    this._locallyCancelledOperationId === operationId) {
                    this._preparedPollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                const elapsedMs = (GLib.get_monotonic_time() - began) / 1000;
                if (elapsedMs >= PREPARED_POLL_TIMEOUT_MS) {
                    this._preparedPollId = 0;
                    const status = this._lastGoodStatus;
                    const cancelled = status?.operationId === operationId &&
                        this._requestCancel(status);
                    if (cancelled) {
                        this._dismissed = true;
                        this._syncVisibility();
                        Main.notifyError(
                            'Shutdown cancelled safely',
                            'The coordinator did not publish final authorization in time.'
                        );
                    }
                    return GLib.SOURCE_REMOVE;
                }
                this._checkPreparedHandoff();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPreparedPolling() {
        if (this._preparedPollId)
            GLib.Source.remove(this._preparedPollId);
        this._preparedPollId = 0;
    }

    _checkPreparedHandoff() {
        const status = this._lastGoodStatus;
        if (!this._hud || this._preparedCheckPending ||
            status?.shutdownOrigin !== 'preflight' ||
            this._commitWrittenOperationId !== status.operationId ||
            this._nativeHandoffOperationId)
            return;
        try {
            const info = this._preparedFile.query_info(
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR) {
                this._hud.setTransportNotice(
                    'Shutdown remains stopped because the prepared marker is not a regular file.'
                );
                return;
            }
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                this._hud.setTransportNotice(
                    `Shutdown remains stopped while readiness is checked: ${error.message}`
                );
            return;
        }
        this._preparedCheckPending = true;
        this._preparedFile.load_contents_async(null, (file, result) => {
            this._preparedCheckPending = false;
            if (!this._hud || this._lastGoodStatus?.operationId !== status.operationId)
                return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const prepared = JSON.parse(new TextDecoder().decode(bytes));
                if (prepared.schema_version !== 1 ||
                    prepared.operation_id !== status.operationId ||
                    prepared.session_id !== status.sessionId ||
                    prepared.action !== status.shutdownAction)
                    return;
                this._handoffToGnome(status);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._hud.setTransportNotice(
                        `Shutdown remains stopped while readiness is checked: ${error.message}`
                    );
            }
        });
    }

    _handoffToGnome(status) {
        if (!this._shutdownStatusReady(status) || this._nativeHandoffOperationId ||
            this._commitWrittenOperationId !== status.operationId)
            return;
        const signal = this._preflightOperationId === status.operationId
            ? this._preflightSignal
            : status.shutdownAction === 'restart'
                ? 'ConfirmedReboot'
                : status.shutdownAction === 'poweroff' ? 'ConfirmedShutdown' : null;
        if (!signal) {
            this._hud.setTransportNotice(
                'Shutdown remains stopped because the original GNOME action is unknown.'
            );
            return;
        }

        this._nativeHandoffOperationId = status.operationId;
        this._stopPreparedPolling();
        this._hud.setHandoffStarted(status.shutdownAction || this._preflightAction);
        this._confirmBypass = true;
        try {
            Promise.resolve(this._originalEndSessionConfirm.call(this._endSessionDialog, signal))
                .catch(error => this._handleNativeHandoffFailure(status, error));
        } catch (error) {
            this._handleNativeHandoffFailure(status, error);
        } finally {
            this._confirmBypass = false;
        }
    }

    _handleNativeHandoffFailure(status, error) {
        if (this._nativeHandoffOperationId !== status.operationId)
            return;
        console.error(`Login HUD GNOME handoff failed: ${error.message}`);
        this._nativeHandoffOperationId = null;
        this._locallyCancelledOperationId = status.operationId;
        try {
            this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                schema_version: 1,
                operation_id: status.operationId,
                session_id: status.sessionId,
                requested_at: new Date().toISOString(),
            });
        } catch (cancelError) {
            console.warn(
                `Login HUD could not cancel a rejected GNOME handoff: ${cancelError.message}`
            );
        }
        this._cancelNativeEndSessionOnce(status.operationId);
        if (this._preflightOperationId === status.operationId) {
            this._preflightOperationId = null;
            this._preflightAction = null;
            this._preflightSignal = null;
        }
        this._dismissed = true;
        this._syncVisibility();
        this._hud?.setTransportNotice(
            `Shutdown cancelled because GNOME rejected the final handoff: ${error.message}`
        );
        Main.notifyError(
            'Shutdown cancelled safely',
            `GNOME rejected the final shutdown handoff: ${error.message}`
        );
    }

    _handleTerminalShutdownStatus(status) {
        if (status.mode !== 'shutdown')
            return;
        const hasFailure = status.overallState === 'failed' ||
            status.stages.some(stage => stage.state === 'failed');
        if (!status.cancelled && !hasFailure)
            return;

        const wasHandedOff = this._nativeHandoffOperationId === status.operationId;
        this._stopPreparedPolling();
        this._cancelShutdownCountdown();
        this._renderAckScheduledOperationId = null;
        this._locallyCancelledOperationId = status.operationId;
        if (hasFailure) {
            try {
                this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                    schema_version: 1,
                    operation_id: status.operationId,
                    session_id: status.sessionId,
                    requested_at: new Date().toISOString(),
                });
            } catch (error) {
                this._hud.setTransportNotice(
                    `Shutdown is stopped, but backend recovery could not be requested: ${error.message}`
                );
            }
        }
        // A terminal failure/cancellation ends the pending GNOME request
        // exactly once. Repeated cancel calls can accidentally close a new
        // dialog opened immediately afterwards.
        if (wasHandedOff) {
            // GNOME emitted CancelEndSession after the handed-off operation.
            // Mark that native side terminal before clearing handoff state so
            // repeated status writes cannot emit Canceled into a later dialog.
            this._nativeCancelledOperationId = status.operationId;
            this._nativeHandoffOperationId = null;
        } else {
            this._cancelNativeEndSessionOnce(status.operationId);
        }
        if (this._preflightOperationId === status.operationId) {
            this._preflightOperationId = null;
            this._preflightAction = null;
            this._preflightSignal = null;
        }
    }

    _cancelNativeEndSessionOnce(operationId) {
        if (!operationId || this._nativeCancelledOperationId === operationId)
            return;
        this._nativeCancelledOperationId = operationId;
        try {
            Main.endSessionDialog?.cancel?.();
        } catch (error) {
            console.warn(`Login HUD could not cancel GNOME's shutdown dialog: ${error.message}`);
        }
    }

    _abortActivePreflightOnDisable() {
        const operationId = this._preflightOperationId;
        if (!operationId || this._nativeHandoffOperationId === operationId)
            return;
        try {
            this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                schema_version: 1,
                operation_id: operationId,
                session_id: this._currentSessionId,
                requested_at: new Date().toISOString(),
            });
        } catch (error) {
            console.warn(`Login HUD could not cancel backend work while disabling: ${error.message}`);
        }
        this._locallyCancelledOperationId = operationId;
        this._cancelNativeEndSessionOnce(operationId);
    }

    _loadStatus() {
        if (!this._currentSessionId) {
            this._resolveCurrentSessionId();
            return;
        }
        const serial = ++this._loadSerial;
        this._statusFile.load_contents_async(null, (file, result) => {
            if (!this._hud || serial !== this._loadSerial)
                return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const parsed = normaliseStatus(JSON.parse(new TextDecoder().decode(bytes)));
                if (parsed.sessionId !== this._currentSessionId) {
                    this._lastGoodStatus = null;
                    this._syncVisibility();
                    return;
                }
                const request = parsed.mode === 'shutdown'
                    ? this._readProtocolFileSync(this._requestFile) : null;
                const matchesRequest = request?.schema_version === 1 &&
                    request.operation_id === parsed.operationId &&
                    request.session_id === parsed.sessionId &&
                    SHUTDOWN_ACTIONS.has(request.action);
                const matchesLocalPreflight = parsed.operationId === this._preflightOperationId;
                const terminalShutdown = parsed.mode === 'shutdown' &&
                    (parsed.cancelled || parsed.overallState === 'failed' ||
                        parsed.stages.some(stage => stage.state === 'failed'));
                if (parsed.mode === 'shutdown' &&
                    !matchesRequest && !matchesLocalPreflight && !terminalShutdown) {
                    // A backend-only QueryEndSession status must never make a
                    // HUD appear below GNOME's still-open confirmation. Every
                    // non-terminal shutdown status is bound to this
                    // extension's post-confirmation private request. A
                    // terminal failure is safe to keep visible because it can
                    // neither acquire a modal grab nor authorize handoff.
                    this._lastGoodStatus = null;
                    this._syncVisibility();
                    return;
                }
                if ((matchesRequest || matchesLocalPreflight) &&
                    !parsed.shutdownOriginExplicit)
                    parsed.shutdownOrigin = 'preflight';
                if (!parsed.shutdownActionExplicit &&
                    (matchesRequest || matchesLocalPreflight))
                    parsed.shutdownAction = matchesRequest ? request.action : this._preflightAction;
                if (parsed.operationId === this._preflightOperationId &&
                    this._preflightWatchdogId) {
                    GLib.Source.remove(this._preflightWatchdogId);
                    this._preflightWatchdogId = 0;
                }
                const isNewSessionOrMode = parsed.sessionId !== this._activeSessionId ||
                    parsed.mode !== this._activeMode ||
                    parsed.operationId !== this._activeOperationId ||
                    parsed.startedAt !== this._activeStartedAt;
                if (isNewSessionOrMode) {
                    this._cancelShutdownCountdown();
                    this._dismissed = false;
                    this._activeSessionId = parsed.sessionId;
                    this._activeMode = parsed.mode;
                    this._activeOperationId = parsed.operationId;
                    this._activeStartedAt = parsed.startedAt;
                    this._renderAckScheduledOperationId = null;
                    this._renderAckWrittenOperationId = null;
                    this._commitWrittenOperationId = null;
                    this._nativeHandoffOperationId = null;
                    this._cancelRequestPending = false;
                    this._hud.resetExpansion();
                    this._hud.setCancellationPending(false);
                }
                if (parsed.mode === 'startup') {
                    if (this._startupDismissalMatches(parsed)) {
                        this._dismissed = true;
                    } else if (this._startupPresentationIsStale(parsed)) {
                        this._recordStartupDismissal(parsed, 'stale-completion');
                    }
                }
                if (parsed.cancelled) {
                    this._cancelRequestPending = false;
                }
                if (parsed.shutdownOrigin === 'preflight' &&
                    parsed.operationId !== this._locallyCancelledOperationId &&
                    (!this._preflightOperationId ||
                        this._preflightOperationId === parsed.operationId)) {
                    this._preflightOperationId = parsed.operationId;
                    this._preflightAction = parsed.shutdownAction;
                    this._preflightSignal = parsed.shutdownAction === 'restart'
                        ? 'ConfirmedReboot'
                        : parsed.shutdownAction === 'poweroff' ? 'ConfirmedShutdown' : null;
                }
                this._lastGoodStatus = parsed;
                const eligible = parsed.mode === 'shutdown' || parsed.showOnStartup;
                if (eligible) {
                    this._installHudChrome();
                    this._hud.setStatus(parsed);
                    if (this._nativeHandoffOperationId === parsed.operationId) {
                        this._hud.setHandoffStarted(parsed.shutdownAction || this._preflightAction);
                    } else if (this._shutdownCountdownOperationId === parsed.operationId &&
                        this._shutdownCountdownSeconds > 0) {
                        this._hud.setShutdownCountdown(
                            parsed.shutdownAction || this._preflightAction,
                            this._shutdownCountdownSeconds
                        );
                    } else if (this._commitWrittenOperationId === parsed.operationId &&
                        parsed.shutdownOrigin === 'preflight') {
                        this._hud.setAwaitingPrepared(
                            parsed.shutdownAction || this._preflightAction
                        );
                    }
                }
                this._syncVisibility();
                this._handleTerminalShutdownStatus(parsed);
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    if (!this._lastGoodStatus)
                        this._hud.setTransportNotice('Waiting for session status…');
                    return;
                }
                this._hud.setTransportNotice(`Waiting for a valid status update: ${error.message}`);
            }
        });
    }

    _requestCancel(status) {
        if (
            !this._hud || !this._cancelFile || status.mode !== 'shutdown' ||
            status.cancelled || !status.operationId || this._cancelRequestPending ||
            this._nativeHandoffOperationId === status.operationId
        )
            return false;

        try {
            this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                schema_version: 1,
                operation_id: status.operationId,
                session_id: status.sessionId,
                requested_at: new Date().toISOString(),
            });
            this._locallyCancelledOperationId = status.operationId;
            this._cancelShutdownCountdown();
            this._cancelRequestPending = true;
            this._hud.setCancellationPending(true);
            this._hud.setTransportNotice(
                'Cancellation requested. Prepared jobs are being restored ' +
                'before the shutdown transaction closes.'
            );
            this._cancelNativeEndSessionOnce(status.operationId);
            return true;
        } catch (error) {
            this._cancelRequestPending = false;
            this._hud.setCancellationPending(false);
            this._hud.setTransportNotice(
                `Could not send the cancellation request: ${error.message}`
            );
            return false;
        }
    }

    _openErrorLog(path) {
        if (!path) {
            this._hud?.reportLogLaunchFailure('no local error_log_path was supplied.');
            return;
        }

        const status = this._lastGoodStatus;
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        const keepVisible = status?.mode === 'shutdown' && hasFailure;
        const uri = Gio.File.new_for_path(path).get_uri();
        try {
            if (!keepVisible) {
                this._dismissed = true;
                this._syncVisibility();
            }
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_source, result) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (error) {
                    if (!keepVisible) {
                        this._dismissed = false;
                        this._syncVisibility();
                    }
                    this._hud?.reportLogLaunchFailure(error.message);
                }
            });
        } catch (error) {
            if (!keepVisible) {
                this._dismissed = false;
                this._syncVisibility();
            }
            this._hud?.reportLogLaunchFailure(error.message);
        }
    }
}
