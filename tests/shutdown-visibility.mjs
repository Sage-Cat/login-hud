import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await loadSource();
function fixture() {
    let clock = 0;
    const timers = [];
    const paints = [];
    let modalPops = 0;
    const notices = [];
    const sessionMode = {isLocked: false, isGreeter: false};
    const main = {sessionMode, notify(...args) { notices.push(args); },
        popModal() { modalPops++; }, pushModal() { throw new Error('unexpected modal acquisition'); }};
    const {LoginHudExtension, normaliseStatus} = runInNewContext(
        source +
            '\n;({LoginHudExtension, normaliseStatus});', {
            BUILD_REVISION: 'development',
            GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
            Gio: {Cancellable: class {cancel() {}}, DBus: {session: {}},
                DBusExportedObject: {wrapJSObject: () => ({export() {}, unexport() {}})}},
            Main: main, console: {info() {}, warn() {}, error() {}}, TextDecoder,
            global: {stage: {queue_redraw() {}}},
            Clutter: {KEY_Escape: 'Escape', EVENT_PROPAGATE: 'propagate', EVENT_STOP: 'stop', RepaintFlags: {POST_PAINT: 1}, threads_add_repaint_func_full(_flags, fn) { paints.push(fn); }},
            GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
                file_get_contents: () => [true, new TextEncoder().encode('boot\n')],
                get_monotonic_time: () => clock * 1e6,
                timeout_add(_priority, _interval, fn) { timers.push(fn); return timers.length; },
                Source: {remove() {}}},
        }
    );
    const extension = Object.create(LoginHudExtension.prototype);
    const status = {mode: 'shutdown', overallState: 'ready', operationId: 'a'.repeat(32),
        sessionId: 'session', shutdownOrigin: 'preflight', shutdownAction: 'poweroff',
        operationState: 'prepared', stages: [{state: 'ready'}], cancelled: false,
        operationContext: {boot_id: 'boot', login_generation: 'session', operation_id: 'a'.repeat(32),
            mode: 'shutdown', attempt: 1, deadline: 1000}};
    const panel = {mapped: true, width: 800, height: 800};
    let cancels = 0;
    let commits = 0;
    let handoffs = 0;
    Object.assign(extension, {
        _bootId: 'boot', _currentSessionId: 'session', _enableEpoch: {},
        _lastGoodStatus: status, _activeOperationId: status.operationId,
        _hud: {visible: true, mapped: true, getInteractiveActor: () => panel,
            setTransportNotice() {}, setShutdownCountdown() {}, focusPrimaryAction() {},
            setAwaitingPrepared() {}, setHandoffStarted() {}, resetExpansion() {},
            setCancellationPending() {}, setStartupAbortPending() {}, setStatus() {}, scheduleProgressFill() {},
            refreshVisibleGc() {}, cancelDeferredUpdates() {}, destroy() {}},
        _requestCancel() { cancels++; return true; },
        _writeProtocolFile() { commits++; }, _startPreparedPolling() {}, _checkPreparedHandoff() {},
        _stopPreparedPolling() {}, _originalEndSessionConfirm() { handoffs++; },
    });
    return {extension, status, normaliseStatus, panel, sessionMode, timers, paints, main, notices,
        modalPops: () => modalPops, clock(value) { clock = value; }, cancels: () => cancels, commits: () => commits, handoffs: () => handoffs};
}

function shutdownReport(status, fields = {}) {
    return {schema_version: 1, mode: 'shutdown', session_id: status.sessionId,
        operation_id: status.operationId, operation_context: status.operationContext,
        shutdown_origin: 'preflight', shutdown_action: status.shutdownAction,
        operation_state: status.operationState,
        started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
        overall_state: 'ready', overall_message: 'Shutdown progress', error_log_path: null,
        stages: [{id: 'proof', state: 'ready', message: 'Verified'}], ...fields};
}

function bindReport(f, raw, request = null) {
    const requestFile = {};
    const statusFile = {load_contents_async(_cancel, callback) { callback(this, {}); },
        load_contents_finish() { return [true, new TextEncoder().encode(JSON.stringify(raw))]; }};
    Object.assign(f.extension, {_loadSerial: 0, _requestFile: requestFile, _cancelFile: {},
        _statusFile: statusFile, _installHudChrome() {},
        _readProtocolFileSync: file => file === requestFile ? request : null});
    return {requestFile, statusFile};
}

test('lock-screen confirmation cancels native shutdown without starting hidden work', async () => {
    const metadata = JSON.parse(await readFile(new URL('../metadata.json', import.meta.url), 'utf8'));
    assert.deepEqual(metadata['session-modes'], ['user', 'unlock-dialog']);
    for (const boundary of ['isLocked', 'isGreeter']) {
        for (const signal of ['ConfirmedShutdown', 'ConfirmedReboot']) {
            const f = fixture();
            let cancelled = 0;
            f.sessionMode[boundary] = true;
            f.extension._endSessionDialog = {cancel() { cancelled++; }};
            f.extension._shutdownCoordinatorIsActive = () => true;
            await f.extension._interceptEndSessionConfirm(signal);
            assert.equal(cancelled, 1);
            assert.equal(f.handoffs(), 0);
            assert.equal(f.commits(), 0);
            assert.equal(f.notices.length, 1);
        }
    }
});

test('standalone locked shutdown and ordinary logout retain native confirmation', async () => {
    for (const [signal, active] of [['ConfirmedShutdown', false], ['ConfirmedLogout', true]]) {
        const f = fixture();
        f.sessionMode.isLocked = true;
        f.extension._shutdownCoordinatorIsActive = () => active;
        f.extension._endSessionDialog = {cancel() { throw new Error('unexpected cancel'); }};
        await f.extension._interceptEndSessionConfirm(signal);
        assert.equal(f.handoffs(), 1);
        assert.equal(f.notices.length, 0);
    }
});

test('session changes preserve one hook and replace only the owned old dialog hook', async () => {
    const f = fixture();
    const first = {_confirm() { throw new Error('native action must stay intercepted'); }};
    const original = first._confirm;
    f.main.endSessionDialog = first;
    const seen = [];
    f.extension._interceptEndSessionConfirm = signal => seen.push(signal);
    f.extension._installEndSessionInterceptor();
    const wrapped = first._confirm;
    f.extension._installEndSessionInterceptor();
    assert.equal(first._confirm, wrapped);
    await first._confirm('ConfirmedShutdown');
    assert.deepEqual(seen, ['ConfirmedShutdown']);
    const next = {_confirm() {}};
    f.main.endSessionDialog = next;
    f.extension._installEndSessionInterceptor();
    assert.equal(first._confirm, original);
    await next._confirm('ConfirmedReboot');
    assert.deepEqual(seen, ['ConfirmedShutdown', 'ConfirmedReboot']);
    const foreign = () => {};
    next._confirm = foreign;
    f.extension._restoreEndSessionInterceptor();
    assert.equal(next._confirm, foreign);
});

test('all jobs terminal is insufficient while overall verification is running', () => {
    const f = fixture();
    f.status.overallState = 'running';
    assert.equal(f.extension._shutdownStatusReady(f.status), false);
    f.extension._commitShutdown(f.status);
    assert.equal(f.commits(), 0);
});

test('completed capture rows wait for prepared lifecycle before countdown and native handoff', () => {
    for (const operationState of ['preparing', undefined]) {
        const f = fixture();
        const raw = shutdownReport(f.status, {operation_state: operationState,
            stages: [{id: 'desktop-capture', state: 'ready', message: 'Desktop captured'},
                {id: 'terminal-capture', state: 'ready', message: 'Terminals captured'}]});
        bindReport(f, raw, {schema_version: 1, session_id: 'session',
            operation_id: f.status.operationId, action: 'poweroff'});
        const writes = [];
        f.extension._writeProtocolFile = (_file, prefix) => writes.push(prefix);
        // Keep the already-owned modal, as in a cancellable capture in progress.
        f.extension._modalGrab = {};
        f.extension._loadStatus();
        const preparing = f.extension._lastGoodStatus;
        assert.equal(f.extension._shutdownStatusReady(preparing), false);
        assert.equal(f.extension._shutdownCountdownOperationId, null);
        assert.equal(f.timers.length, 0);
        assert.equal(f.paints.length, 0);
        f.extension._commitShutdown(preparing);
        f.extension._commitWrittenOperationId = preparing.operationId;
        f.extension._handoffToGnome(preparing);
        assert.deepEqual(writes, []);
        assert.equal(f.handoffs(), 0);
        f.extension._commitWrittenOperationId = null;

        raw.operation_state = 'prepared';
        f.extension._loadStatus();
        const prepared = f.extension._lastGoodStatus;
        assert.equal(f.extension._shutdownStatusReady(prepared), true);
        f.timers[0]();
        f.paints[0]();
        assert.deepEqual(writes, ['shutdown-hud-rendered']);
        assert.equal(f.extension._shutdownCountdownOperationId, prepared.operationId);
        f.paints[1]();
        f.clock(5.1);
        f.timers[1]();
        assert.deepEqual(writes, ['shutdown-hud-rendered', 'shutdown-commit']);
        assert.equal(f.handoffs(), 0);

        raw.operation_state = 'authorized';
        f.extension._loadStatus();
        const authorized = f.extension._lastGoodStatus;
        assert.equal(f.extension._shutdownStatusReady(authorized), true);
        f.extension._handoffToGnome(authorized);
        f.extension._handoffToGnome(authorized);
        assert.equal(f.handoffs(), 1);
    }
});

test('prepared wait covers app drain but still cancels an unresponsive coordinator', () => {
    const f = fixture();
    delete f.extension._startPreparedPolling;
    f.extension._syncVisibility = () => {};
    f.main.notifyError = (...args) => f.notices.push(args);
    f.extension._commitWrittenOperationId = f.status.operationId;
    f.extension._startPreparedPolling(f.status.operationId);
    const poll = f.timers.at(-1);
    for (const elapsed of [15, 25, 30, 34.9]) {
        f.clock(elapsed);
        assert.equal(poll(), true);
        assert.equal(f.cancels(), 0);
        assert.equal(f.handoffs(), 0);
    }
    f.clock(35);
    assert.equal(poll(), false);
    assert.equal(f.cancels(), 1);
    assert.equal(f.extension._dismissed, true);
    assert.equal(f.notices.length, 1);
    assert.equal(f.handoffs(), 0);
});

test('local cancellation stops the longer prepared wait immediately', () => {
    const f = fixture();
    delete f.extension._startPreparedPolling;
    f.extension._commitWrittenOperationId = f.status.operationId;
    f.extension._startPreparedPolling(f.status.operationId);
    f.extension._locallyCancelledOperationId = f.status.operationId;
    assert.equal(f.timers.at(-1)(), false);
    assert.equal(f.cancels(), 0);
    assert.equal(f.handoffs(), 0);
});

test('shutdown status cannot replace the action from a confirmed request or local preflight', () => {
    for (const [binding, action] of ['request', 'local', 'both'].flatMap(binding =>
        ['restart', 'poweroff'].map(action => [binding, action]))) {
        const f = fixture();
        const raw = {schema_version: 1, mode: 'shutdown', session_id: 'session',
            operation_id: f.status.operationId, shutdown_origin: 'preflight', shutdown_action: action,
            operation_state: 'prepared',
            started_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:01Z',
            overall_state: 'ready', overall_message: 'Ready', error_log_path: '/tmp/log',
            stages: [{id: 'proof', state: 'ready', message: 'Verified'}]};
        Object.assign(f.extension, {
            _currentSessionId: 'session', _loadSerial: 0,
            _readProtocolFileSync: () => binding === 'local' ? null : {
                schema_version: 1, session_id: 'session', operation_id: f.status.operationId, action: 'poweroff',
            },
            _preflightOperationId: binding === 'request' ? null : f.status.operationId,
            _preflightAction: 'poweroff', _preflightSignal: 'ConfirmedShutdown',
            _syncVisibility() {}, _installHudChrome() {}, _handleTerminalShutdownStatus() {},
            _statusFile: {
                load_contents_async(_cancel, callback) { callback(this, {}); },
                load_contents_finish() { return [true, new TextEncoder().encode(JSON.stringify(raw))]; },
            },
        });
        f.extension._loadStatus();
        if (action === 'restart')
            assert.equal(f.extension._lastGoodStatus, f.status, binding);
        else
            assert.equal(f.extension._lastGoodStatus.shutdownAction, 'poweroff', binding);
        assert.equal(f.extension._preflightSignal, 'ConfirmedShutdown', binding);
        assert.equal(f.handoffs(), 0, binding);
    }
});

test('stale terminal reports cannot replace or cancel a newer confirmed shutdown', () => {
    for (const binding of ['local', 'request', 'stale-request', 'handoff']) {
        for (const terminal of [{cancelled: true}, {overall_state: 'failed'},
            {stages: [{id: 'proof', state: 'failed', message: 'Stopped'}]}]) {
            const f = fixture();
            const old = {...f.status};
            f.status.operationId = 'b'.repeat(32);
            f.status.operationContext = {...f.status.operationContext, operation_id: f.status.operationId};
            const requestId = binding === 'stale-request' || binding === 'handoff'
                ? old.operationId : f.status.operationId;
            const raw = shutdownReport(old, terminal);
            bindReport(f, raw, {schema_version: 1, session_id: 'session',
                operation_id: requestId, action: 'poweroff'});
            let nativeCancels = 0;
            f.main.endSessionDialog = {cancel() { nativeCancels++; }};
            delete f.extension._stopPreparedPolling;
            Object.assign(f.extension, {
                _activeSessionId: 'session', _activeMode: 'shutdown', _activeStartedAt: raw.started_at,
                _activeOperationId: f.status.operationId,
                _preflightOperationId: binding === 'request' || binding === 'handoff' ? null : f.status.operationId,
                _preflightAction: 'poweroff', _preflightSignal: 'ConfirmedShutdown',
                _nativeHandoffOperationId: binding === 'handoff' ? f.status.operationId : null,
                _shutdownCountdownId: 19, _shutdownCountdownOperationId: f.status.operationId,
                _shutdownCountdownSeconds: 3, _preparedPollId: 20, _preflightWatchdogId: 21,
                _renderAckScheduledOperationId: f.status.operationId,
                _renderAckWrittenOperationId: f.status.operationId, _commitWrittenOperationId: f.status.operationId,
                _modalGrab: {},
            });
            f.extension._loadStatus();
            // Direct terminal handling must enforce the same binding as the loader.
            f.extension._handleTerminalShutdownStatus(f.normaliseStatus(raw));
            assert.equal(f.extension._lastGoodStatus, f.status, binding);
            assert.equal(f.extension._activeOperationId, f.status.operationId, binding);
            assert.equal(f.extension._shutdownCountdownId, 19, binding);
            assert.equal(f.extension._shutdownCountdownOperationId, f.status.operationId, binding);
            assert.equal(f.extension._shutdownCountdownSeconds, 3, binding);
            assert.equal(f.extension._preparedPollId, 20, binding);
            assert.equal(f.extension._preflightWatchdogId, 21, binding);
            assert.equal(f.extension._renderAckScheduledOperationId, f.status.operationId, binding);
            assert.equal(f.extension._renderAckWrittenOperationId, f.status.operationId, binding);
            assert.equal(f.extension._commitWrittenOperationId, f.status.operationId, binding);
            assert.equal(f.extension._nativeHandoffOperationId,
                binding === 'handoff' ? f.status.operationId : null, binding);
            assert.equal(f.extension._hasShutdownAuthority(f.status), true, binding);
            assert.equal(f.modalPops(), 0, binding);
            assert.equal(nativeCancels, 0, binding);
            assert.equal(f.commits(), 0, binding);
        }
    }
});

test('matching terminal reports withdraw authority and finish native cancellation once', () => {
    for (const handedOff of [false, true]) {
        for (const terminal of [{cancelled: true}, {overall_state: 'failed'}]) {
            const f = fixture();
            const raw = shutdownReport(f.status, terminal);
            bindReport(f, raw, {schema_version: 1, session_id: 'session',
                operation_id: f.status.operationId, action: 'poweroff'});
            let nativeCancels = 0;
            f.main.endSessionDialog = {cancel() { nativeCancels++; }};
            delete f.extension._stopPreparedPolling;
            Object.assign(f.extension, {
                _activeSessionId: 'session', _activeMode: 'shutdown', _activeStartedAt: raw.started_at,
                _preflightOperationId: f.status.operationId, _preflightAction: 'poweroff',
                _preflightSignal: 'ConfirmedShutdown', _modalGrab: {},
                _nativeHandoffOperationId: handedOff ? f.status.operationId : null,
                _shutdownCountdownId: 19, _shutdownCountdownOperationId: f.status.operationId,
                _preparedPollId: 20, _renderAckWrittenOperationId: f.status.operationId,
                _commitWrittenOperationId: f.status.operationId,
            });
            f.extension._loadStatus();
            f.extension._loadStatus();
            assert.equal(f.extension._isLocallyCancelled(f.extension._lastGoodStatus), true);
            assert.equal(f.extension._hasShutdownAuthority(f.extension._lastGoodStatus), false);
            assert.equal(f.extension._preflightOperationId, null);
            assert.equal(f.extension._nativeHandoffOperationId, null);
            assert.equal(f.extension._shutdownCountdownId, 0);
            assert.equal(f.extension._preparedPollId, 0);
            assert.equal(f.extension._renderAckWrittenOperationId, null);
            assert.equal(f.extension._commitWrittenOperationId, null);
            assert.equal(f.modalPops(), 1);
            assert.equal(nativeCancels, handedOff ? 0 : 1);
            assert.equal(f.commits(), terminal.overall_state === 'failed' ? 1 : 0);
        }
    }
});

test('an unbound historical terminal report remains passive', () => {
    const f = fixture();
    bindReport(f, shutdownReport(f.status, {overall_state: 'failed'}));
    let nativeCancels = 0;
    f.main.endSessionDialog = {cancel() { nativeCancels++; }};
    f.extension._loadStatus();
    assert.equal(f.extension._lastGoodStatus.overallState, 'failed');
    assert.equal(f.extension._preflightOperationId, undefined);
    assert.equal(f.extension._isLocallyCancelled(f.extension._lastGoodStatus), false);
    assert.equal(nativeCancels, 0);
    assert.equal(f.commits(), 0);
});

test('disable withdrawal survives a failed cancel write and refuses recovery after reenable', () => {
    const f = fixture();
    const hud = f.extension._hud;
    const raw = shutdownReport(f.status);
    const request = {schema_version: 1, session_id: 'session', operation_id: f.status.operationId,
        action: 'poweroff', requested_at: new Date().toISOString()};
    const files = bindReport(f, raw, request);
    let writes = 0;
    let nativeCancels = 0;
    f.main.endSessionDialog = {cancel() { nativeCancels++; }};
    Object.assign(f.extension, {
        uuid: 'test-hud', metadata: {version: 18},
        _preflightOperationId: f.status.operationId, _preflightAction: 'poweroff',
        _preflightSignal: 'ConfirmedShutdown',
        _writeProtocolFile() { writes++; throw new Error('disk unavailable'); },
        _enable() {
            Object.assign(this, {_hud: hud, _currentSessionId: 'session', _cancelFile: {},
                _requestFile: files.requestFile, _statusFile: files.statusFile});
        },
    });
    f.extension.disable();
    assert.equal(writes, 1);
    assert.equal(nativeCancels, 1);
    assert.equal(f.extension._locallyCancelledOperationId, null);
    f.extension.enable();
    f.extension._recoverPendingPreflightRequest();
    assert.equal(f.extension._preflightOperationId, null);
    assert.equal(f.timers.length, 0);
    f.extension._loadStatus();
    const late = f.extension._lastGoodStatus;
    assert.equal(f.extension._isLocallyCancelled(late), true);
    assert.equal(f.extension._hasShutdownAuthority(late), false);
    assert.equal(f.extension._preflightOperationId, null);
    assert.equal(f.extension._shutdownCountdownOperationId, null);
    assert.equal(f.timers.length, 0);
    assert.equal(f.paints.length, 0);
    f.extension._commitShutdown(late);
    f.extension._commitWrittenOperationId = late.operationId;
    f.extension._handoffToGnome(late);
    assert.equal(writes, 1);
    assert.equal(f.handoffs(), 0);
    assert.equal(nativeCancels, 1);
    f.extension.disable();
});

test('startup null identity never displays handoff while a matching shutdown still does', () => {
    for (const mode of ['startup', 'shutdown']) {
        const f = fixture();
        const operationId = mode === 'shutdown' ? f.status.operationId : null;
        const raw = {schema_version: 1, mode, session_id: 'session',
            started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
            overall_state: mode === 'shutdown' ? 'ready' : 'running', overall_message: 'Example progress',
            error_log_path: '/tmp/example.txt', stages: [{id: 'example',
                state: mode === 'shutdown' ? 'ready' : 'running', message: 'Example progress'}],
            ...(mode === 'shutdown' ? {operation_id: operationId, operation_context: f.status.operationContext,
                shutdown_origin: 'preflight', shutdown_action: 'poweroff', operation_state: 'authorized'} : {})};
        const handoffs = [];
        const notices = [];
        Object.assign(f.extension, {
            _loadSerial: 0, _nativeHandoffOperationId: operationId,
            _commitWrittenOperationId: null, _shutdownCountdownOperationId: null, _shutdownCountdownSeconds: 0,
            _activeSessionId: 'session', _activeMode: mode, _activeOperationId: operationId,
            _activeStartedAt: raw.started_at, _preflightOperationId: operationId,
            _preflightAction: mode === 'shutdown' ? 'poweroff' : null,
            _startupDismissalMatches: () => false, _startupPresentationIsStale: () => false,
            _loadAlerts() {}, _loadGcProfiles() {}, _syncVisibility() {}, _installHudChrome() {},
            _handleTerminalShutdownStatus() {}, _readProtocolFileSync: () => null,
            _statusFile: {load_contents_async(_cancel, callback) { callback(this, {}); },
                load_contents_finish() { return [true, new TextEncoder().encode(JSON.stringify(raw))]; }},
        });
        f.extension._hud.setHandoffStarted = action => handoffs.push(action);
        f.extension._hud.setAwaitingPrepared = () => handoffs.push('prepared');
        f.extension._hud.setShutdownCountdown = () => handoffs.push('countdown');
        f.extension._hud.setTransportNotice = message => notices.push(message);
        f.extension._loadStatus();
        assert.equal(f.extension._lastGoodStatus.mode, mode);
        assert.equal(f.extension._lastGoodStatus.shutdownOrigin, mode === 'shutdown' ? 'preflight' : null);
        assert.deepEqual(notices, []);
        assert.deepEqual(handoffs, mode === 'shutdown' ? ['poweroff'] : []);
    }
});

test('terminal or withdrawn shutdown never restores stale committed progress overlays', () => {
    for (const overlay of ['prepared', 'countdown', 'handoff']) {
        for (const change of ['cancelled', 'failed', 'failed-stage', 'local-cancel', 'expired']) {
            const f = fixture();
            const raw = {schema_version: 1, mode: 'shutdown', session_id: 'session',
                operation_id: f.status.operationId, operation_context: {...f.status.operationContext},
                shutdown_origin: 'preflight', shutdown_action: 'poweroff',
                operation_state: 'prepared',
                started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
                overall_state: change === 'failed' ? 'failed' : 'ready',
                cancelled: change === 'cancelled', overall_message: 'Shutdown stopped', error_log_path: null,
                stages: [{id: 'proof', state: change === 'failed-stage' ? 'failed' : 'ready', message: 'Stopped'}]};
            const decorated = [];
            if (change === 'expired')
                f.clock(1001);
            Object.assign(f.extension, {
                _loadSerial: 0, _activeSessionId: 'session', _activeMode: 'shutdown',
                _activeStartedAt: raw.started_at,
                _preflightOperationId: f.status.operationId, _preflightAction: 'poweroff',
                _commitWrittenOperationId: f.status.operationId,
                _renderAckWrittenOperationId: f.status.operationId,
                _nativeHandoffOperationId: overlay === 'handoff' ? f.status.operationId : null,
                _shutdownCountdownOperationId: overlay === 'countdown' ? f.status.operationId : null,
                _shutdownCountdownSeconds: overlay === 'countdown' ? 3 : 0,
                _locallyCancelledOperationId: change === 'local-cancel' ? f.status.operationId : null,
                _syncVisibility() {}, _installHudChrome() {}, _readProtocolFileSync: () => null,
                _cancelNativeEndSessionOnce() {},
                _statusFile: {load_contents_async(_cancel, callback) { callback(this, {}); },
                    load_contents_finish() { return [true, new TextEncoder().encode(JSON.stringify(raw))]; }},
            });
            for (const method of ['setAwaitingPrepared', 'setShutdownCountdown', 'setHandoffStarted'])
                f.extension._hud[method] = () => decorated.push(method);
            f.extension._loadStatus();
            assert.equal(f.extension._lastGoodStatus.cancelled, raw.cancelled, `${overlay}/${change}`);
            assert.deepEqual(decorated, [], `${overlay}/${change}`);
            if (['cancelled', 'failed', 'failed-stage'].includes(change)) {
                assert.equal(f.extension._commitWrittenOperationId, null, `${overlay}/${change}`);
                assert.equal(f.extension._renderAckWrittenOperationId, null, `${overlay}/${change}`);
            }
            assert.equal(f.handoffs(), 0);
        }
    }
});

test('settled failed backend does not display pending recovery on repeated publication', () => {
    const f = fixture();
    const raw = {schema_version: 1, mode: 'shutdown', session_id: 'session',
        operation_id: f.status.operationId, operation_context: f.status.operationContext,
        shutdown_origin: 'preflight', shutdown_action: 'poweroff',
        started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
        overall_state: 'failed', overall_message: 'HUD did not commit', error_log_path: null,
        operation_state: 'failed', recovery_pending: false, cancelled: false,
        stages: [{id: 'proof', state: 'failed', message: 'No commit received'},
            {id: 'social-apps-save', state: 'pending', message: 'Not started'}]};
    const notices = [];
    Object.assign(f.extension, {
        _loadSerial: 0, _preflightOperationId: f.status.operationId, _preflightAction: 'poweroff',
        _syncVisibility() {}, _installHudChrome() {}, _readProtocolFileSync: () => null,
        _cancelNativeEndSessionOnce() {},
        _statusFile: {load_contents_async(_cancel, callback) { callback(this, {}); },
            load_contents_finish() { return [true, new TextEncoder().encode(JSON.stringify(raw))]; }},
    });
    f.extension._hud.setTransportNotice = message => notices.push(message);
    f.extension._loadStatus();
    assert.equal(f.extension._isLocallyCancelled(f.extension._lastGoodStatus), true);
    f.extension._loadStatus();
    assert.ok(notices.length > 0);
    assert.ok(notices.every(message => !message.includes('recovery remains pending')));
    assert.equal(f.handoffs(), 0);
});

test('cancelled completion renders cancellation rather than readiness', () => {
    const {LoginHud} = runInNewContext(
        source +
            '\n;({LoginHud});', {
            GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
        });
    for (const overallState of ['ready', 'degraded', 'failed']) {
        const hud = Object.assign(Object.create(LoginHud.prototype), {
            _kicker: {}, _title: {}, _overall: {}, _overallProgressLabel: {},
            scheduleProgressFill() {}, _renderTabs() {}, _renderContent() {},
            _renderActions() {}, _refreshElapsed() {}, _renderNotice() {},
        });
        hud.setStatus({mode: 'shutdown', cancelled: true, overallState,
            overallMessage: 'Prepared jobs recovered', stages: []});
        assert.equal(hud._title.text, 'System shutdown cancelled');
        assert.equal(hud._overall.text, 'System shutdown: Prepared jobs recovered');
    }
});

test('five visible seconds begin only after the completed HUD frame is painted', () => {
    const f = fixture();
    f.extension._startShutdownCountdown(f.status);
    assert.equal(f.timers.length, 0);
    assert.equal(f.commits(), 0);
    f.paints[0]();
    f.clock(4.9);
    f.timers[0]();
    assert.equal(f.commits(), 0);
    f.clock(5.1);
    f.timers[0]();
    assert.equal(f.commits(), 1);
    assert.equal(f.handoffs(), 0); // Still needs the backend's exact prepared proof.
});

test('readiness lost before paint can schedule a fresh acknowledgement after recovery', () => {
    const f = fixture();
    f.extension._scheduleRenderedShutdownAck(f.status);
    f.timers[0]();
    f.status.overallState = 'running';
    f.paints[0]();
    assert.equal(f.commits(), 0);
    f.status.overallState = 'ready';
    f.extension._scheduleRenderedShutdownAck(f.status);
    assert.equal(f.timers.length, 2);
});

test('readiness regression after acknowledgement restarts a complete painted countdown', () => {
    const f = fixture();
    f.extension._scheduleRenderedShutdownAck(f.status);
    f.timers[0]();
    f.paints[0]();
    f.status.overallState = 'running';
    f.extension._scheduleRenderedShutdownAck(f.status);
    f.status.overallState = 'ready';
    f.extension._scheduleRenderedShutdownAck(f.status);
    assert.equal(f.timers.length, 2);
    assert.equal(f.extension._commitWrittenOperationId, undefined);
});

test('hide, lock, greeter or lost allocation cannot silently finish a countdown', () => {
    for (const change of [f => { f.extension._hud.visible = false; },
        f => { f.sessionMode.isLocked = true; }, f => { f.sessionMode.isGreeter = true; },
        f => { f.panel.mapped = false; }, f => { f.panel.width = 0; }]) {
        const f = fixture();
        f.extension._startShutdownCountdown(f.status);
        f.paints[0]();
        change(f);
        f.clock(10);
        f.timers[0]();
        assert.equal(f.cancels(), 1);
        assert.equal(f.commits(), 0);
        assert.equal(f.handoffs(), 0);
    }
});

test('hiding before first countdown paint cancels without creating a timer', () => {
    const f = fixture();
    f.extension._startShutdownCountdown(f.status);
    f.extension._hud.visible = false;
    f.paints[0]();
    assert.equal(f.timers.length, 0);
    assert.equal(f.cancels(), 1);
});

test('a hidden HUD cannot commit even if called directly', () => {
    const f = fixture();
    f.extension._hud.visible = false;
    f.extension._commitShutdown(f.status);
    assert.equal(f.commits(), 0);
    assert.equal(f.cancels(), 1);
});

test('prepared marker cannot bypass hidden or newly failed current status', () => {
    for (const change of [f => { f.extension._hud.visible = false; },
        f => { f.extension._lastGoodStatus = {...f.status, overallState: 'failed'}; }]) {
        const f = fixture();
        f.extension._commitWrittenOperationId = f.status.operationId;
        change(f);
        f.extension._handoffToGnome(f.status);
        assert.equal(f.handoffs(), 0);
        assert.equal(f.cancels(), 1);
    }
});

test('visible ready status with matching commit permits exactly one native handoff', () => {
    const f = fixture();
    f.extension._commitWrittenOperationId = f.status.operationId;
    f.extension._handoffToGnome(f.status);
    f.extension._handoffToGnome(f.status);
    assert.equal(f.handoffs(), 1);
});


test('local cancellation releases input and fences late ready status despite backend silence', () => {
    const f = fixture();
    delete f.extension._requestCancel;
    Object.assign(f.extension, {_cancelFile: {}, _modalGrab: {},
        _cancelNativeEndSessionOnce() {}, _cancelRequestPending: false});
    assert.equal(f.extension._requestCancel(f.status), true);
    assert.equal(f.modalPops(), 1);
    assert.equal(f.extension._modalGrab, null);
    const written = f.commits();
    f.extension._syncModal();
    f.extension._commitShutdown({...f.status});
    f.extension._handoffToGnome({...f.status});
    assert.equal(f.commits(), written);
    assert.equal(f.handoffs(), 0);
    assert.equal(f.extension._hud.visible, true);
});

test('a failed cancel write still releases input and removes local commit authority', () => {
    const f = fixture(); delete f.extension._requestCancel;
    Object.assign(f.extension, {_cancelFile: {}, _modalGrab: {},
        _cancelNativeEndSessionOnce() {},
        _writeProtocolFile() { throw new Error('disk unavailable'); }});
    f.extension._requestCancel(f.status);
    assert.equal(f.modalPops(), 1);
    assert.equal(f.extension._shutdownStatusReady(f.status), false);
    f.extension._syncModal();
});

test('legacy and expired contexts never authorize shutdown handoff', () => {
    const f = fixture();
    assert.equal(f.extension._shutdownStatusReady({...f.status, operationContext: null}), false);
    f.clock(1001);
    assert.equal(f.extension._shutdownStatusReady(f.status), false);
});

test('old enable-epoch status completion cannot replace a new HUD even with colliding serial', () => {
    const f = fixture();
    let complete;
    const cancellable = {};
    Object.assign(f.extension, {_loadSerial: 0, _cancellable: cancellable,
        _statusFile: {load_contents_async(received, callback) {
            assert.equal(received, cancellable); complete = callback;
        }, load_contents_finish() { assert.fail('old callback must not finish into new epoch'); }},
    });
    f.extension._loadStatus();
    f.extension._enableEpoch = {}; f.extension._loadSerial = 1;
    complete(f.extension._statusFile, {});
    assert.equal(f.extension._lastGoodStatus, f.status);
});

test('old paint callbacks cannot acknowledge a new enable or a newer operation attempt', () => {
    for (const change of [f => { f.extension._enableEpoch = {}; }, f => {
        f.extension._lastGoodStatus = {...f.status,
            operationContext: {...f.status.operationContext, attempt: 2}};
    }]) {
        const f = fixture();
        f.extension._scheduleRenderedShutdownAck(f.status); f.timers[0]();
        change(f);
        f.extension._renderAckScheduledOperationId = f.status.operationId;
        f.paints[0]();
        assert.equal(f.commits(), 0);
        assert.equal(f.extension._renderAckScheduledOperationId, f.status.operationId);
    }
});

test('authorization markers echo exact operation context and old attempts cannot commit', () => {
    const f = fixture(); const markers = [];
    f.extension._writeProtocolFile = (_file, _prefix, payload) => markers.push(payload);
    f.extension._scheduleRenderedShutdownAck(f.status); f.timers[0](); f.paints[0]();
    assert.equal(markers[0].operation_context, f.status.operationContext);
    f.extension._commitShutdown(f.status);
    assert.equal(markers[1].operation_context, f.status.operationContext);
    f.extension._lastGoodStatus = {...f.status, operationContext: {...f.status.operationContext, attempt: 2}};
    f.extension._commitWrittenOperationId = null;
    f.extension._commitShutdown(f.status);
    assert.equal(markers.length, 2);
    f.extension._commitWrittenOperationId = f.status.operationId;
    f.extension._handoffToGnome(f.status); assert.equal(f.handoffs(), 0);
});


test('failed or cancelled shutdown report closes and fences late ready updates', () => {
    for (const change of [status => { status.overallState = 'failed'; },
        status => { status.cancelled = true; },
        status => { status.stages = [{state: 'failed'}, {state: 'running'}]; }]) {
        const f = fixture();
        change(f.status);
        f.extension._modalGrab = {};
        f.extension._dismissHud();
        assert.equal(f.extension._dismissed, true);
        assert.equal(f.extension._hud.visible, false);
        assert.equal(f.modalPops(), 1);
        assert.equal(f.cancels(), 0);
        assert.equal(f.commits(), 0);
        const late = {...f.status, overallState: 'ready', cancelled: false, stages: [{state: 'ready'}]};
        assert.equal(f.extension._hasShutdownAuthority(late), false);
        f.extension._lastGoodStatus = late;
        f.extension._syncVisibility();
        assert.equal(f.extension._hud.visible, false);
        f.extension._commitShutdown(late);
        assert.equal(f.commits(), 0);
    }
});

test('Escape closes a failed shutdown report but requests cancellation of active shutdown', () => {
    for (const failed of [true, false]) {
        const f = fixture();
        f.status.overallState = failed ? 'failed' : 'running';
        assert.equal(f.extension._handleHudKeyPress({get_key_symbol: () => 'Escape'}), 'stop');
        assert.equal(f.cancels(), failed ? 0 : 1);
        assert.equal(f.extension._hud.visible, !failed);
    }
    const f = fixture();
    assert.equal(f.extension._handleHudKeyPress({get_key_symbol: () => 'A'}), 'propagate');
    assert.equal(f.cancels(), 0);
    f.status.mode = 'startup';
    assert.equal(f.extension._handleHudKeyPress({get_key_symbol: () => 'Escape'}), 'propagate');
    assert.equal(f.extension._hud.visible, true);
});

test('failed shutdown actions offer logs and dismissal while recovery can continue', () => {
    class Actor {
        constructor(props) { Object.assign(this, props); }
        connect(_signal, callback) { this.activate = callback; }
    }
    const {LoginHud} = runInNewContext(
        source +
            '\n;({LoginHud});', {
            GObject: {registerClass: cls => cls},
            St: {Widget: class {}, Button: Actor, Label: Actor}, Extension: class {},
        });
    for (const recovering of [false, true]) {
        const actions = [];
        let closed = 0;
        const hud = Object.assign(Object.create(LoginHud.prototype), {
            scheduleProgressFill() {}, _onCloseRequested() { closed++; },
            _actions: {destroy_all_children() {}, add_child(actor) { actions.push(actor); }},
        });
        hud._renderActions({mode: 'shutdown', overallState: 'failed', cancelled: true,
            stages: [{state: 'failed'}, {state: recovering ? 'running' : 'ready'}]});
        assert.ok(actions.some(actor => actor.label === 'Show full error log'));
        const button = actions.find(actor => actor.label === (recovering ? 'Hide (recovery continues)' : 'Close'));
        assert.ok(button);
        button.activate();
        assert.equal(closed, 1);
    }
});

test('settled failure offers Close even with unstarted categories, while recovery ownership stays visible', () => {
    class Actor {
        constructor(props) { Object.assign(this, props); }
        connect(_signal, callback) { this.activate = callback; }
    }
    const {LoginHud} = runInNewContext(
        source +
            '\n;({LoginHud});', {
            GObject: {registerClass: cls => cls},
            St: {Widget: class {}, Button: Actor, Label: Actor}, Extension: class {},
        });
    for (const [operationState, recoveryPending, expected] of [
        ['failed', false, 'Close'], ['cancelled', false, 'Close'],
        ['recovering', true, 'Hide (recovery continues)'],
        ['recovery-failed', true, 'Hide (recovery continues)'],
    ]) {
        const actions = [];
        const hud = Object.assign(Object.create(LoginHud.prototype), {
            scheduleProgressFill() {},
            _actions: {destroy_all_children() {}, add_child(actor) { actions.push(actor); }},
        });
        hud._renderActions({mode: 'shutdown', overallState: 'failed', cancelled: true,
            operationState, recoveryPending,
            operationContext: {boot_id: 'boot', login_generation: 'session', operation_id: 'a'.repeat(32),
                mode: 'shutdown', attempt: 1, deadline: 100},
            stages: [{state: 'failed'}, {state: 'pending'}]});
        assert.ok(actions.some(actor => actor.label === expected), operationState);
    }
});


function startupFixture() {
    const f = fixture();
    Object.assign(f.status, {mode: 'startup', overallState: 'running', operationState: 'running',
        showOnStartup: true, startedAt: '2026-01-01T00:00:00Z'});
    f.status.operationContext = {...f.status.operationContext, mode: 'startup'};
    const receipts = []; const pending = []; const notices = [];
    Object.assign(f.extension, {_startupAbortFile: {}, _startupAbortPending: false,
        _readProtocolFileSync: () => null,
        _writeProtocolFile(file, prefix, receipt) { receipts.push({file, prefix, receipt}); }});
    f.extension._hud.setStartupAbortPending = value => pending.push(value);
    f.extension._hud.setTransportNotice = value => notices.push(value);
    return {...f, receipts, pending, notices};
}

test('startup abort writes one exact receipt, leaves shutdown authority untouched and waits for backend', () => {
    const f = startupFixture();
    assert.equal(f.extension._requestStartupAbort(f.status), true);
    assert.equal(f.extension._requestStartupAbort(f.status), true);
    assert.equal(f.receipts.length, 1);
    const {file, prefix, receipt} = f.receipts[0];
    assert.equal(file, f.extension._startupAbortFile);
    assert.equal(prefix, 'startup-abort');
    assert.equal(receipt.schema_version, 1); assert.equal(receipt.mode, 'startup');
    assert.equal(receipt.session_id, 'session'); assert.equal(receipt.operation_id, f.status.operationId);
    assert.equal(receipt.operation_context, f.status.operationContext);
    assert.ok(Number.isFinite(Date.parse(receipt.requested_at)));
    assert.equal(f.status.cancelled, false); assert.equal(f.status.overallState, 'running');
    assert.equal(f.extension._locallyCancelledOperationId, undefined);
    assert.equal(f.handoffs(), 0);
    assert.deepEqual(f.pending, [true, true]);
});

test('startup abort failed write stays active and a later click can retry', () => {
    const f = startupFixture();
    const writer = f.extension._writeProtocolFile;
    f.extension._writeProtocolFile = () => { throw Error('read-only runtime'); };
    assert.equal(f.extension._requestStartupAbort(f.status), false);
    assert.equal(f.extension._startupAbortPending, false);
    assert.deepEqual(f.pending, []);
    assert.match(f.notices[0], /Restoration continues.*read-only runtime/);
    f.extension._writeProtocolFile = writer;
    assert.equal(f.extension._requestStartupAbort(f.status), true);
    assert.equal(f.receipts.length, 1);
});

test('startup abort refuses completed, cancelled, stale, expired and foreign operations', () => {
    for (const changes of [{overallState: 'ready', operationState: null}, {overallState: 'failed', operationState: null}, {cancelled: true},
        {operationState: 'cancelled'}, {operationState: 'cancelling'}, {mode: 'shutdown'},
        {sessionId: 'other'}, {operationId: null}, {operationContext: null},
        {operationContext: {boot_id: 'other'}}, {operationContext: {deadline: 0}}]) {
        const f = startupFixture();
        const status = {...f.status, ...changes};
        assert.equal(f.extension._requestStartupAbort(status), false, JSON.stringify(changes));
        assert.equal(f.receipts.length, 0);
    }
});

test('startup abort preserves existing matching receipt across reload without rewriting it', () => {
    const f = startupFixture();
    f.extension._readProtocolFileSync = () => ({schema_version: 1, mode: 'startup',
        session_id: 'session', operation_id: f.status.operationId,
        operation_context: {...f.status.operationContext}});
    assert.equal(f.extension._requestStartupAbort(f.status), true);
    assert.equal(f.receipts.length, 0); assert.equal(f.extension._startupAbortPending, true);
});

test('background hides startup while reopen removes only its matching dismissal without restarting', () => {
    const f = startupFixture(); let deleted = 0;
    f.extension._dismissedFile = {delete() { deleted++; }};
    f.extension._installHudChrome = () => {};
    assert.equal(f.extension._backgroundStartup(), true);
    assert.equal(f.extension._hud.visible, false);
    assert.equal(f.receipts[0].receipt.reason, 'background');
    assert.equal(f.status.overallState, 'running');
    f.extension._startupDismissalMatches = () => true;
    assert.equal(f.extension._showStartupStatus(), true);
    assert.equal(deleted, 1); assert.equal(f.extension._hud.visible, true);
    f.extension._startupDismissalMatches = () => false;
    f.status.overallState = 'degraded'; f.status.cancelled = true; f.status.showOnStartup = false;
    f.extension._dismissed = true;
    assert.equal(f.extension._showStartupStatus(), true);
    assert.equal(deleted, 1); assert.equal(f.extension._hud.visible, true);
    f.status.mode = 'shutdown';
    assert.equal(f.extension._backgroundStartup(), false);
    assert.equal(f.extension._showStartupStatus(), false);
    f.status.mode = 'startup'; f.sessionMode.isLocked = true;
    assert.equal(f.extension._showStartupStatus(), false);
    assert.equal(f.receipts.length, 1);
});

test('failed reopen deletion leaves matching background dismissal intact', () => {
    const f = startupFixture(); f.extension._dismissed = true;
    f.extension._startupDismissalMatches = () => true;
    f.extension._dismissedFile = {delete() { throw Error('storage unavailable'); }};
    assert.equal(f.extension._showStartupStatus(), false);
    assert.equal(f.extension._dismissed, true);
    assert.equal(f.receipts.length, 0);
});

test('startup parser retains operation identity and exact context', () => {
    const f = startupFixture();
    const parsed = f.normaliseStatus({schema_version: 1, mode: 'startup', session_id: 'session',
        operation_id: f.status.operationId, operation_context: f.status.operationContext,
        started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
        overall_state: 'degraded', overall_message: 'Stopped', cancelled: true,
        operation_state: 'cancelled', error_log_path: null, stages: []});
    assert.equal(parsed.operationId, f.status.operationId);
    assert.equal(parsed.operationState, 'cancelled'); assert.equal(parsed.cancelled, true);
    assert.equal(parsed.operationContext.mode, 'startup');
});


test('startup actions expose accessible abort and background controls then disable pending abort', () => {
    class Actor {
        constructor(props) { Object.assign(this, props); }
        connect(_signal, callback) { this.click = callback; }
    }
    const {LoginHud} = runInNewContext(source + '\n;({LoginHud});', {
        GObject: {registerClass: cls => cls}, St: {Widget: class {}, Button: Actor, Label: Actor},
        Extension: class {},
    });
    const children = []; let aborts = 0; let backgrounds = 0;
    const hud = Object.assign(Object.create(LoginHud.prototype), {
        _actions: {destroy_all_children() { children.length = 0; }, add_child(child) { children.push(child); }},
        scheduleProgressFill() {}, _onStartupAbortRequested() { aborts++; },
        _onBackgroundRequested() { backgrounds++; },
    });
    const f = startupFixture(); const status = f.status;
    hud._renderActions(status);
    assert.deepEqual(children.map(child => child.label), ['Abort restoration', 'Run in background']);
    assert.ok(children.every(child => child.can_focus && child.accessible_name));
    children[0].click(); children[1].click();
    assert.equal(aborts, 1); assert.equal(backgrounds, 1);
    hud._startupAbortPending = true; hud._renderActions(status);
    assert.equal(children[0].label, 'Abort requested…'); assert.equal(children[0].reactive, false);
    assert.equal(children[1].reactive, true);
    assert.equal(hud._primaryAction, children[1]);
    for (const fields of [{cancelled: true, operationState: 'cancelled', overallState: 'degraded'},
        {operationState: 'completed', overallState: 'ready'}, {overallState: 'failed', operationState: null}]) {
        hud._renderActions({...status, ...fields});
        assert.ok(children.every(child => !child.label.includes('Abort') && child.label !== 'Run in background'));
    }
});

test('cancelled startup renders restoration stopped with preserved applications', () => {
    const {LoginHud} = runInNewContext(source + '\n;({LoginHud});', {
        GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
    });
    const hud = Object.assign(Object.create(LoginHud.prototype), {
        _kicker: {}, _title: {}, _overall: {}, _overallProgressLabel: {},
        scheduleProgressFill() {}, _renderTabs() {}, _renderContent() {},
        _renderActions() {}, _refreshElapsed() {}, _renderNotice() {},
    });
    hud.setStatus({...startupFixture().status, cancelled: true,
        operationState: 'cancelled', overallState: 'degraded', stages: []});
    assert.equal(hud._title.text, 'Restoration stopped');
    assert.match(hud._overall.text, /Applications already opened are preserved/);
    assert.doesNotMatch(hud._title.text, /ready/);
});

test('startup status reload restores pending receipt then clears it on backend terminal report', () => {
    const f = startupFixture(); let raw = {schema_version: 1, mode: 'startup', session_id: 'session',
        operation_id: f.status.operationId, operation_context: f.status.operationContext,
        started_at: f.status.startedAt, updated_at: '2026-01-01T00:00:01Z',
        overall_state: 'failed', overall_message: 'Browser failed; other work continues', operation_state: 'running',
        error_log_path: null, stages: [{id: 'app', state: 'running', message: 'Restoring'}]};
    const receipt = {schema_version: 1, mode: 'startup', session_id: 'session',
        operation_id: f.status.operationId, operation_context: f.status.operationContext};
    Object.assign(f.extension, {_loadSerial: 0, _activeSessionId: 'session', _activeMode: 'startup',
        _activeStartedAt: raw.started_at, _preflightOperationId: null,
        _startupDismissalMatches: () => false, _startupPresentationIsStale: () => false,
        _loadAlerts() {}, _loadGcProfiles() {}, _installHudChrome() {}, _handleTerminalShutdownStatus() {},
        _readProtocolFileSync: file => file === f.extension._startupAbortFile ? receipt : null,
        _statusFile: {load_contents_async(_cancel, callback) { callback(this, {}); },
            load_contents_finish() { return [true, new TextEncoder().encode(JSON.stringify(raw))]; }},
    });
    f.extension._loadStatus();
    assert.equal(f.extension._startupAbortPending, true);
    assert.equal(f.extension._lastGoodStatus.cancelled, false);
    raw = {...raw, operation_state: 'cancelled', cancelled: true, overall_state: 'degraded'};
    f.extension._loadStatus();
    assert.equal(f.extension._startupAbortPending, false);
    assert.equal(f.extension._lastGoodStatus.cancelled, true);
    assert.equal(f.notices.length, 0);
    assert.equal(f.receipts.length, 0);
});


test('category failure leaves abort and background available while startup coordinator is running', () => {
    class Actor {
        constructor(props) { Object.assign(this, props); }
        connect(_signal, callback) { this.click = callback; }
    }
    const {LoginHud, startupRestorationTerminal} = runInNewContext(
        source + '\n;({LoginHud, startupRestorationTerminal});', {
            GObject: {registerClass: cls => cls}, St: {Widget: class {}, Button: Actor, Label: Actor},
            Extension: class {},
        });
    for (const overallState of ['failed', 'degraded', 'ready']) {
        const f = startupFixture();
        Object.assign(f.status, {overallState, stages: [{state: 'failed'}, {state: 'running'}]});
        const children = [];
        const hud = Object.assign(Object.create(LoginHud.prototype), {
            _actions: {destroy_all_children() { children.length = 0; }, add_child(child) { children.push(child); }},
            scheduleProgressFill() {},
        });
        hud._renderActions(f.status);
        assert.equal(startupRestorationTerminal(f.status), false);
        assert.equal(children[0].label, 'Abort restoration'); assert.equal(children[0].reactive, true);
        assert.equal(children[1].label, 'Run in background'); assert.equal(children[1].reactive, true);
        assert.equal(f.extension._startupCanAutoDismiss(f.status), false);
        assert.equal(f.extension._requestStartupAbort(f.status), true);
        assert.equal(f.receipts.length, 1);
        f.status.operationState = 'cancelling'; hud._renderActions(f.status);
        assert.equal(startupRestorationTerminal(f.status), false);
        assert.equal(children[0].label, 'Abort requested…'); assert.equal(children[0].reactive, false);
        assert.equal(children[1].label, 'Run in background'); assert.equal(children[1].reactive, true);
        for (const operationState of ['completed', 'failed', 'cancelled']) {
            f.status.operationState = operationState; hud._renderActions(f.status);
            assert.equal(startupRestorationTerminal(f.status), true);
            assert.ok(children.every(child => !['Abort restoration', 'Abort requested…', 'Run in background'].includes(child.label)));
        }
    }
});


test('status action rebuild preserves keyboard focus and moves pending abort focus to background', () => {
    let focus = null; let focused = 0;
    const children = [];
    class Actor {
        constructor(props) { Object.assign(this, props); }
        connect(_signal, callback) { this.click = callback; }
        grab_key_focus() { focus = this; focused++; }
        contains(actor) { return this.child === actor; }
    }
    const {LoginHud} = runInNewContext(source + '\n;({LoginHud});', {
        GObject: {registerClass: cls => cls}, St: {Widget: class {}, Button: Actor, Label: Actor},
        Extension: class {},
    });
    const hud = Object.assign(Object.create(LoginHud.prototype), {
        _actions: {
            get_stage: () => ({get_key_focus: () => focus}), get_children: () => children,
            destroy_all_children() {
                if (children.some(actor => actor === focus || actor.contains(focus)))
                    focus = null;
                children.length = 0;
            },
            add_child(actor) { children.push(actor); },
        },
        scheduleProgressFill() {},
    });
    const status = startupFixture().status;
    hud._renderActions(status);
    assert.equal(focused, 0);
    for (const key of ['startup-abort', 'startup-background']) {
        focus = children.find(actor => actor._loginHudAction === key);
        const previous = focus;
        hud._renderActions({...status, operationContext: {...status.operationContext,
            attempt: key === 'startup-abort' ? 2 : 3}});
        assert.notEqual(focus, previous);
        assert.equal(focus._loginHudAction, key);
    }
    focus = children.find(actor => actor._loginHudAction === 'startup-abort');
    focus.child = {}; focus = focus.child;
    hud._startupAbortPending = true;
    hud._renderActions(status);
    assert.equal(focus._loginHudAction, 'startup-background');
    assert.equal(focus.reactive, true);
    const elsewhere = {name: 'another HUD or desktop actor'};
    focus = elsewhere; const grabs = focused;
    hud._renderActions({...status, overallState: 'failed', stages: [{state: 'failed'}, {state: 'running'}]});
    assert.equal(focus, elsewhere); assert.equal(focused, grabs);
    focus = children.find(actor => actor._loginHudAction === 'error-log');
    hud._renderActions({...status, overallState: 'failed', stages: [{state: 'failed'}]});
    assert.equal(focus._loginHudAction, 'error-log');
});


function actionReuseFixture() {
    let focus = null; let destroyed = 0;
    const children = []; const callbacks = [];
    class Actor {
        constructor(props) { Object.assign(this, props); }
        connect(_signal, callback) { this.click = callback; }
        grab_key_focus() { focus = this; }
        contains(actor) { return this === actor; }
        press() { this.pressed = true; }
        release() { if (this.pressed && !this.destroyed && this.reactive) this.click(); }
    }
    const {LoginHud} = runInNewContext(source + '\n;({LoginHud});', {
        GObject: {registerClass: cls => cls}, St: {Widget: class {}, Button: Actor, Label: Actor},
        Extension: class {},
    });
    const hud = Object.assign(Object.create(LoginHud.prototype), {
        _actions: {
            get_stage: () => ({get_key_focus: () => focus}), get_children: () => children,
            destroy_all_children() {
                for (const actor of children) { actor.destroyed = true; destroyed++; }
                if (children.includes(focus)) focus = null;
                children.length = 0;
            }, add_child(actor) { children.push(actor); },
        }, scheduleProgressFill() {},
        _onStartupAbortRequested(status) { callbacks.push(status); },
    });
    return {hud, children, callbacks, focus: () => focus, destroyed: () => destroyed};
}

test('startup buttons survive progress publications and press-release uses the latest status', () => {
    const f = actionReuseFixture(); const status = startupFixture().status;
    f.hud._renderActions(status);
    const original = [...f.children]; const primary = f.hud._primaryAction;
    original[0].grab_key_focus(); original[0].press();
    const latest = {...status, overallMessage: 'Verified another application',
        stages: [{state: 'running', message: 'Progress changed', fraction: .5}]};
    f.hud._renderActions(latest);
    assert.deepEqual(f.children, original);
    assert.equal(f.destroyed(), 0); assert.equal(f.hud._primaryAction, primary);
    assert.equal(f.focus(), original[0]);
    original[0].release();
    assert.equal(f.callbacks.length, 1); assert.equal(f.callbacks[0], latest);
});

test('startup action actors rebuild for authority, pending, failure, log-target and terminal changes', () => {
    const base = startupFixture().status;
    const mutations = [
        status => ({...status, operationContext: {...status.operationContext, attempt: 2}}),
        status => ({...status, operationContext: {...status.operationContext, deadline: 2000}}),
        status => ({...status, operationId: 'b'.repeat(32)}),
        status => ({...status, sessionId: 'new-login'}),
        status => ({...status, operationState: 'cancelling'}),
        status => ({...status, overallState: 'failed', stages: [{state: 'failed'}]}),
        status => ({...status, errorLogPath: '/tmp/new-synthetic-error.log'}),
        status => ({...status, overallState: 'degraded', operationState: 'cancelled', cancelled: true}),
    ];
    for (const mutate of mutations) {
        const f = actionReuseFixture(); f.hud._renderActions(base);
        const old = [...f.children]; f.hud._renderActions(mutate(base));
        assert.ok(old.every(actor => actor.destroyed));
        assert.ok(f.children.every(actor => !old.includes(actor)));
    }
    const f = actionReuseFixture(); f.hud._renderActions(base);
    const old = f.children[0]; f.hud.setStartupAbortPending(true);
    assert.equal(old.destroyed, true); assert.equal(f.children[0].reactive, false);
});

test('running failed startup reuses its log and actions while shutdown always rebuilds', () => {
    const f = actionReuseFixture(); const base = {...startupFixture().status,
        overallState: 'failed', stages: [{state: 'failed'}, {state: 'running'}],
        errorLogPath: '/tmp/synthetic-error.log'};
    f.hud._renderActions(base);
    const first = [...f.children]; const primary = f.hud._primaryAction;
    f.hud._renderActions({...base, stages: [{state: 'failed', message: 'Same failure'},
        {state: 'running', message: 'Another application is waiting'}]});
    assert.deepEqual(f.children, first); assert.equal(f.hud._primaryAction, primary);
    let log = null; f.hud._onOpenLogRequested = path => { log = path; };
    f.children.find(actor => actor._loginHudAction === 'error-log').click();
    assert.equal(log, '/tmp/synthetic-error.log');
    const shutdown = fixture().status;
    f.hud._renderActions(shutdown); const cancel = f.children[0];
    f.hud._renderActions(shutdown);
    assert.notEqual(f.children[0], cancel); assert.equal(cancel.destroyed, true);
    f.hud._renderActions(base);
    assert.ok(f.children.every(actor => !first.includes(actor)));
});
