import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await loadSource();

function fixture() {
    const sessionMode = {isLocked: false, isGreeter: false};
    const {LoginHudExtension, normaliseStatus} = runInNewContext(
        source +
            '\n;({LoginHudExtension, normaliseStatus});', {
            BUILD_REVISION: 'development',
            GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
            Gio: {Cancellable: class {cancel() {}}, DBus: {session: {}},
                DBusExportedObject: {wrapJSObject: () => ({export() {}, unexport() {}})}},
            Main: {sessionMode}, console: {info() {}, warn() {}, error() {}}, TextDecoder,
            global: {stage: {queue_redraw() {}}}, Clutter: {},
            GLib: {get_monotonic_time: () => 0},
        }
    );
    const extension = Object.create(LoginHudExtension.prototype);
    const operationId = 'a'.repeat(32);
    const status = {mode: 'startup', overallState: 'running', operationId,
        sessionId: 'session', operationState: 'running', stages: [{state: 'ready'}],
        cancelled: false, showOnStartup: true, startedAt: '2026-01-01T00:00:00Z',
        operationContext: {boot_id: 'boot', login_generation: 'session', operation_id: operationId,
            mode: 'startup', attempt: 1, deadline: 1000}};
    Object.assign(extension, {
        _bootId: 'boot', _currentSessionId: 'session', _enableEpoch: {},
        _lastGoodStatus: status, _activeOperationId: status.operationId,
        _hud: {visible: true, mapped: true, setTransportNotice() {}, focusPrimaryAction() {},
            resetExpansion() {}, setStartupAbortPending() {}, setStatus() {},
            scheduleProgressFill() {}, refreshVisibleGc() {}},
    });
    return {extension, status, normaliseStatus, sessionMode};
}

function startupFixture() {
    const f = fixture();
    const receipts = []; const pending = []; const notices = [];
    Object.assign(f.extension, {_startupAbortFile: {}, _startupAbortPending: false,
        _readProtocolFileSync: () => null,
        _writeProtocolFile(file, prefix, receipt) { receipts.push({file, prefix, receipt}); }});
    f.extension._hud.setStartupAbortPending = value => pending.push(value);
    f.extension._hud.setTransportNotice = value => notices.push(value);
    return {...f, receipts, pending, notices};
}

test('startup abort writes one exact receipt, waits for backend', () => {
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
        {operationState: 'cancelled'}, {operationState: 'cancelling'}, {mode: 'other'},
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
    f.status.mode = 'other';
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
        _activeStartedAt: raw.started_at,
        _startupDismissalMatches: () => false, _startupPresentationIsStale: () => false,
        _loadAlerts() {}, _loadGcProfiles() {}, _installHudChrome() {},
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

test('running failed startup reuses its log and actions across progress publications', () => {
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
});
