import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const code = await loadSource();
class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.clutter_text = {}; }
    add_child(child) { this.children.push(child); }
    destroy_all_children() { this.children = []; }
    connect(event, callback) { this[event] = callback; }
}
const {normalizeAlerts, LoginHud} = runInNewContext(
    code +
    '\n;({normalizeAlerts, LoginHud});', {
        GObject: {registerClass: cls => cls}, St: {Widget: Actor, BoxLayout: Actor, Button: Actor, Label: Actor},
        Extension: class {}, Clutter: {ActorAlign: {END: 1}},
    }
);
const owned = {id: 'own-bot', ownership: 'first-party', label: 'Own bot', host: 'example-server', health: 'healthy'};
const incident = {source: 'own-bot', code: 'auth-required', active: 1, acknowledged: 0, message: 'Reauthenticate'};
const payload = (changes = {}) => ({schema_version: 1, boot_id: 'boot', last_scan_boot_id: 'boot', sources: [owned], incidents: [incident], last_scan_at: new Date().toISOString(), ...changes});
function hud(mode = 'startup') {
    const result = Object.create(LoginHud.prototype);
    Object.assign(result, {_status: {mode, stages: []}, _tabs: new Actor(), _rows: new Actor(),
        _expandedJobs: new Set(), _selectedTab: 'startup', _alerts: normalizeAlerts(payload()),
        scheduleProgressFill() {}, _renderRows() { this.renderedRestore = true; }});
    return result;
}

test('rejects malformed or unbounded reports; filters non-owned sources', () => {
    for (const bad of [null, {}, payload({sources: Array(65).fill(owned)}), payload({incidents: Array(201).fill(incident)})])
        assert.throws(() => normalizeAlerts(bad));
    const result = normalizeAlerts(payload({sources: [null, owned, {...owned, id: 'third', ownership: 'third-party'}],
        incidents: [null, incident, {...incident, source: 'third'}]}));
    assert.equal(result.sources.length, 1);
    assert.equal(result.incidents.length, 1);
});

test('acknowledged active incidents remain active; resolved history is hidden', () => {
    const result = normalizeAlerts(payload({incidents: [{...incident, acknowledged: 1}, {...incident, code: 'other', active: 0}]}));
    assert.equal(result.unread, 0);
    assert.equal(result.incidents[0].active, true);
    assert.equal(result.incidents.length, 1);
});

test('missing or stale last scan cannot look like fresh health', () => {
    assert.equal(normalizeAlerts(payload()).stale, false);
    assert.equal(normalizeAlerts(payload({last_scan_at: null})).stale, true);
    assert.equal(normalizeAlerts(payload({last_scan_at: '2000-01-01'})).stale, true);
    assert.equal(normalizeAlerts(payload({last_scan_boot_id: 'previous-boot'})).stale, true);
});

test('a stopped collector becomes stale without receiving another file event', () => {
    const ui = hud();
    ui._alerts.updatedAt = '2000-01-01';
    ui._refreshElapsed = () => {};
    ui.refreshClock();
    assert.equal(ui._alerts.stale, true);
});

test('startup tab can be clicked; incident details and acknowledgement work', () => {
    const ui = hud();
    ui._renderTabs();
    assert.equal(ui._tabs.visible, true);
    assert.match(ui._tabs.children[1].label, /Важливе · 1/);
    ui._tabs.children[1].clicked();
    assert.equal(ui._selectedTab, 'important');
    const card = ui._rows.children.find(child => child.style_class.includes('login-hud-row-failed'));
    card.children[0].clicked();
    assert.ok(ui._expandedJobs.has('alert:own-bot:auth-required'));
    let acknowledged;
    ui._onAlertAckRequested = (...args) => { acknowledged = args; };
    card.children.at(-1).clicked();
    assert.deepEqual(acknowledged, ['own-bot', 'auth-required']);
});

test('shutdown has no tabs and never renders Important', () => {
    const ui = hud('shutdown');
    ui._selectedTab = 'important';
    ui._renderAlerts = () => { throw Error('must not render alerts in shutdown'); };
    ui._renderTabs();
    ui._renderContent();
    ui.setAlerts(normalizeAlerts(payload()));
    assert.equal(ui._tabs.visible, false);
    assert.equal(ui._tabs.children.length, 0);
    assert.equal(ui._selectedTab, 'startup');
    assert.equal(ui.renderedRestore, true);
});

test('alert file updates do not open HUD, control services or authorize shutdown', () => {
    const handlers = code.slice(code.indexOf('    _loadAlerts() {'), code.indexOf('    _requestCancel(status) {'));
    assert.doesNotMatch(handlers, /pushModal|\.show\(|systemctl|PowerOff|Reboot|_writeProtocolFile|_showHud/);
    assert.match(handlers, /this\._lastGoodStatus\?\.mode !== 'startup'/);
    assert.match(handlers, /'alerts', 'ack', source, code/);
    assert.match(handlers, /Gio\.FileQueryInfoFlags\.NOFOLLOW_SYMLINKS/);
});
