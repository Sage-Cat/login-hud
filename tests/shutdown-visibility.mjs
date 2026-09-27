import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
function fixture() {
    let clock = 0;
    const timers = [];
    const paints = [];
    let modalPops = 0;
    const sessionMode = {isLocked: false, isGreeter: false};
    const {LoginHudExtension} = runInNewContext(
        source.replace(/^import .*;\n/gm, '').replace('export default class', 'class') +
            '\n;({LoginHudExtension});', {
            GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
            Main: {sessionMode, popModal() { modalPops++; }, pushModal() { throw new Error("unexpected modal acquisition"); }}, console: {info() {}, warn() {}, error() {}}, TextDecoder,
            global: {stage: {queue_redraw() {}}},
            Clutter: {RepaintFlags: {POST_PAINT: 1}, threads_add_repaint_func_full(_flags, fn) { paints.push(fn); }},
            GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
                get_monotonic_time: () => clock * 1e6,
                timeout_add(_priority, _interval, fn) { timers.push(fn); return timers.length; },
                Source: {remove() {}}},
        }
    );
    const extension = Object.create(LoginHudExtension.prototype);
    const status = {mode: 'shutdown', overallState: 'ready', operationId: 'a'.repeat(32),
        sessionId: 'session', shutdownOrigin: 'preflight', shutdownAction: 'poweroff',
        stages: [{state: 'ready'}], cancelled: false,
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
            setCancellationPending() {}, setStatus() {}},
        _requestCancel() { cancels++; return true; },
        _writeProtocolFile() { commits++; }, _startPreparedPolling() {}, _checkPreparedHandoff() {},
        _stopPreparedPolling() {}, _originalEndSessionConfirm() { handoffs++; },
    });
    return {extension, status, panel, sessionMode, timers, paints,
        modalPops: () => modalPops, clock(value) { clock = value; }, cancels: () => cancels, commits: () => commits, handoffs: () => handoffs};
}

test('all jobs terminal is insufficient while overall verification is running', () => {
    const f = fixture();
    f.status.overallState = 'running';
    assert.equal(f.extension._shutdownStatusReady(f.status), false);
    f.extension._commitShutdown(f.status);
    assert.equal(f.commits(), 0);
});

test('shutdown status cannot replace the action from a confirmed request or local preflight', () => {
    for (const [binding, action] of ['request', 'local', 'both'].flatMap(binding =>
        ['restart', 'poweroff'].map(action => [binding, action]))) {
        const f = fixture();
        const raw = {schema_version: 1, mode: 'shutdown', session_id: 'session',
            operation_id: f.status.operationId, shutdown_origin: 'preflight', shutdown_action: action,
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
            assert.equal(f.extension._lastGoodStatus, null, binding);
        else
            assert.equal(f.extension._lastGoodStatus.shutdownAction, 'poweroff', binding);
        assert.equal(f.extension._preflightSignal, 'ConfirmedShutdown', binding);
        assert.equal(f.handoffs(), 0, binding);
    }
});

test('startup null identity never displays handoff while a matching shutdown still does', () => {
    for (const mode of ['startup', 'shutdown']) {
        const f = fixture();
        const operationId = mode === 'shutdown' ? f.status.operationId : null;
        const raw = {schema_version: 1, mode, session_id: 'session',
            started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
            overall_state: 'running', overall_message: 'Restoring example windows',
            error_log_path: '/tmp/example.txt', stages: [{id: 'example', state: 'running', message: 'Working'}],
            ...(mode === 'shutdown' ? {operation_id: operationId, operation_context: f.status.operationContext,
                shutdown_origin: 'preflight', shutdown_action: 'poweroff'} : {})};
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
