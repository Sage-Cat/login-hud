import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';

const source = await loadSource();

assert.ok(
    source.includes('Main.layoutManager.addChrome(this._hud, {'),
    'the HUD must use ordinary chrome rather than top chrome'
);
assert.match(
    source,
    /this\._hud\.visible = false;[\s\S]*?this\._resolveCurrentSessionId\(\);/,
    'extension enablement must keep the HUD hidden before session validation'
);
assert.ok(
    !source.includes('addTopChrome'),
    'the HUD must not use Shell top chrome'
);
assert.ok(
    source.includes('affectsInputRegion: false,'),
    'the stage-sized HUD container must not affect the Shell input region'
);
assert.ok(
    source.includes('Main.layoutManager.trackChrome(this._hud.getInteractiveActor(), {'),
    'only the bounded interactive panel should be tracked for input'
);
assert.ok(
    !source.includes('set_child_above_sibling'),
    'the HUD must not manually raise itself above Shell chrome'
);
assert.match(
    source,
    /const visible = Boolean\(this\._lastGoodStatus\) && eligible && !this\._dismissed/,
    'the HUD must remain hidden until an eligible valid status is loaded'
);
assert.match(
    source,
    /if \(parsed\.showOnStartup \|\| this\._startupReopened\) \{\s*this\._installHudChrome\(\);\s*this\._hud\.setStatus\(parsed\);/,
    'Shell chrome must be installed before status can trigger layout work'
);
assert.match(
    source,
    /showOnStartup: raw\.show_startup_hud !== false/,
    'same-boot login status must be able to suppress the startup HUD'
);
assert.match(
    source,
    /const DISMISSED_FILENAME = 'startup-hud-dismissed\.json';[\s\S]*?_startupDismissalMatches\(status\)[\s\S]*?dismissal\.session_id === status\.sessionId &&[\s\S]*?dismissal\.started_at === status\.startedAt/,
    'a dismissed startup HUD must stay hidden for the exact GNOME startup transaction'
);
assert.match(
    source,
    /_recordStartupDismissal\(status, reason\)[\s\S]*?session_id: status\.sessionId,[\s\S]*?started_at: status\.startedAt,[\s\S]*?reason,/,
    'startup dismissal must be written as a session-bound runtime marker'
);
assert.match(
    source,
    /const atSessionBoundary = Main\.sessionMode\.isLocked \|\| Main\.sessionMode\.isGreeter;[\s\S]*?_startupCanAutoDismiss\(this\._lastGoodStatus\)[\s\S]*?_recordStartupDismissal\(this\._lastGoodStatus, 'session-boundary'\)/,
    'a completed successful startup HUD must not return after lock or greeter login'
);
assert.match(
    source,
    /const STALE_STARTUP_PRESENTATION_MS = 5 \* 60 \* 1000;[\s\S]*?_startupPresentationIsStale\(status\)[\s\S]*?Date\.now\(\) - updatedAt >=[\s\S]*?STALE_STARTUP_PRESENTATION_MS/,
    'an extension reload must not resurrect an old completed startup HUD'
);
assert.match(
    source,
    /_installHudChrome\(\) \{[\s\S]*?this\._clockId = GLib\.timeout_add_seconds/,
    'periodic HUD work must start only with the validated HUD'
);
assert.ok(
    !/\bpushModal\b|\bpopModal\b|SYSTEM_MODAL/.test(source),
    'the HUD must never take a modal input grab'
);
// GNOME's native power menu must stay untouched: the extension neither reads
// nor assigns anything on the end-session dialog, nor mentions its protocol.
assert.ok(
    !/endSessionDialog|_confirmRebootToBootLoaderMenu|\b_confirm\b/.test(source),
    'the extension must not touch Main.endSessionDialog or its confirmation handlers'
);
assert.ok(
    !/shutdown-request|shutdown-commit|shutdown-prepared|shutdown-cancel|shutdown-hud-rendered/.test(source),
    'the shutdown request/commit/prepared/cancel/rendered protocol must not exist'
);
assert.ok(
    !/shutdown|countdown|preflight|handoff/i.test(source),
    'the extension must not carry any shutdown presentation or transaction code'
);
assert.match(
    source,
    /const parsed = normaliseStatus\(JSON\.parse\(new TextDecoder\(\)\.decode\(bytes\)\)\);\s*\/\/ Documents for any mode other than startup are ignored\.\s*if \(!parsed\)\s*return;/,
    'a status document for a mode other than startup must be ignored'
);
assert.match(
    source,
    /if \(mode !== 'startup'\)\s*return null;/,
    'only startup status documents may be normalised for presentation'
);
assert.match(
    source,
    /const eligible = this\._lastGoodStatus\?\.showOnStartup === true \|\| this\._startupReopened;/,
    'only startup status may make the HUD visible'
);

// The headless-Shell harness lives in workspace-state and is updated together
// with it; it is not evidence about this checkout until it is run against it.
// Deferred actor cleanup ordering is exercised by enable-lifecycle.mjs.


console.log('check: lifecycle safety invariants passed');


assert.match(source,
    /this\._hudFocusManager = St\.FocusManager\.get_for_stage\(global\.stage\);\s*this\._hudFocusManager\.add_group\(this\._hud\.getInteractiveActor\(\)\);/,
    'bounded interactive chrome must register native keyboard navigation without a modal grab');
