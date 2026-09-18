import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
function fixture() {
    let clock = 0;
    const timers = [];
    const paints = [];
    const sessionMode = {isLocked: false, isGreeter: false};
    const {LoginHudExtension} = runInNewContext(
        source.replace(/^import .*;\n/gm, '').replace('export default class', 'class') +
            '\n;({LoginHudExtension});', {
            GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {},
            Main: {sessionMode}, console: {info() {}},
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
        stages: [{state: 'ready'}], cancelled: false};
    const panel = {mapped: true, width: 800, height: 800};
    let cancels = 0;
    let commits = 0;
    let handoffs = 0;
    Object.assign(extension, {
        _lastGoodStatus: status, _activeOperationId: status.operationId,
        _hud: {visible: true, mapped: true, getInteractiveActor: () => panel,
            setTransportNotice() {}, setShutdownCountdown() {}, focusPrimaryAction() {},
            setAwaitingPrepared() {}, setHandoffStarted() {}},
        _requestCancel() { cancels++; return true; },
        _writeProtocolFile() { commits++; }, _startPreparedPolling() {}, _checkPreparedHandoff() {},
        _stopPreparedPolling() {}, _originalEndSessionConfirm() { handoffs++; },
    });
    return {extension, status, panel, sessionMode, timers, paints,
        clock(value) { clock = value; }, cancels: () => cancels, commits: () => commits, handoffs: () => handoffs};
}

test('all jobs terminal is insufficient while overall verification is running', () => {
    const f = fixture();
    f.status.overallState = 'running';
    assert.equal(f.extension._shutdownStatusReady(f.status), false);
    f.extension._commitShutdown(f.status);
    assert.equal(f.commits(), 0);
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
