import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await loadSource();
const settled = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
    const requests = [];
    const timers = new Map();
    const statusArea = {};
    let nextTimerId = 0;

    class Menu {
        constructor() {
            this.items = [];
            this.box = {};
        }
        addMenuItem(item) { this.items.push(item); }
        removeAll() { this.items.length = 0; }
        setSensitive(sensitive) { this.sensitive = sensitive; }
        connect(_signal, callback) { this.openChanged = callback; }
        setOpen(open) {
            this.isOpen = open;
            this.openChanged(this, open);
        }
    }
    class Button {
        constructor() {
            this.menu = new Menu();
            this.visible = true;
        }
        add_child(child) { this.child = child; }
        destroy() {
            this.menu.setOpen(false);
            delete statusArea['workspace-switches'];
        }
    }
    class MenuItem {
        constructor(text, state) {
            this.label = {text, clutter_text: {}};
            this.state = state;
        }
        connect(_signal, callback) { this.activate = callback; }
        setToggleState(state) { this.state = state; }
        toggle() {
            this.state = !this.state;
            this.activate(this, this.state);
        }
    }
    const {WorkspaceSwitchMenu, normalizeWorkspaceList} = runInNewContext(
        source + '\n;({WorkspaceSwitchMenu, normalizeWorkspaceList});', {
            Extension: class {},
            GObject: {registerClass: cls => cls},
            Gio: {
                Cancellable: class {cancel() { this.cancelled = true; }},
                SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
                Subprocess: {new(argv) {
                    const command = {
                        get_if_exited: () => true,
                        get_exit_status: () => command.code,
                        communicate_utf8_finish: result => result,
                        communicate_utf8_async(_stdin, cancellable, done) {
                            requests.push({argv: Array.from(argv), cancellable, reply(code, stdout, stderr) {
                                command.code = code;
                                done(null, [true, stdout, stderr]);
                            }});
                        },
                    };
                    return command;
                }},
            },
            GLib: {
                get_home_dir: () => '/synthetic/home',
                build_filenamev: parts => parts.join('/'),
                timeout_add_seconds(_priority, _seconds, callback) {
                    timers.set(++nextTimerId, callback);
                    return nextTimerId;
                },
                Source: {remove: id => timers.delete(id)},
            },
            Main: {panel: {addToStatusArea(name, button) { statusArea[name] = button; }}},
            St: {Widget: class {}, Icon: class {}, ScrollView: class {}, PolicyType: {}},
            PanelMenu: {Button},
            PopupMenu: {PopupMenuSection: Menu, PopupSwitchMenuItem: MenuItem, PopupMenuItem: MenuItem},
        }
    );
    const switches = new WorkspaceSwitchMenu();
    switches.install();
    const button = statusArea['workspace-switches'];
    const [notice, rows] = button.menu.items;
    return {
        switches, button, notice, rows, requests, timers, statusArea, normalizeWorkspaceList,
        report(workspaces, busy = false) {
            requests.at(-1).reply(0, JSON.stringify({workspaces, busy}));
            return settled();
        },
    };
}

test('workspaces menu exists without a restoration report and loads only when opened', async () => {
    const f = fixture();
    assert.equal(f.button.visible, true);
    assert.equal(f.requests.length, 0);
    f.switches.setVisible(false);
    f.button.menu.setOpen(true);
    assert.equal(f.requests.length, 0);
    f.switches.setVisible(true);
    f.button.menu.setOpen(true);
    assert.deepEqual(f.requests[0].argv.slice(-2), ['list', '--json']);
    assert.match(f.notice.label.text, /Loading/);
    await f.report([{name: 'Writing', state: 'on'}, {name: 'Reference', state: 'off'}]);
    assert.deepEqual(f.rows.items.map(item => [item.label.text, item.state]), [
        ['Writing', true], ['Reference', false],
    ]);
    assert.equal(f.notice.visible, false);
});

test('native switch awaits verified state, keeps argv literal and retries interrupted direction', async () => {
    const f = fixture();
    const name = '--example $(touch "fixture")';
    f.button.menu.setOpen(true);
    await f.report([{name, state: 'on'}]);
    const original = f.rows.items[0];
    original.toggle();
    assert.equal(original.state, true);
    assert.equal(f.rows.sensitive, false);
    assert.match(f.notice.label.text, /Turning off/);
    assert.deepEqual(f.requests[1].argv, [
        '/usr/bin/timeout', '--foreground', '--kill-after=5s', '180s',
        '/synthetic/home/.local/bin/wsctl', 'workspace', 'off', '--', name,
    ]);
    original.toggle();
    assert.equal(f.requests.length, 2);

    f.requests[1].reply(3, '', 'A window remains open');
    await settled();
    await f.report([{name, state: 'partial', target: 'off', detail: 'A window remains open'}]);
    assert.match(f.notice.label.text, /incomplete/);
    assert.match(f.rows.items[0].label.text, /Partial · Retry turning off/);
    assert.equal(f.rows.items[1].label.text, 'A window remains open');
    f.rows.items[0].activate();
    assert.deepEqual(f.requests.at(-1).argv.slice(-3), ['off', '--', name]);
    f.requests.at(-1).reply(0, '', '');
    await settled();
    await f.report([{name, state: 'off'}]);
    assert.equal(f.rows.items[0].state, false);
    assert.equal(f.notice.visible, false);
    f.rows.items[0].toggle();
    assert.deepEqual(f.requests.at(-1).argv.slice(-3), ['on', '--', name]);
});

test('busy from another client disables controls and polls only with the menu open', async () => {
    const f = fixture();
    f.button.menu.setOpen(true);
    await f.report([{name: 'Writing', state: 'partial', target: 'on'}], true);
    assert.equal(f.rows.sensitive, false);
    assert.match(f.notice.label.text, /in progress/);
    assert.equal(f.timers.size, 1);
    f.rows.items[0].activate();
    assert.equal(f.requests.length, 1);
    f.button.menu.setOpen(false);
    assert.equal(f.timers.size, 0);
    f.button.menu.setOpen(true);
    await f.report([{name: 'Writing', state: 'on'}]);
    assert.equal(f.rows.sensitive, true);
    assert.equal(f.timers.size, 0);
});

test('standalone and malformed responses leave no actionable workspace controls', async () => {
    const f = fixture();
    f.button.menu.setOpen(true);
    f.requests[0].reply(127, '', 'wsctl missing');
    await settled();
    assert.match(f.notice.label.text, /require Workspace State/);
    assert.equal(f.rows.items.length, 0);
    f.button.menu.setOpen(false);
    f.button.menu.setOpen(true);
    await f.report([{name: 'invalid\0name', state: 'on'}]);
    assert.match(f.notice.label.text, /invalid workspace row/);
    assert.equal(f.rows.items.length, 0);
    assert.throws(() => f.normalizeWorkspaceList({workspaces: [
        {name: 'Writing', state: 'off'}, {name: 'Writing', state: 'on'},
    ]}), /invalid workspace row/);
});

test('disable cancels an outstanding list and leaves an accepted transition with the backend', async () => {
    const reading = fixture();
    reading.button.menu.setOpen(true);
    reading.switches.destroy();
    assert.equal(reading.requests[0].cancellable.cancelled, true);
    assert.equal(reading.statusArea['workspace-switches'], undefined);
    await reading.report([{name: 'Late status', state: 'on'}]);
    assert.equal(reading.rows.items.length, 0);

    const changing = fixture();
    changing.button.menu.setOpen(true);
    await changing.report([{name: 'Writing', state: 'partial'}]);
    changing.rows.items[0].activate();
    const operation = changing.requests.at(-1);
    assert.deepEqual(operation.argv.slice(-3), ['on', '--', 'Writing']);
    changing.switches.destroy();
    assert.equal(operation.cancellable, null);
    operation.reply(0, '', '');
    await settled();
    assert.equal(changing.requests.length, 2);
});
