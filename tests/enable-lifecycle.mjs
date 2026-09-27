import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
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
    const {LoginHudExtension, operationContext} = runInNewContext(
        source.replace(/^import .*;\n/gm, '').replace('export default class', 'class') +
        '\n;({LoginHudExtension, operationContext});', context);
    const extension = new LoginHudExtension();
    extension.uuid = 'test-hud'; extension.metadata = {version: 18};
    extension._enable = () => {
        extension._sessionModeUpdatedId = 7;
        extension._hud = {visible: false, cancelDeferredUpdates() { cleanup.push('deferred'); }, destroy() { cleanup.push('destroy'); }};
    };
    return {extension, cleanup, operationContext, diagnostics: () => diagnostics};
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
