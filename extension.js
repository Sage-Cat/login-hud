/* exported default */
/* global console TextEncoder */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BUILD_REVISION} from './buildInfo.js';
import {LoginHud} from './hudView.js';
import {
    STATUS_DIRECTORY, STATUS_FILENAME, ALERTS_FILENAME, GC_STATUS_FILENAME,
    DISMISSED_FILENAME, SESSION_MANAGER_NAME, DBUS_NAME, DBUS_PATH, DBUS_INTERFACE,
    TERMINAL_STATES, GC_MAX_STATUS_BYTES, STALE_STARTUP_PRESENTATION_MS,
    normaliseStatus, normalizeAlerts, normalizeGcProfiles,
    startupRestorationTerminal, sameOperationContext,
} from './reports.js';

export default class LoginHudExtension extends Extension {
    enable() {
        this._enableEpoch = {};
        this._cancellable = new Gio.Cancellable();
        try {
            const [, boot] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
            this._bootId = new TextDecoder().decode(boot).trim();
            this._enable();
            if (this._legacyPassive)
                return;
            this._diagnostics = Gio.DBusExportedObject.wrapJSObject(
                '<node><interface name="org.sagecat.LoginHud"><method name="ShowStartupStatus"><arg type="b" direction="out"/></method><method name="GetState"><arg type="s" direction="out"/></method></interface></node>', {
                    ShowStartupStatus: () => this._showStartupStatus(),
                    GetState: () => JSON.stringify({build: {
                        uuid: this.uuid, version: this.metadata.version, revision: BUILD_REVISION,
                        sourceIdentityKnown: BUILD_REVISION !== 'development',
                    }, visible: Boolean(this._hud?.visible),
                    operation_context: this._lastGoodStatus?.operationContext ?? null,
                    startup_abort_requested: Boolean(this._startupAbortPending)}),
                });
            this._diagnostics.export(Gio.DBus.session, '/org/sagecat/LoginHud');
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _ownsEpoch(epoch) {
        return epoch === this._enableEpoch && Boolean(this._hud);
    }

    _enable() {
        // One session may retain the old UUID's JavaScript module in memory
        // after an in-place update on Wayland. Keep that UUID as a passive
        // migration alias on future logins; the v2 UUID owns all HUD work.
        if (this.uuid === 'login-hud@sagecat.local') {
            this._legacyPassive = true;
            return;
        }
        const runtimeDirectory = GLib.get_user_runtime_dir();
        this._statusDirectory = Gio.File.new_for_path(GLib.build_filenamev([
            runtimeDirectory, STATUS_DIRECTORY,
        ]));
        this._statusFile = this._statusDirectory.get_child(STATUS_FILENAME);
        this._alertsFile = this._statusDirectory.get_child(ALERTS_FILENAME);
        const stateHome = GLib.getenv('XDG_STATE_HOME') ||
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
        this._gcStatusDirectory = Gio.File.new_for_path(GLib.build_filenamev([
            stateHome, 'gc-profiled',
        ]));
        this._gcStatusFile = this._gcStatusDirectory.get_child(GC_STATUS_FILENAME);
        this._alertsSerial = 0;
        this._gcSerial = 0;
        this._gcRefreshId = 0;
        this._dismissedFile = this._statusDirectory.get_child(DISMISSED_FILENAME);
        this._startupAbortFile = this._statusDirectory.get_child('startup-abort.json');
        this._startupAbortPending = false;
        this._startupReopened = false;
        this._loadSerial = 0;
        this._reloadTimeout = 0;
        this._clockId = 0;
        this._lastGoodStatus = null;
        this._dismissed = false;
        this._activeSessionId = null;
        this._activeMode = null;
        this._activeOperationId = null;
        this._activeStartedAt = null;
        this._chromeInstalled = false;
        this._panelChromeTracked = false;
        this._hudFocusManager = null;
        this._currentSessionId = null;
        this._sessionIdResolvePending = false;
        this._sessionIdRetryId = 0;

        try {
            GLib.mkdir_with_parents(this._statusDirectory.get_path(), 0o700);
        } catch (error) {
            // Monitoring/loading below remains fail-open and reports the issue.
            console.warn(`Login HUD could not create its runtime directory: ${error.message}`);
        }

        this._hud = new LoginHud();
        this._hud.setCallbacks(
            () => this._dismissHud(),
            path => this._openErrorLog(path),
            (source, code) => this._ackAlert(source, code),
            status => this._requestStartupAbort(status),
            () => this._backgroundStartup()
        );
        this._hud.visible = false;
        this._startupIndicator = new PanelMenu.Button(0, 'Workspace restoration status', true);
        this._startupIndicator.accessible_name = 'Show workspace restoration status';
        this._startupIndicator.can_focus = true;
        this._startupIndicator.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic', style_class: 'system-status-icon',
        }));
        this._startupIndicator.connect('button-press-event', () => {
            this._showStartupStatus();
            return Clutter.EVENT_STOP;
        });
        this._startupIndicator.connect('key-press-event', (_actor, event) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            this._showStartupStatus();
            return Clutter.EVENT_STOP;
        });
        this._startupIndicator.visible = false;
        Main.panel.addToStatusArea('workspace-restoration', this._startupIndicator);
        this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
            this._syncVisibility();
        });

        try {
            this._monitor = this._statusDirectory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorChangedId = this._monitor.connect('changed', (_monitor, file, otherFile) => {
                const names = new Set([file?.get_basename(), otherFile?.get_basename()]);
                if (names.has(STATUS_FILENAME))
                    this._scheduleLoad();
                if (names.has(ALERTS_FILENAME) && this._lastGoodStatus?.mode === 'startup')
                    this._loadAlerts();
            });
        } catch (error) {
            this._hud.setTransportNotice(`Status directory is not available yet: ${error.message}`);
        }

        try {
            this._gcMonitor = this._gcStatusDirectory.monitor_directory(
                Gio.FileMonitorFlags.NONE, null
            );
            this._gcMonitorChangedId = this._gcMonitor.connect('changed', (_monitor, file, otherFile) => {
                const names = new Set([file?.get_basename(), otherFile?.get_basename()]);
                if (names.has(GC_STATUS_FILENAME) && this._lastGoodStatus?.mode === 'startup')
                    this._loadGcProfiles();
            });
        } catch (_error) {
            // The daemon creates this directory lazily.
        }

        this._resolveCurrentSessionId();
    }

    _cleanup(action) {
        try {
            action();
        } catch (error) {
            console.warn(`Login HUD cleanup failed: ${error.message}`);
        }
    }

    disable() {
        this._enableEpoch = null;
        this._cleanup(() => this._cancellable?.cancel());
        this._cancellable = null;
        this._cleanup(() => this._diagnostics?.unexport());
        this._diagnostics = null;
        this._cleanup(() => this._startupIndicator?.destroy());
        this._startupIndicator = null;
        if (this._legacyPassive) {
            this._legacyPassive = false;
            return;
        }
        if (this._reloadTimeout)
            this._cleanup(() => GLib.Source.remove(this._reloadTimeout));
        if (this._sessionIdRetryId)
            this._cleanup(() => GLib.Source.remove(this._sessionIdRetryId));
        if (this._clockId)
            this._cleanup(() => GLib.Source.remove(this._clockId));
        if (this._monitorChangedId)
            this._cleanup(() => this._monitor?.disconnect(this._monitorChangedId));
        this._cleanup(() => this._monitor?.cancel());
        if (this._gcRefreshId)
            this._cleanup(() => GLib.Source.remove(this._gcRefreshId));
        if (this._gcMonitorChangedId)
            this._cleanup(() => this._gcMonitor?.disconnect(this._gcMonitorChangedId));
        this._cleanup(() => this._gcMonitor?.cancel());
        if (this._stageSizeChangedId)
            this._cleanup(() => global.stage.disconnect(this._stageSizeChangedId));
        if (this._stageHeightChangedId)
            this._cleanup(() => global.stage.disconnect(this._stageHeightChangedId));
        if (this._workAreasChangedId)
            this._cleanup(() => global.display.disconnect(this._workAreasChangedId));
        if (this._monitorsChangedId)
            this._cleanup(() => Main.layoutManager.disconnect(this._monitorsChangedId));
        if (this._scaleChangedId)
            this._cleanup(() => St.ThemeContext.get_for_stage(global.stage).disconnect(this._scaleChangedId));
        if (this._sessionModeUpdatedId)
            this._cleanup(() => Main.sessionMode.disconnect(this._sessionModeUpdatedId));
        if (this._hudFocusManager && this._hud)
            this._cleanup(() => this._hudFocusManager.remove_group(this._hud.getInteractiveActor()));
        this._hudFocusManager = null;
        if (this._hud) {
            this._cleanup(() => this._hud.cancelDeferredUpdates());
            if (this._panelChromeTracked)
                this._cleanup(() => Main.layoutManager.untrackChrome(this._hud.getInteractiveActor()));
            if (this._chromeInstalled)
                this._cleanup(() => Main.layoutManager.removeChrome(this._hud));
            this._cleanup(() => this._hud.destroy());
        }

        this._reloadTimeout = 0;
        this._sessionIdRetryId = 0;
        this._clockId = 0;
        this._monitorChangedId = 0;
        this._gcRefreshId = 0;
        this._gcMonitorChangedId = 0;
        this._stageSizeChangedId = 0;
        this._stageHeightChangedId = 0;
        this._workAreasChangedId = 0;
        this._monitorsChangedId = 0;
        this._scaleChangedId = 0;
        this._sessionModeUpdatedId = 0;
        this._monitor = null;
        this._gcMonitor = null;
        this._hud = null;
        this._chromeInstalled = false;
        this._panelChromeTracked = false;
        this._currentSessionId = null;
        this._sessionIdResolvePending = false;
        this._statusFile = null;
        this._alertsFile = null;
        this._gcStatusFile = null;
        this._gcStatusDirectory = null;
        this._alertsSerial++;
        this._gcSerial++;
        this._dismissedFile = null;
        this._startupAbortFile = null;
        this._startupAbortPending = false;
        this._startupReopened = false;
        this._statusDirectory = null;
        this._activeSessionId = null;
        this._activeMode = null;
        this._activeOperationId = null;
        this._activeStartedAt = null;
    }

    _readProtocolFileSync(file) {
        try {
            const [loaded, bytes] = file.load_contents(null);
            if (!loaded)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (_error) {
            return null;
        }
    }

    _writeProtocolFile(destination, temporaryPrefix, payload) {
        const temporary = this._statusDirectory.get_child(
            `.${temporaryPrefix}.${GLib.uuid_string_random()}`
        );
        try {
            temporary.replace_contents(
                new TextEncoder().encode(JSON.stringify(payload)),
                null,
                false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            temporary.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (error) {
            try {
                temporary.delete(null);
            } catch (_cleanupError) {
                // Runtime files disappear with the user session.
            }
            throw error;
        }
    }

    _syncHudSize() {
        this._hud?.set_size(global.stage.width, global.stage.height);
        const index = Main.layoutManager.primaryIndex;
        if (index < 0 || !this._hud)
            return;
        this._hud.setWorkArea(
            Main.layoutManager.getWorkAreaForMonitor(index),
            St.ThemeContext.get_for_stage(global.stage).scale_factor
        );
    }

    _startupCanAutoDismiss(status) {
        if (status?.mode !== 'startup' || !startupRestorationTerminal(status))
            return false;
        const hasFailure = status.overallState === 'failed' ||
            status.stages.some(stage => stage.state === 'failed');
        return !hasFailure && status.stages.length > 0 &&
            status.stages.every(stage => TERMINAL_STATES.has(stage.state));
    }

    _startupDismissalMatches(status) {
        if (status?.mode !== 'startup' || !this._dismissedFile)
            return false;
        const dismissal = this._readProtocolFileSync(this._dismissedFile);
        return dismissal?.schema_version === 1 &&
            dismissal.session_id === status.sessionId &&
            dismissal.started_at === status.startedAt;
    }

    _startupPresentationIsStale(status) {
        if (!this._startupCanAutoDismiss(status))
            return false;
        const updatedAt = Date.parse(status.updatedAt);
        return Number.isFinite(updatedAt) && Date.now() - updatedAt >=
            STALE_STARTUP_PRESENTATION_MS;
    }

    _recordStartupDismissal(status, reason) {
        if (status?.mode !== 'startup')
            return;
        this._dismissed = true;
        try {
            this._writeProtocolFile(this._dismissedFile, 'startup-hud-dismissed', {
                schema_version: 1,
                session_id: status.sessionId,
                started_at: status.startedAt,
                reason,
                dismissed_at: new Date().toISOString(),
            });
        } catch (error) {
            // Keep the current Shell session usable even if runtime storage is
            // temporarily unavailable. A future extension reload may show the
            // completed HUD again.
            console.warn(`Login HUD could not persist startup dismissal: ${error.message}`);
        }
    }

    _startupAbortMatches(status) {
        const receipt = this._readProtocolFileSync(this._startupAbortFile);
        return receipt?.schema_version === 1 && receipt.mode === 'startup' &&
            receipt.session_id === status.sessionId && receipt.operation_id === status.operationId &&
            sameOperationContext(receipt.operation_context, status.operationContext);
    }

    _startupAbortAvailable(status) {
        const context = status?.operationContext;
        return status?.mode === 'startup' && status.sessionId === this._currentSessionId &&
            this._isCurrentOperation(status) && Boolean(status.operationId) &&
            context?.mode === 'startup' && context.operation_id === status.operationId &&
            context.boot_id === this._bootId && context.login_generation === this._currentSessionId &&
            context.deadline > GLib.get_monotonic_time() / 1000000 &&
            !startupRestorationTerminal(status) && status.operationState !== 'cancelling';
    }

    _requestStartupAbort(status) {
        if (!this._startupAbortAvailable(status))
            return false;
        if (this._startupAbortPending || this._startupAbortMatches(status)) {
            this._startupAbortPending = true;
            this._hud.setStartupAbortPending(true);
            return true;
        }
        try {
            this._writeProtocolFile(this._startupAbortFile, 'startup-abort', {
                schema_version: 1, mode: 'startup', session_id: status.sessionId,
                operation_id: status.operationId, operation_context: status.operationContext,
                requested_at: new Date().toISOString(),
            });
            this._startupAbortPending = true;
            this._hud.setStartupAbortPending(true);
            return true;
        } catch (error) {
            this._hud.setTransportNotice(`Restoration continues: the abort request could not be written: ${error.message}`);
            return false;
        }
    }

    _backgroundStartup() {
        if (this._lastGoodStatus?.mode !== 'startup')
            return false;
        this._startupReopened = false;
        this._recordStartupDismissal(this._lastGoodStatus, 'background');
        this._syncVisibility();
        return true;
    }

    _showStartupStatus() {
        const status = this._lastGoodStatus;
        if (status?.mode !== 'startup' || status.sessionId !== this._currentSessionId ||
            Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return false;
        try {
            if (this._startupDismissalMatches(status))
                this._dismissedFile.delete(null);
        } catch (error) {
            this._hud.setTransportNotice(`Could not reopen restoration status: ${error.message}`);
            return false;
        }
        this._startupReopened = true;
        this._dismissed = false;
        this._installHudChrome();
        this._hud.setStatus(status);
        this._hud.setStartupAbortPending(this._startupAbortPending);
        this._syncVisibility();
        this._hud.focusPrimaryAction();
        return true;
    }

    _dismissHud() {
        const status = this._lastGoodStatus;
        if (status?.mode === 'startup') {
            this._startupReopened = false;
            this._recordStartupDismissal(status, 'user');
        }
        else
            this._dismissed = true;
        this._syncVisibility();
    }

    _installHudChrome() {
        if (!this._hud || this._chromeInstalled)
            return;

        // Keep the stage-sized container out of the Shell input region.  The
        // panel itself is tracked below, so startup controls remain usable
        // without making the rest of the desktop an input surface.
        Main.layoutManager.addChrome(this._hud, {
            affectsStruts: false,
            trackFullscreen: false,
            affectsInputRegion: false,
        });
        this._chromeInstalled = true;
        Main.layoutManager.trackChrome(this._hud.getInteractiveActor(), {
            affectsStruts: false,
            trackFullscreen: false,
            affectsInputRegion: true,
        });
        this._panelChromeTracked = true;
        // Native Tab navigation needs a focus group even for nonmodal chrome.
        // Register only the bounded panel; desktop input remains ungrabbed.
        this._hudFocusManager = St.FocusManager.get_for_stage(global.stage);
        this._hudFocusManager.add_group(this._hud.getInteractiveActor());
        this._syncHudSize();
        this._stageSizeChangedId = global.stage.connect('notify::width', () => this._syncHudSize());
        this._stageHeightChangedId = global.stage.connect('notify::height', () => this._syncHudSize());
        this._workAreasChangedId = global.display.connect('workareas-changed', () => this._syncHudSize());
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._syncHudSize());
        this._scaleChangedId = St.ThemeContext.get_for_stage(global.stage).connect(
            'notify::scale-factor', () => this._syncHudSize()
        );
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._hud?.visible)
                this._hud.refreshClock();
            return GLib.SOURCE_CONTINUE;
        });
        this._gcRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            if (this._lastGoodStatus?.mode === 'startup')
                this._loadGcProfiles();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncVisibility() {
        if (!this._hud)
            return;
        const atSessionBoundary = Main.sessionMode.isLocked || Main.sessionMode.isGreeter;
        if (this._startupIndicator)
            this._startupIndicator.visible = this._lastGoodStatus?.mode === 'startup' &&
                this._lastGoodStatus.sessionId === this._currentSessionId && !atSessionBoundary;
        if (!this._dismissed && atSessionBoundary &&
            this._startupCanAutoDismiss(this._lastGoodStatus))
            this._recordStartupDismissal(this._lastGoodStatus, 'session-boundary');
        // Do not render or reserve input before a complete, valid document is
        // available.  In particular, extension enablement must be passive
        // while GNOME is bringing up the session and display stack.
        const eligible = this._lastGoodStatus?.showOnStartup === true || this._startupReopened;
        const visible = Boolean(this._lastGoodStatus) && eligible && !this._dismissed &&
            !atSessionBoundary;
        const becameVisible = visible && !this._hud.visible;
        this._hud.visible = visible;
        if (visible) {
            if (becameVisible)
                this._hud.refreshVisibleGc();
            this._hud.scheduleProgressFill();
        }
    }

    _scheduleLoad() {
        if (this._reloadTimeout)
            return;
        this._reloadTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._reloadTimeout = 0;
            this._loadStatus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleSessionIdRetry() {
        if (this._sessionIdRetryId || !this._hud)
            return;
        this._sessionIdRetryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000,
            () => {
                this._sessionIdRetryId = 0;
                this._resolveCurrentSessionId();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _resolveCurrentSessionId() {
        if (!this._hud || this._currentSessionId || this._sessionIdResolvePending)
            return;
        const epoch = this._enableEpoch;
        this._sessionIdResolvePending = true;
        Gio.DBus.session.call(
            DBUS_NAME,
            DBUS_PATH,
            DBUS_INTERFACE,
            'GetNameOwner',
            new GLib.Variant('(s)', [SESSION_MANAGER_NAME]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            2000,
            this._cancellable,
            (connection, result) => {
                if (!this._ownsEpoch(epoch))
                    return;
                this._sessionIdResolvePending = false;
                try {
                    const [owner] = connection.call_finish(result).deepUnpack();
                    this._currentSessionId = GLib.compute_checksum_for_string(
                        GLib.ChecksumType.SHA256,
                        String(owner),
                        -1
                    ).slice(0, 16);
                    this._loadStatus();
                } catch (error) {
                    console.warn(
                        `Login HUD could not identify the current GNOME session: ${error.message}`
                    );
                    this._scheduleSessionIdRetry();
                }
            }
        );
    }

    _isCurrentOperation(status) {
        return status?.operationId === this._lastGoodStatus?.operationId &&
            sameOperationContext(status?.operationContext, this._lastGoodStatus?.operationContext);
    }

    _loadStatus() {
        if (!this._currentSessionId) {
            this._resolveCurrentSessionId();
            return;
        }
        const epoch = this._enableEpoch;
        const serial = ++this._loadSerial;
        this._statusFile.load_contents_async(this._cancellable, (file, result) => {
            if (!this._ownsEpoch(epoch) || serial !== this._loadSerial)
                return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const parsed = normaliseStatus(JSON.parse(new TextDecoder().decode(bytes)));
                // Documents for any mode other than startup are ignored.
                if (!parsed)
                    return;
                if (parsed.sessionId !== this._currentSessionId) {
                    this._lastGoodStatus = null;
                    this._syncVisibility();
                    return;
                }
                const previousContext = this._lastGoodStatus?.operationContext;
                const isNewSessionOrMode = parsed.sessionId !== this._activeSessionId ||
                    parsed.mode !== this._activeMode ||
                    parsed.operationId !== this._activeOperationId ||
                    parsed.startedAt !== this._activeStartedAt ||
                    Boolean(parsed.operationContext && !sameOperationContext(parsed.operationContext, previousContext));
                if (isNewSessionOrMode) {
                    this._dismissed = false;
                    this._startupReopened = false;
                    this._startupAbortPending = false;
                    this._activeSessionId = parsed.sessionId;
                    this._activeMode = parsed.mode;
                    this._activeOperationId = parsed.operationId;
                    this._activeStartedAt = parsed.startedAt;
                    this._hud.resetExpansion();
                }
                if (this._startupDismissalMatches(parsed)) {
                    this._dismissed = true;
                } else if (!this._startupReopened && this._startupPresentationIsStale(parsed)) {
                    this._recordStartupDismissal(parsed, 'stale-completion');
                }
                this._lastGoodStatus = parsed;
                this._loadAlerts();
                this._loadGcProfiles();
                this._startupAbortPending = !startupRestorationTerminal(parsed) &&
                    (parsed.operationState === 'cancelling' || this._startupAbortMatches(parsed));
                if (parsed.showOnStartup || this._startupReopened) {
                    this._installHudChrome();
                    this._hud.setStatus(parsed);
                    this._hud.setStartupAbortPending(this._startupAbortPending);
                }
                this._syncVisibility();
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    if (!this._lastGoodStatus)
                        this._hud.setTransportNotice('Waiting for session status…');
                    return;
                }
                this._hud.setTransportNotice(`Waiting for a valid status update: ${error.message}`);
            }
        });
    }

    _loadAlerts() {
        if (!this._hud || !this._alertsFile || this._lastGoodStatus?.mode !== 'startup')
            return;
        const epoch = this._enableEpoch;
        const serial = ++this._alertsSerial;
        const file = this._alertsFile;
        file.query_info_async('standard::size,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, this._cancellable, (_file, result) => {
                if (!this._ownsEpoch(epoch) || serial !== this._alertsSerial)
                    return;
                try {
                    const info = file.query_info_finish(result);
                    if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > 2 * 1024 * 1024)
                        throw new Error('Invalid owned-system report file');
                    file.load_contents_async(this._cancellable, (_source, contents) => {
                        if (!this._ownsEpoch(epoch) || serial !== this._alertsSerial || this._lastGoodStatus?.mode !== 'startup')
                            return;
                        try {
                            const [, bytes] = file.load_contents_finish(contents);
                            this._hud.setAlerts(normalizeAlerts(JSON.parse(new TextDecoder().decode(bytes))));
                        } catch {
                            this._hud.setAlerts(null, 'Звіт власних систем недоступний або пошкоджений; це не означає, що все справне.');
                        }
                    });
                } catch {
                    this._hud.setAlerts(null, 'Очікую звіт власних систем. Перевірка: wsctl alerts scan');
                }
            });
    }

    _loadGcProfiles() {
        if (!this._hud || !this._gcStatusFile || this._lastGoodStatus?.mode !== 'startup')
            return;
        const epoch = this._enableEpoch;
        const serial = ++this._gcSerial;
        const file = this._gcStatusFile;
        file.query_info_async('standard::size,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, this._cancellable, (_file, result) => {
            if (!this._ownsEpoch(epoch) || serial !== this._gcSerial || this._lastGoodStatus?.mode !== 'startup')
                return;
            try {
                const info = file.query_info_finish(result);
                if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > GC_MAX_STATUS_BYTES)
                    throw new Error('Invalid GC profile status file');
                file.load_contents_async(this._cancellable, (_source, contents) => {
                    if (!this._ownsEpoch(epoch) || serial !== this._gcSerial || this._lastGoodStatus?.mode !== 'startup')
                        return;
                    try {
                        const [, bytes] = file.load_contents_finish(contents);
                        if (bytes.length > GC_MAX_STATUS_BYTES)
                            throw new Error('Invalid GC profile status file');
                        this._hud.setGcProfiles(normalizeGcProfiles(
                            JSON.parse(new TextDecoder().decode(bytes))
                        ));
                    } catch (error) {
                        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                            this._hud.setGcProfiles(null, 'Звіт GC-профілів ще недоступний.');
                        else
                            this._hud.setGcProfiles(null,
                                'Звіт GC-профілів недоступний або пошкоджений; це не означає, що все справне.');
                    }
                });
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._hud.setGcProfiles(null, 'Звіт GC-профілів ще недоступний.');
                else
                    this._hud.setGcProfiles(null,
                        'Звіт GC-профілів недоступний або пошкоджений; це не означає, що все справне.');
            }
        });
    }

    _ackAlert(source, code) {
        if (this._lastGoodStatus?.mode !== 'startup' ||
            !/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(source) || !/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(code))
            return;
        const epoch = this._enableEpoch;
        try {
            const process = Gio.Subprocess.new([
                GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'wsctl']),
                'alerts', 'ack', source, code,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            process.wait_check_async(this._cancellable, (_process, result) => {
                if (!this._ownsEpoch(epoch))
                    return;
                try {
                    process.wait_check_finish(result);
                    this._loadAlerts();
                } catch {
                    this._hud.setTransportNotice('Не вдалося позначити повідомлення переглянутим.');
                }
            });
        } catch {
            this._hud?.setTransportNotice('Команда wsctl alerts недоступна.');
        }
    }

    _openErrorLog(path) {
        if (!path) {
            this._hud?.reportLogLaunchFailure('no local error_log_path was supplied.');
            return;
        }

        const epoch = this._enableEpoch;
        const uri = Gio.File.new_for_path(path).get_uri();
        try {
            this._dismissed = true;
            this._syncVisibility();
            Gio.AppInfo.launch_default_for_uri_async(uri, null, this._cancellable, (_source, result) => {
                if (!this._ownsEpoch(epoch))
                    return;
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (error) {
                    this._dismissed = false;
                    this._syncVisibility();
                    this._hud?.reportLogLaunchFailure(error.message);
                }
            });
        } catch (error) {
            this._dismissed = false;
            this._syncVisibility();
            this._hud?.reportLogLaunchFailure(error.message);
        }
    }
}
