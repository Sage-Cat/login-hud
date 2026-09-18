import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.clutter_text = {}; }
    add_child(child) { this.children.push(child); }
    destroy_all_children() { this.children = []; }
    connect(_event, callback) { this.clicked = callback; }
}
const {normalizeGcProfiles, gcProfilePresentation, LoginHud} = runInNewContext(
    source.replace(/^import .*;\n/gm, '').replace('export default class', 'class') +
        '\n;({normalizeGcProfiles, gcProfilePresentation, LoginHud});', {
        GObject: {registerClass: cls => cls},
        St: {Widget: Actor, BoxLayout: Actor, Button: Actor, Label: Actor, Icon: Actor},
        Extension: class {}, Clutter: {ActorAlign: {END: 1}},
    }
);

const now = '2026-09-18T10:00:00.000Z';
const profile = {name: 'daily', enabled: true, state: 'ok', last_started_at: now,
    last_finished_at: now, last_success_at: now, last_failure_at: null,
    next_run_at: null, message: ''};
const payload = (changes = {}) => ({schema_version: 1, updated_at: now,
    daemon: {state: 'running', pid: 123}, profiles: [profile], ...changes});

function hud() {
    const result = Object.create(LoginHud.prototype);
    Object.assign(result, {_status: {mode: 'startup', stages: []}, _tabs: new Actor(),
        _rows: new Actor(), _selectedTab: 'gc', _alerts: null,
        _gcProfiles: normalizeGcProfiles(payload(), Date.parse(now) + 1000),
        _gcError: '', scheduleProgressFill() {}});
    return result;
}

test('validates daemon, profile states, and stale heartbeat', () => {
    assert.throws(() => normalizeGcProfiles({}));
    const valid = normalizeGcProfiles(payload(), Date.parse(now) + 31_000);
    assert.equal(valid.stale, true);
    assert.equal(valid.daemonAvailable, false);
    assert.equal(valid.profiles[0].name, 'daily');
    assert.equal(normalizeGcProfiles(payload(), Date.parse(now) - 31_000).daemonAvailable, false);
    assert.equal(normalizeGcProfiles(payload(), Date.parse(now) - 6_000).daemonAvailable, false);
});

test('invalid profile entries become visible failed rows and names are safe text', () => {
    const result = normalizeGcProfiles(payload({profiles: [
        {...profile, name: 'x\nunsafe', state: 'failed', last_failure_at: now},
        {name: 'broken'},
    ]}));
    assert.equal(result.profiles.length, 2);
    assert.equal(result.profiles[0].name, 'x unsafe');
    assert.equal(result.profiles[1].invalid, true);
    assert.equal(gcProfilePresentation(result.profiles[0]).time, now);
});

test('GC tab renders cleanup and failure times without actions', () => {
    const ui = hud();
    ui._renderTabs();
    assert.equal(ui._tabs.children.length, 3);
    assert.equal(ui._tabs.children[2].label, 'GC-профілі');
    ui._renderContent();
    const row = ui._rows.children.find(child => child.style_class.includes('login-hud-row-ok'));
    assert.ok(row);
    assert.match(row.children.at(-1).text, /Останнє очищення/);
    assert.match(row.children.at(-1).text, /Останнє очищення:/);
});

test('neutral profiles retain their latest successful cleanup time', () => {
    for (const state of ['disabled', 'running', 'pending']) {
        const result = normalizeGcProfiles(payload({profiles: [{...profile, state}]}), Date.parse(now) + 1000);
        const view = gcProfilePresentation(result.profiles[0]);
        assert.equal(view.time, now);
        assert.match(view.timeLabel, /Останнє очищення/);
    }
    assert.match(source, /toLocaleString\(\[\], \{dateStyle: 'medium', timeStyle: 'medium'\}\)/);
});

test('missing and malformed profile fields become failed rows', () => {
    const result = normalizeGcProfiles(payload({profiles: [
        {...profile, message: undefined},
        {...profile, last_success_at: 'yesterday'},
    ]}), Date.parse(now) + 1000);
    assert.equal(result.profiles.every(item => item.invalid && item.state === 'failed'), true);
});

test('a failed finish is never labelled as a successful cleanup in neutral states', () => {
    const result = normalizeGcProfiles(payload({profiles: [{...profile,
        state: 'disabled', enabled: false, last_success_at: null, last_failure_at: now,
    }]}), Date.parse(now));
    const view = gcProfilePresentation(result.profiles[0]);
    assert.equal(view.time, null);
    assert.equal(view.timeLabel, '');
});

test('GC load has size and disable race guards', () => {
    assert.match(source, /info\.get_size\(\) > GC_MAX_STATUS_BYTES/);
    assert.match(source, /bytes\.length > GC_MAX_STATUS_BYTES/);
    assert.match(source, /serial !== this\._gcSerial/);
    assert.match(source, /this\._gcSerial\+\+/);
});

test('stale daemon is visibly warned while profile rows remain passive', () => {
    const ui = hud();
    ui._gcProfiles = normalizeGcProfiles(payload(), Date.parse(now) + 31_000);
    ui._renderContent();
    assert.match(ui._rows.children[0].text, /застарів/);
    assert.equal(typeof ui._onCloseRequested, 'undefined');
});
