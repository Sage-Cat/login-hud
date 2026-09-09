import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const extensionPath = fileURLToPath(new URL('../extension.js', import.meta.url));
const source = await readFile(extensionPath, 'utf8');

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
    /const eligible = parsed\.mode === 'shutdown' \|\| parsed\.showOnStartup;\s*if \(eligible\) \{\s*this\._installHudChrome\(\);\s*this\._hud\.setStatus\(parsed\);/,
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
assert.match(
    source,
    /const shouldBeModal = this\._hud\?\.visible && status\?\.mode === 'shutdown'/,
    'a modal grab must be gated to shutdown mode'
);
assert.match(
    source,
    /if \(hasFailure\) \{[\s\S]*?status\.mode === 'shutdown'[\s\S]*?Shutdown stopped · review the error and retry power off[\s\S]*?else \{\s*this\._addCloseButton\('Close'\);/,
    'a failed shutdown must expose its log without a close action'
);
assert.match(
    source,
    /const terminalShutdown = parsed\.mode === 'shutdown'[\s\S]*?!matchesRequest && !matchesLocalPreflight && !terminalShutdown/,
    'a terminal shutdown failure must remain visible after active request cleanup'
);
assert.match(
    source,
    /_openErrorLog\(path\)[\s\S]*?const keepVisible = status\?\.mode === 'shutdown' && hasFailure;[\s\S]*?if \(!keepVisible\) \{\s*this\._dismissed = true;/,
    'opening the full error log must not dismiss a failed shutdown HUD'
);
assert.match(
    source,
    /const grab = Main\.pushModal\(this\._hud, \{[\s\S]*?actionMode: Shell\.ActionMode\.SYSTEM_MODAL/,
    'shutdown cancellation must retain its system-modal grab'
);
assert.match(
    source,
    /_cancelNativeEndSessionOnce\(operationId\)[\s\S]*?Main\.endSessionDialog\?\.cancel\?\.\(\)/,
    'one HUD cancellation must also cancel GNOME\'s original inhibited request'
);
assert.match(
    source,
    /this\._originalEndSessionConfirm = dialog\._confirm;[\s\S]*?dialog\._confirm = this\._wrappedEndSessionConfirm;/,
    'GNOME confirmation must be intercepted before ConfirmedShutdown/ConfirmedReboot is emitted'
);
assert.match(
    source,
    /_interceptEndSessionConfirm\(signal\)[\s\S]*?!this\._shutdownCoordinatorIsActive\(\)[\s\S]*?return this\._originalEndSessionConfirm\.call\(this\._endSessionDialog, signal\)/,
    'a missing shutdown coordinator must fail open to GNOME native shutdown'
);
assert.match(
    source,
    /_shutdownCoordinatorIsActive\(\)[\s\S]*?'GetUnit'[\s\S]*?SHUTDOWN_COORDINATOR_UNIT[\s\S]*?'ActiveState'[\s\S]*?recursiveUnpack\(\)[\s\S]*?=== 'active'[\s\S]*?return false;/,
    'shutdown interception must require the live companion systemd service'
);
assert.match(
    source,
    /this\._endSessionDialog\._confirm === this\._wrappedEndSessionConfirm[\s\S]*?this\._endSessionDialog\._confirm = this\._originalEndSessionConfirm;/,
    'the GNOME confirmation wrapper must be restored without clobbering another wrapper'
);
assert.match(
    source,
    /operation_id: operationId,\s*session_id: sessionId,\s*action,\s*requested_at:/,
    'the preflight request must bind operation, session, and exact GNOME action'
);
assert.match(
    source,
    /_interceptEndSessionConfirm\(signal\)[\s\S]*?await this\._closeNativeDialogBeforePreflight\(\);[\s\S]*?this\._writeProtocolFile\(this\._requestFile/,
    'the native confirmation must be fully closed before the HUD request is published'
);
assert.match(
    source,
    /_closeNativeDialogBeforePreflight\(\)[\s\S]*?dialog\.state === ModalDialogState\.CLOSED[\s\S]*?dialog\.connect\('closed'/,
    'the timer path must wait for GNOME confirmation closure'
);
assert.match(
    source,
    /if \(this\._nativeHandoffOperationId\)\s*return this\._originalEndSessionConfirm/,
    'a later Power Off Anyway confirmation must continue the prepared action without another preflight'
);
assert.match(
    source,
    /Clutter\.threads_add_repaint_func_full\([\s\S]*?Clutter\.RepaintFlags\.POST_PAINT[\s\S]*?this\._writeProtocolFile\(this\._renderedFile/,
    'the rendered acknowledgement must only be written after a Shell paint'
);
assert.match(
    source,
    /!this\._hud\.mapped \|\| !panel\.mapped \|\| panel\.width <= 0 \|\| panel\.height <= 0/,
    'the rendered acknowledgement must wait for a real allocation'
);
assert.match(
    source,
    /const SHUTDOWN_COUNTDOWN_SECONDS = 3;[\s\S]*?_startShutdownCountdown\(status\)[\s\S]*?_commitShutdown\(this\._lastGoodStatus\)/,
    'a visible three-second countdown must precede shutdown commit'
);
assert.ok(
    source.includes("'System shutdown ready with safe fallbacks'"),
    'degraded shutdown completion must be distinguishable from failure'
);
assert.match(
    source,
    /this\._hud\.setShutdownCountdown\(action, seconds\);[\s\S]*?Clutter\.RepaintFlags\.POST_PAINT[\s\S]*?const began = GLib\.get_monotonic_time\(\);[\s\S]*?GLib\.get_monotonic_time\(\) - began/,
    'the monotonic countdown clock must start only after the visible 3 frame is painted'
);
assert.match(
    source,
    /prepared\.operation_id !== status\.operationId \|\|\s*prepared\.session_id !== status\.sessionId \|\|\s*prepared\.action !== status\.shutdownAction[\s\S]*?this\._handoffToGnome\(status\)/,
    'GNOME handoff must require a marker matching operation, session, and action'
);
assert.match(
    source,
    /_startPreparedPolling\(operationId\)[\s\S]*?GLib\.timeout_add\([\s\S]*?this\._checkPreparedHandoff\(\)/,
    'prepared-marker handoff must be polled as well as watched for file events'
);
assert.match(
    source,
    /const PREPARED_POLL_TIMEOUT_MS = 15000;[\s\S]*?elapsedMs >= PREPARED_POLL_TIMEOUT_MS[\s\S]*?this\._requestCancel\(status\)/,
    'prepared polling must cancel safely instead of holding the modal forever'
);
assert.match(
    source,
    /const cancelled = status\?\.operationId === operationId &&\s*this\._requestCancel\(status\);\s*if \(cancelled\) \{\s*this\._dismissed = true;/,
    'a failed cancel write must not hide an operation which remains pending'
);
assert.match(
    source,
    /_handleNativeHandoffFailure\(status, error\)[\s\S]*?this\._nativeHandoffOperationId = null;[\s\S]*?this\._writeProtocolFile\(this\._cancelFile[\s\S]*?this\._cancelNativeEndSessionOnce\(status\.operationId\)/,
    'a rejected GNOME handoff must clear bypass state and cancel the exact operation'
);
assert.match(
    source,
    /_handleNativeHandoffFailure\(status, error\)[\s\S]*?this\._preflightOperationId = null;[\s\S]*?this\._preflightAction = null;[\s\S]*?this\._preflightSignal = null;/,
    'a rejected GNOME handoff must not block future confirmed shutdowns'
);
assert.match(
    source,
    /const wasHandedOff = this\._nativeHandoffOperationId === status\.operationId;[\s\S]*?this\._nativeCancelledOperationId = status\.operationId;[\s\S]*?this\._nativeHandoffOperationId = null;/,
    'repeated terminal status after GNOME cancellation must not emit Canceled twice'
);
assert.match(
    source,
    /Gio\.FileQueryInfoFlags\.NOFOLLOW_SYMLINKS[\s\S]*?info\.get_file_type\(\) !== Gio\.FileType\.REGULAR/,
    'a symlink or non-regular prepared marker must never authorize handoff'
);
assert.ok(
    source.includes("const SHUTDOWN_ORIGINS = new Set(['preflight']);"),
    'backend-only GNOME shutdown status must not be displayable'
);
assert.match(
    source,
    /parsed\.mode === 'shutdown' &&\s*!matchesRequest && !matchesLocalPreflight[\s\S]*?this\._lastGoodStatus = null;/,
    'shutdown HUD visibility must be bound to the post-confirmation private request'
);
assert.match(
    source,
    /this\._cancelNativeEndSessionOnce\(status\.operationId\);/,
    'one HUD cancellation must close the matching GNOME request exactly once'
);
assert.ok(
    !source.includes('NATIVE_CANCEL_MAX_ATTEMPTS'),
    'bounded retries must not accidentally cancel a later GNOME dialog'
);
assert.ok(
    !source.includes('_cancelNativeEndSessionRetry'),
    'native cancellation must not leave a retry source that can affect a later dialog'
);
assert.ok(
    !source.includes('SystemActions.getDefault()'),
    'preflight must not run before the user confirms the native GNOME dialog'
);
assert.match(
    source,
    /_wrappedBootOptionsConfirm[\s\S]*?this\._confirmBypass = true;[\s\S]*?this\._confirmBypass = false;/,
    'Boot Options must retain its native non-cancellable semantics'
);
assert.match(
    source,
    /_abortActivePreflightOnDisable\(\)[\s\S]*?this\._writeProtocolFile\(this\._cancelFile[\s\S]*?this\._cancelNativeEndSessionOnce\(operationId\)/,
    'disabling the extension during preflight must cancel backend and GNOME work'
);
assert.match(
    source,
    /_recoverPendingPreflightRequest\(\)[\s\S]*?\^\[0-9a-f\]\{32\}\$[\s\S]*?request\.session_id !== this\._currentSessionId[\s\S]*?this\._startPreflightWatchdog/,
    'an extension reload must safely recover only a fresh current-session preflight request'
);
assert.match(
    source,
    /status\.operationId !== this\._locallyCancelledOperationId[\s\S]*?this\._locallyCancelledOperationId = status\.operationId;\s*this\._cancelShutdownCountdown\(\)/,
    'a local cancel must synchronously fence commit and prepared-marker races'
);
assert.match(
    source,
    /_updateOverallProgressFill\(\) \{\s*if \(!this\._overallProgressTrack\.get_stage\(\) \|\| !this\._overallProgressTrack\.mapped\)\s*return;/,
    'progress geometry must not be read while actors are unattached'
);
assert.match(
    source,
    /cancelDeferredUpdates\(\)[\s\S]*?GLib\.Source\.remove\(this\._overallProgressFillId\)[\s\S]*?this\._hud\.cancelDeferredUpdates\(\);/,
    'extension disable must remove deferred actor callbacks before destroying the HUD'
);

console.log('check: lifecycle safety invariants passed');
