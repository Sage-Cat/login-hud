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
    extension.uuid = 'test-hud'; extension.metadata = {version: 18};
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
    assert.deepEqual(state.build, {uuid: 'test-hud', version: 18, revision: 'development', sourceIdentityKnown: false});
    f.extension.disable(); f.extension.enable();
    assert.notEqual(f.extension._enableEpoch, epoch);
    assert.equal(f.extension._ownsEpoch(epoch), false);
    f.extension.disable();
});

test('supplied operation context is complete, finite, immutable and consistent with status', () => {
    const f = fixture();
    const valid = {boot_id: 'boot', login_generation: 'session', operation_id: 'operation',
        mode: 'shutdown', attempt: 1, deadline: 100};
    assert.equal(f.operationContext(undefined, 'shutdown', 'operation'), null);
    const context = f.operationContext(valid, 'shutdown', 'operation');
    assert.equal(Object.isFrozen(context), true);
    for (const changed of [{attempt: 0}, {attempt: 1.5}, {deadline: Infinity}, {deadline: 0},
        {boot_id: ''}, {mode: 'startup'}, {operation_id: 'other'}, {extra: true}])
        assert.throws(() => f.operationContext({...valid, ...changed}, 'shutdown', 'operation'));
    const missing = {...valid}; delete missing.login_generation;
    assert.throws(() => f.operationContext(missing, 'shutdown', 'operation'));
    assert.throws(() => f.operationContext(null, 'shutdown', 'operation'));
});

test('diagnostics distinguish withdrawn authorization from scoped backend recovery ownership', () => {
    const f = fixture(); f.extension.enable();
    const operationId = 'a'.repeat(32);
    const context = {boot_id: 'boot', login_generation: 'session', operation_id: operationId,
        mode: 'shutdown', attempt: 1, deadline: 100};
    const base = {schema_version: 1, mode: 'shutdown', session_id: 'session', operation_id: operationId,
        operation_context: context, shutdown_action: 'poweroff', shutdown_origin: 'preflight',
        started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z',
        overall_state: 'failed', overall_message: 'Shutdown stopped', error_log_path: null,
        stages: [{id: 'checkpoint-proof', state: 'failed', message: 'Stopped'},
            {id: 'social-apps-save', state: 'pending', message: 'Not started'}]};
    f.extension._locallyCancelledOperationId = operationId;
    for (const [fields, expected] of [
        [{operation_state: 'failed', recovery_pending: false}, false],
        [{operation_state: 'completed', recovery_pending: false}, false],
        [{operation_state: 'cancelled', recovery_pending: false, cancelled: true}, false],
        [{operation_state: 'recovering', recovery_pending: true, cancelled: true}, true],
        [{operation_state: 'recovery-failed', recovery_pending: true}, true],
        [{operation_state: 'failed', recovery_pending: true}, true],
        [{operation_state: 'recovering', recovery_pending: false}, true],
        // A prepared publication cannot acknowledge a later local cancel.
        [{operation_state: 'prepared', recovery_pending: false}, true],
        [{}, true],
        [{operation_state: 'unknown', recovery_pending: false}, true],
        [{operation_state: 'failed', recovery_pending: 'false'}, true],
        [{operation_state: 'failed', recovery_pending: false, operation_context: undefined}, true],
        [{operation_state: 'cancelled', recovery_pending: false,
            operation_context: undefined, cancelled: true}, true],
    ]) {
        f.extension._lastGoodStatus = f.normaliseStatus({...base, ...fields});
        const state = JSON.parse(f.diagnostics().GetState());
        assert.equal(state.local_cancelled, true);
        assert.equal(state.recovery_pending, expected, JSON.stringify(fields));
    }
    f.extension._lastGoodStatus = f.normaliseStatus({...base,
        operation_id: 'b'.repeat(32), operation_context: {...context, operation_id: 'b'.repeat(32)},
        overall_state: 'ready', stages: [{id: 'checkpoint-proof', state: 'ready', message: 'Verified'}],
        operation_state: 'prepared', recovery_pending: false});
    const next = JSON.parse(f.diagnostics().GetState());
    assert.equal(next.local_cancelled, false);
    assert.equal(next.recovery_pending, false);
    f.extension.disable();
});
