import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await loadSource();
function fixture({exportFails = false, unexportFails = false} = {}) {
    const cleanup = [];
    let diagnostics;
    const context = {
        BUILD_REVISION: 'development', TextDecoder,
        GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
        console: {warn() {}},
        Gio: {Cancellable: class {cancel() { cleanup.push('cancel'); }}, DBus: {session: {}},
            DBusExportedObject: {wrapJSObject(_xml, object) {
                diagnostics = object;
                return {export() { if (exportFails) throw new Error('export failed'); },
                    unexport() { cleanup.push('unexport'); if (unexportFails) throw new Error('unexport failed'); }};
            }}},
        GLib: {file_get_contents: () => [true, new TextEncoder().encode('boot\n')]},
        Main: {sessionMode: {disconnect() { cleanup.push('disconnect'); }}},
    };
    const {LoginHudExtension, operationContext, normaliseStatus} = runInNewContext(
        source +
        '\n;({LoginHudExtension, operationContext, normaliseStatus});', context);
    const extension = new LoginHudExtension();
    extension.uuid = 'test-hud'; extension.metadata = {version: 19};
    extension._enable = () => {
        extension._sessionModeUpdatedId = 7;
        extension._hud = {visible: false, cancelDeferredUpdates() { cleanup.push('deferred'); }, destroy() { cleanup.push('destroy'); }};
    };
    return {extension, cleanup, operationContext, normaliseStatus, diagnostics: () => diagnostics};
}

test('partial enable failure unwinds diagnostics, signals and actors despite a cleanup error', () => {
    const f = fixture({exportFails: true, unexportFails: true});
    assert.throws(() => f.extension.enable(), /export failed/);
    assert.deepEqual(f.cleanup, ['cancel', 'unexport', 'disconnect', 'deferred', 'destroy']);
    assert.equal(f.extension._enableEpoch, null);
    assert.equal(f.extension._hud, null);
});

test('enable epoch is unique and running diagnostics identify unstamped development builds', () => {
    const f = fixture(); f.extension.enable();
    const epoch = f.extension._enableEpoch;
    const state = JSON.parse(f.diagnostics().GetState());
    assert.deepEqual(state.build, {uuid: 'test-hud', version: 19, revision: 'development', sourceIdentityKnown: false});
    f.extension.disable(); f.extension.enable();
    assert.notEqual(f.extension._enableEpoch, epoch);
    assert.equal(f.extension._ownsEpoch(epoch), false);
    f.extension.disable();
});

test('supplied operation context is complete, finite, immutable and consistent with status', () => {
    const f = fixture();
    const valid = {boot_id: 'boot', login_generation: 'session', operation_id: 'operation',
        mode: 'startup', attempt: 1, deadline: 100};
    assert.equal(f.operationContext(undefined, 'startup', 'operation'), null);
    const context = f.operationContext(valid, 'startup', 'operation');
    assert.equal(Object.isFrozen(context), true);
    for (const changed of [{attempt: 0}, {attempt: 1.5}, {deadline: Infinity}, {deadline: 0},
        {boot_id: ''}, {mode: 'shutdown'}, {operation_id: 'other'}, {extra: true}])
        assert.throws(() => f.operationContext({...valid, ...changed}, 'startup', 'operation'));
    const missing = {...valid}; delete missing.login_generation;
    assert.throws(() => f.operationContext(missing, 'startup', 'operation'));
    assert.throws(() => f.operationContext(null, 'startup', 'operation'));
});

const startupDocument = (changes = {}) => ({
    schema_version: 1, mode: 'startup', session_id: 'session', operation_id: 'a'.repeat(32),
    started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
    overall_state: 'running', overall_message: 'Restoring', error_log_path: null,
    stages: [{id: 'workspace', state: 'running', message: 'Working'}], ...changes});

function loadFixture(f, document) {
    const shown = [];
    f.extension.enable();
    f.extension._currentSessionId = 'session';
    f.extension._loadSerial = 0;
    f.extension._hud.setStatus = status => shown.push(status);
    f.extension._hud.setStartupAbortPending = () => {};
    f.extension._hud.resetExpansion = () => {};
    f.extension._hud.setTransportNotice = notice => shown.push(notice);
    f.extension._installHudChrome = () => {};
    f.extension._syncVisibility = () => {};
    f.extension._statusFile = {
        load_contents_async: (_cancellable, callback) => callback({
            load_contents_finish: () => [true, new TextEncoder().encode(JSON.stringify(document))],
        }, {}),
    };
    f.extension._loadStatus();
    return shown;
}

test('a status document for any mode other than startup is ignored without a notice', () => {
    const f = fixture();
    assert.equal(f.normaliseStatus(startupDocument({mode: 'shutdown', shutdown_action: 'poweroff'})), null);
    assert.equal(f.normaliseStatus(startupDocument({mode: 'unknown'})), null);
    assert.equal(f.normaliseStatus(startupDocument({mode: 'shutdown', schema_version: 2})), null);
    assert.equal(f.normaliseStatus({mode: 'shutdown', schema_version: 'future'}), null);
    assert.throws(() => f.normaliseStatus(startupDocument({schema_version: 2})), /Unsupported status schema/);
    assert.equal(f.normaliseStatus(startupDocument({mode: 'shutdown', stages: 'malformed'})), null);
    assert.equal(f.normaliseStatus(startupDocument()).mode, 'startup');
    const {mode: _mode, ...implicit} = startupDocument();
    assert.equal(f.normaliseStatus(implicit).mode, 'startup');
    const shutdown = fixture();
    const shown = loadFixture(shutdown, startupDocument({mode: 'shutdown', shutdown_action: 'poweroff',
        shutdown_origin: 'preflight'}));
    assert.deepEqual(shown, []);
    assert.ok(!shutdown.extension._lastGoodStatus);
    shutdown.extension.disable();
});

test('a startup status is still presented', () => {
    const f = fixture();
    const shown = loadFixture(f, startupDocument());
    assert.equal(shown.length, 1);
    assert.equal(shown[0].mode, 'startup');
    assert.equal(f.extension._lastGoodStatus, shown[0]);
    f.extension.disable();
});

test('diagnostics expose only startup state', () => {
    const f = fixture(); f.extension.enable();
    const state = JSON.parse(f.diagnostics().GetState());
    assert.deepEqual(Object.keys(state).sort(),
        ['build', 'operation_context', 'startup_abort_requested', 'visible']);
    f.extension.disable();
});

test('disable destroys the startup indicator and repeated enable does not retain it', () => {
    const f = fixture(); f.extension.enable();
    let destroyed = 0;
    f.extension._startupIndicator = {destroy() { destroyed++; }};
    f.extension.disable();
    assert.equal(destroyed, 1); assert.equal(f.extension._startupIndicator, null);
    f.extension.enable(); f.extension.disable();
    assert.equal(destroyed, 1);
});


test('disable unregisters the bounded HUD keyboard focus group before destroying its actor', () => {
    const f = fixture(); f.extension.enable();
    const panel = {};
    f.extension._hud.getInteractiveActor = () => panel;
    f.extension._hudFocusManager = {remove_group(actor) {
        assert.equal(actor, panel); f.cleanup.push('remove-focus-group');
    }};
    f.extension.disable();
    assert.ok(f.cleanup.indexOf('remove-focus-group') < f.cleanup.indexOf('destroy'));
    assert.equal(f.extension._hudFocusManager, null);
});
