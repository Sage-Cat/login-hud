import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await loadSource();
const css = await readFile(new URL('../stylesheet.css', import.meta.url), 'utf8');
// Exercise the actual layout methods without starting a Shell, reading status,
// acquiring a grab or sending any desktop/shutdown request.
const {hudBounds, LoginHud} = runInNewContext(
    source +
        '\n;({hudBounds, LoginHud});',
    {GObject: {registerClass: cls => cls}, St: {Widget: class {}}, Extension: class {}}
);

function fixture({width = 1920, height = 1036, scale = 1, notice = 0} = {}) {
    let panelStyle = '';
    let rowsStyle = '';
    const children = [16, 36, 16, 24, 16, 11, notice, 30, 50].map(value => ({
        visible: value > 0,
        get_preferred_height: () => [value * scale, value * scale],
    }));
    const rows = {
        visible: true,
        get_style: () => rowsStyle,
        set_style: value => { rowsStyle = value; },
        get_preferred_height: () => { throw Error('row content must not shrink its own budget'); },
    };
    children.push(rows);
    const panel = {
        get_stage: () => true,
        get_style: () => panelStyle,
        set_style: value => { panelStyle = value; },
        get_children: () => children,
        get_theme_node: () => ({
            adjust_for_width: value => value - 62 * scale,
            adjust_preferred_height: () => [50 * scale, 50 * scale],
            get_length: name => { assert.equal(name, 'spacing'); return 8 * scale; },
        }),
    };
    const hud = {
        _workArea: {x: 1920, y: 44, width, height}, _scaleFactor: scale,
        _panel: panel, _rowsScroll: rows,
    };
    return {
        hud, children,
        layout: () => LoginHud.prototype._updatePanelLayout.call(hud),
        rowHeight: () => Number(rowsStyle.match(/max-height: (\d+)px/)[1]),
        panelStyle: () => panelStyle,
    };
}

test('1080p overview has room for all eight collapsed jobs', () => {
    const f = fixture();
    f.layout();
    assert.match(f.panelStyle(), /width: 900px/);
    assert.ok(f.rowHeight() >= 8 * 76 + 7 * 8);
    assert.ok(f.rowHeight() > 520);
});

test('large display has no legacy fixed row cap', () => {
    const f = fixture({width: 3840, height: 2074});
    f.layout();
    assert.ok(f.rowHeight() > 1500);
});

test('small display reserves footer and permits scrolling', () => {
    const f = fixture({width: 800, height: 600});
    f.layout();
    assert.match(f.panelStyle(), /width: 752px/);
    assert.ok(f.rowHeight() > 0 && f.rowHeight() < 520);
});

test('HiDPI sizing uses logical pixels exactly once', () => {
    const regular = fixture();
    const hidpi = fixture({width: 3840, height: 2072, scale: 2});
    regular.layout();
    hidpi.layout();
    assert.equal(hidpi.panelStyle(), regular.panelStyle());
    assert.equal(hidpi.rowHeight(), regular.rowHeight());
});

test('notice and larger actions reduce rows, not button visibility', () => {
    const regular = fixture();
    const notice = fixture({notice: 48});
    regular.layout();
    notice.layout();
    assert.equal(regular.rowHeight() - notice.rowHeight(), 56);
});

test('work-area changes resize the existing panel', () => {
    const f = fixture();
    f.layout();
    const original = f.rowHeight();
    f.hud._workArea.height -= 100;
    f.layout();
    assert.equal(f.rowHeight(), original - 100);
});

test('bounds never exceed the selected monitor or become negative', () => {
    for (const [width, height, scale] of [[800, 600, 1], [1920, 1080, 1], [3840, 2160, 2]]) {
        const bounds = hudBounds({width, height}, scale);
        assert.ok(bounds.width * scale <= width - 48 * scale);
        assert.ok(bounds.height * scale <= height - 48 * scale);
    }
    assert.equal(hudBounds({width: 0, height: 0}, 1).height, 1);
});

test('only the row list scrolls and obsolete size limits are absent', () => {
    assert.doesNotMatch(css, /max-height:\s*520px|min-width:\s*510px/);
    assert.doesNotMatch(source, /width:\s*650/);
    assert.match(source, /vscrollbar_policy: St\.PolicyType\.AUTOMATIC/);
    assert.match(source, /this\._panel\.add_child\(this\._rowsScroll\);\s*this\._panel\.add_child\(this\._actions\);/);
    assert.match(source, /getWorkAreaForMonitor\(index\)/);
    assert.match(source, /style_class: 'login-hud-overlay',\s*layout_manager: new Clutter\.FixedLayout\(\)/);
    assert.match(source, /this\._viewport\.set_position\(workArea\.x, workArea\.y\)/);
    assert.match(source, /global\.display\.disconnect\(this\._workAreasChangedId\)/);
    assert.match(source, /Main\.layoutManager\.disconnect\(this\._monitorsChangedId\)/);
});
