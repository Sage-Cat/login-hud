/* exported default */
/* global console TextEncoder */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {State as ModalDialogState} from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {BUILD_REVISION} from './buildInfo.js';
import {LoginHud} from './hudView.js';
import {
    STATUS_DIRECTORY, STATUS_FILENAME, ALERTS_FILENAME, GC_STATUS_FILENAME,
    DISMISSED_FILENAME, CANCEL_FILENAME, REQUEST_FILENAME, RENDERED_FILENAME,
    COMMIT_FILENAME, PREPARED_FILENAME, SESSION_MANAGER_NAME,
    SHUTDOWN_COORDINATOR_UNIT, DBUS_NAME, DBUS_PATH, DBUS_INTERFACE, SYSTEMD_NAME,
    SYSTEMD_PATH, SYSTEMD_MANAGER_INTERFACE, SYSTEMD_UNIT_INTERFACE,
    PROPERTIES_INTERFACE, TERMINAL_STATES, SHUTDOWN_ACTIONS,
    SHUTDOWN_COUNTDOWN_SECONDS, PREFLIGHT_STATUS_TIMEOUT_MS, GC_MAX_STATUS_BYTES,
    PREPARED_POLL_TIMEOUT_MS, STALE_STARTUP_PRESENTATION_MS,
    normaliseStatus, normalizeAlerts, normalizeGcProfiles,
    shutdownRecoveryPending, sameOperationContext,
} from './reports.js';

export default class LoginHudExtension extends Extension {
    enable() {
        this._enableEpoch = {};
        this._cancellable = new Gio.Cancellable();
        // Keep local withdrawal across Shell's disable/re-enable reordering.
        this._cancelledOperations ??= new Set();
        try {
            const [, boot] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
            this._bootId = new TextDecoder().decode(boot).trim();
            this._enable();
            if (this._legacyPassive)
                return;
            this._diagnostics = Gio.DBusExportedObject.wrapJSObject(
                '<node><interface name="org.sagecat.LoginHud"><method name="GetState"><arg type="s" direction="out"/></method></interface></node>', {
                    GetState: () => JSON.stringify({build: {
                        uuid: this.uuid, version: this.metadata.version, revision: BUILD_REVISION,
                        sourceIdentityKnown: BUILD_REVISION !== 'development',
                    }, visible: Boolean(this._hud?.visible), modal: Boolean(this._modalGrab),
                    operation_context: this._lastGoodStatus?.operationContext ?? null,
                    local_cancelled: this._isLocallyCancelled(this._lastGoodStatus),
                    recovery_pending: shutdownRecoveryPending(this._lastGoodStatus,
                        this._isLocallyCancelled(this._lastGoodStatus)),
                    cancel_request_written: Boolean(this._cancelRequestPending)}),
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
        this._cancelFile = this._statusDirectory.get_child(CANCEL_FILENAME);
        this._requestFile = this._statusDirectory.get_child(REQUEST_FILENAME);
        this._renderedFile = this._statusDirectory.get_child(RENDERED_FILENAME);
        this._commitFile = this._statusDirectory.get_child(COMMIT_FILENAME);
        this._preparedFile = this._statusDirectory.get_child(PREPARED_FILENAME);
        this._loadSerial = 0;
        this._reloadTimeout = 0;
        this._clockId = 0;
        this._shutdownCountdownId = 0;
        this._shutdownCountdownOperationId = null;
        this._shutdownCountdownSeconds = 0;
        this._renderAckScheduledOperationId = null;
        this._renderAckWrittenOperationId = null;
        this._commitWrittenOperationId = null;
        this._preparedCheckPending = false;
        this._preparedPollId = 0;
        this._nativeHandoffOperationId = null;
        this._preflightOperationId = null;
        this._preflightAction = null;
        this._preflightSignal = null;
        this._preflightStarting = false;
        this._preflightWatchdogId = 0;
        this._endSessionDialog = null;
        this._originalEndSessionConfirm = null;
        this._wrappedEndSessionConfirm = null;
        this._originalBootOptionsConfirm = null;
        this._wrappedBootOptionsConfirm = null;
        this._confirmBypass = false;
        this._lastGoodStatus = null;
        this._dismissed = false;
        this._activeSessionId = null;
        this._activeMode = null;
        this._activeOperationId = null;
        this._activeStartedAt = null;
        this._modalGrab = null;
        this._cancelRequestPending = false;
        this._nativeCancelledOperationId = null;
        this._locallyCancelledOperationId = null;
        this._chromeInstalled = false;
        this._panelChromeTracked = false;
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
            status => this._requestCancel(status),
            (source, code) => this._ackAlert(source, code)
        );
        this._hud.visible = false;
        this._hudKeyPressId = this._hud.connect('key-press-event',
            (_actor, event) => this._handleHudKeyPress(event));
        this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
            this._installEndSessionInterceptor();
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
                if (names.has(PREPARED_FILENAME))
                    this._checkPreparedHandoff();
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
        this._installEndSessionInterceptor();
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
        this._cleanup(() => this._nativeCloseCancel?.());
        this._nativeCloseCancel = null;
        this._cleanup(() => this._diagnostics?.unexport());
        this._diagnostics = null;
        if (this._legacyPassive) {
            this._legacyPassive = false;
            return;
        }
        if (this._reloadTimeout)
            this._cleanup(() => GLib.Source.remove(this._reloadTimeout));
        if (this._sessionIdRetryId)
            this._cleanup(() => GLib.Source.remove(this._sessionIdRetryId));
        if (this._preflightWatchdogId)
            this._cleanup(() => GLib.Source.remove(this._preflightWatchdogId));
        this._cleanup(() => this._stopPreparedPolling());
        this._cleanup(() => this._cancelShutdownCountdown());
        this._cleanup(() => this._abortActivePreflightOnDisable());
        this._cleanup(() => this._restoreEndSessionInterceptor());
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
        this._releaseModal();
        if (this._hud) {
            this._cleanup(() => this._hud.cancelDeferredUpdates());
            if (this._hudKeyPressId)
                this._cleanup(() => this._hud.disconnect(this._hudKeyPressId));
            if (this._panelChromeTracked)
                this._cleanup(() => Main.layoutManager.untrackChrome(this._hud.getInteractiveActor()));
            if (this._chromeInstalled)
                this._cleanup(() => Main.layoutManager.removeChrome(this._hud));
            this._cleanup(() => this._hud.destroy());
        }

        this._reloadTimeout = 0;
        this._sessionIdRetryId = 0;
        this._shutdownCountdownId = 0;
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
        this._hudKeyPressId = 0;
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
        this._cancelFile = null;
        this._requestFile = null;
        this._renderedFile = null;
        this._commitFile = null;
        this._preparedFile = null;
        this._statusDirectory = null;
        this._activeSessionId = null;
        this._activeMode = null;
        this._activeOperationId = null;
        this._activeStartedAt = null;
        this._modalGrab = null;
        this._cancelRequestPending = false;
        this._nativeCancelledOperationId = null;
        this._locallyCancelledOperationId = null;
        this._shutdownCountdownOperationId = null;
        this._shutdownCountdownSeconds = 0;
        this._renderAckScheduledOperationId = null;
        this._renderAckWrittenOperationId = null;
        this._commitWrittenOperationId = null;
        this._preparedCheckPending = false;
        this._preparedPollId = 0;
        this._nativeHandoffOperationId = null;
        this._preflightOperationId = null;
        this._preflightAction = null;
        this._preflightSignal = null;
        this._preflightStarting = false;
        this._preflightWatchdogId = 0;
        this._endSessionDialog = null;
        this._originalEndSessionConfirm = null;
        this._wrappedEndSessionConfirm = null;
        this._originalBootOptionsConfirm = null;
        this._wrappedBootOptionsConfirm = null;
        this._confirmBypass = false;
    }

    _installEndSessionInterceptor() {
        const dialog = Main.endSessionDialog;
        if (dialog && dialog === this._endSessionDialog)
            return;
        if (!dialog || typeof dialog._confirm !== 'function') {
            console.warn('Login HUD cannot install the GNOME end-session preflight interceptor.');
            return;
        }

        this._restoreEndSessionInterceptor();
        this._endSessionDialog = dialog;
        this._originalEndSessionConfirm = dialog._confirm;
        this._wrappedEndSessionConfirm = async signal => {
            if (this._confirmBypass)
                return this._originalEndSessionConfirm.call(dialog, signal);
            return this._interceptEndSessionConfirm(signal);
        };
        dialog._confirm = this._wrappedEndSessionConfirm;

        // "Boot Options" mutates logind state before calling _confirm(). It
        // cannot be safely cancellable once that mutation has happened, so it
        // retains GNOME's native path and is deliberately outside preflight.
        if (typeof dialog._confirmRebootToBootLoaderMenu === 'function') {
            this._originalBootOptionsConfirm = dialog._confirmRebootToBootLoaderMenu;
            this._wrappedBootOptionsConfirm = (...args) => {
                this._confirmBypass = true;
                try {
                    return this._originalBootOptionsConfirm.call(dialog, ...args);
                } finally {
                    this._confirmBypass = false;
                }
            };
            dialog._confirmRebootToBootLoaderMenu = this._wrappedBootOptionsConfirm;
        }
    }

    _restoreEndSessionInterceptor() {
        if (
            this._endSessionDialog &&
            this._endSessionDialog._confirm === this._wrappedEndSessionConfirm
        )
            this._endSessionDialog._confirm = this._originalEndSessionConfirm;
        if (
            this._endSessionDialog &&
            this._endSessionDialog._confirmRebootToBootLoaderMenu ===
                this._wrappedBootOptionsConfirm
        )
            this._endSessionDialog._confirmRebootToBootLoaderMenu =
                this._originalBootOptionsConfirm;
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

    _resolveCurrentSessionIdSync() {
        if (this._currentSessionId)
            return this._currentSessionId;
        try {
            const result = Gio.DBus.session.call_sync(
                DBUS_NAME,
                DBUS_PATH,
                DBUS_INTERFACE,
                'GetNameOwner',
                new GLib.Variant('(s)', [SESSION_MANAGER_NAME]),
                new GLib.VariantType('(s)'),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );
            const [owner] = result.deepUnpack();
            this._currentSessionId = GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256,
                String(owner),
                -1
            ).slice(0, 16);
        } catch (error) {
            console.warn(`Login HUD could not identify the session for shutdown: ${error.message}`);
        }
        return this._currentSessionId;
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

    _closeNativeDialogBeforePreflight() {
        const dialog = this._endSessionDialog;
        dialog._stopTimer?.();
        dialog._stopAltCapture?.();
        if (dialog.state === ModalDialogState.CLOSED)
            return Promise.resolve();

        return new Promise((resolve, reject) => {
            let closedId = 0;
            let timeoutId = 0;
            let settled = false;
            const finish = error => {
                if (settled)
                    return;
                settled = true;
                this._nativeCloseCancel = null;
                if (closedId) {
                    dialog.disconnect(closedId);
                    closedId = 0;
                }
                if (timeoutId) {
                    GLib.Source.remove(timeoutId);
                    timeoutId = 0;
                }
                if (error)
                    reject(error);
                else
                    resolve();
            };
            this._nativeCloseCancel = () => finish(new Error('HUD disabled while closing confirmation'));
            closedId = dialog.connect('closed', () => finish());
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                timeoutId = 0;
                if (dialog.state === ModalDialogState.CLOSED)
                    finish();
                else
                    finish(new Error('the native GNOME confirmation did not close'));
                return GLib.SOURCE_REMOVE;
            });
            dialog.close(true);
            if (dialog.state === ModalDialogState.CLOSED)
                finish();
        });
    }

    async _interceptEndSessionConfirm(signal) {
        const action = signal === 'ConfirmedShutdown'
            ? 'poweroff'
            : signal === 'ConfirmedReboot' ? 'restart' : null;
        if (!action)
            return this._originalEndSessionConfirm.call(this._endSessionDialog, signal);

        // The extension is safe to install on its own. If the companion
        // coordinator is missing or inactive, preserve GNOME's native action
        // instead of retaining it for a preflight that cannot complete.
        if (!this._shutdownCoordinatorIsActive()) {
            console.warn(
                'Login HUD shutdown coordinator is unavailable; using GNOME native shutdown.'
            );
            return this._originalEndSessionConfirm.call(this._endSessionDialog, signal);
        }

        // Keep the interceptor alive on the lock screen, but never expose the
        // workspace HUD there. GNOME's timer also reaches this path: cancel its
        // native request instead of silently powering off without a checkpoint.
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            this._endSessionDialog.cancel();
            console.info('Login HUD: shutdown cancelled while locked; unlock before retrying.');
            Main.notify('Unlock before shutting down',
                'Unlock the desktop and try again to save your workspace.');
            return;
        }

        // GNOME may show a second "Power Off Anyway" dialog after another
        // application adds a JIT inhibitor. That confirmation continues the
        // already prepared operation and must never start a second preflight.
        if (this._nativeHandoffOperationId)
            return this._originalEndSessionConfirm.call(this._endSessionDialog, signal);

        if (this._preflightStarting ||
            (this._preflightOperationId && !this._nativeHandoffOperationId))
            return;

        const epoch = this._enableEpoch;
        this._preflightStarting = true;
        const sessionId = this._resolveCurrentSessionIdSync();
        const operationId = GLib.uuid_string_random().replaceAll('-', '');
        try {
            if (!sessionId)
                throw new Error('the current GNOME session could not be identified');
            // The normal button path calls _confirm from the dialog's closed
            // signal. The automatic timer calls it while the dialog is still
            // open, so wait for that modal to be fully gone before publishing
            // any request that can make the HUD visible.
            await this._closeNativeDialogBeforePreflight();
            if (!this._ownsEpoch(epoch))
                return;
            this._writeProtocolFile(this._requestFile, 'shutdown-request', {
                schema_version: 1,
                operation_id: operationId,
                session_id: sessionId,
                action,
                requested_at: new Date().toISOString(),
            });
            this._preflightOperationId = operationId;
            this._preflightAction = action;
            this._preflightSignal = signal;
            this._startPreflightWatchdog(operationId, sessionId);
            this._nativeHandoffOperationId = null;
            this._renderAckScheduledOperationId = null;
            this._renderAckWrittenOperationId = null;
            this._commitWrittenOperationId = null;
            this._cancelShutdownCountdown();
        } catch (error) {
            if (!this._ownsEpoch(epoch))
                return;
            console.error(`Login HUD could not start shutdown preflight: ${error.message}`);
            if (this._preflightOperationId === operationId) {
                try {
                    this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                        schema_version: 1,
                        operation_id: operationId,
                        session_id: sessionId,
                        requested_at: new Date().toISOString(),
                    });
                } catch (cancelError) {
                    console.warn(`Login HUD could not cancel backend work: ${cancelError.message}`);
                }
                this._locallyCancelledOperationId = operationId;
                if (this._preflightWatchdogId)
                    GLib.Source.remove(this._preflightWatchdogId);
                this._preflightWatchdogId = 0;
                this._preflightOperationId = null;
                this._preflightAction = null;
                this._preflightSignal = null;
            }
            Main.notifyError(
                'Shutdown cancelled safely',
                `The shutdown HUD could not start: ${error.message}`
            );
            // The SessionManager already has an open DBus request. Explicitly
            // cancel it on startup failure so GNOME does not remain wedged.
            this._cancelNativeEndSessionOnce(operationId);
        } finally {
            if (this._ownsEpoch(epoch))
                this._preflightStarting = false;
        }
    }

    _shutdownCoordinatorIsActive() {
        try {
            const unitResult = Gio.DBus.session.call_sync(
                SYSTEMD_NAME,
                SYSTEMD_PATH,
                SYSTEMD_MANAGER_INTERFACE,
                'GetUnit',
                new GLib.Variant('(s)', [SHUTDOWN_COORDINATOR_UNIT]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );
            const [unitPath] = unitResult.deepUnpack();
            const stateResult = Gio.DBus.session.call_sync(
                SYSTEMD_NAME,
                unitPath,
                PROPERTIES_INTERFACE,
                'Get',
                new GLib.Variant('(ss)', [SYSTEMD_UNIT_INTERFACE, 'ActiveState']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );
            const [activeState] = stateResult.recursiveUnpack();
            return activeState === 'active';
        } catch (error) {
            console.warn(`Login HUD could not verify shutdown coordinator: ${error.message}`);
            return false;
        }
    }

    _startPreflightWatchdog(operationId, sessionId) {
        if (this._preflightWatchdogId)
            GLib.Source.remove(this._preflightWatchdogId);
        this._preflightWatchdogId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PREFLIGHT_STATUS_TIMEOUT_MS,
            () => {
                this._preflightWatchdogId = 0;
                if (!this._hud || this._preflightOperationId !== operationId ||
                    this._activeOperationId === operationId)
                    return GLib.SOURCE_REMOVE;
                try {
                    this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                        schema_version: 1,
                        operation_id: operationId,
                        session_id: sessionId,
                        requested_at: new Date().toISOString(),
                    });
                } catch (error) {
                    console.warn(`Login HUD preflight timeout cleanup failed: ${error.message}`);
                }
                this._locallyCancelledOperationId = operationId;
                this._cancelNativeEndSessionOnce(operationId);
                this._preflightOperationId = null;
                this._preflightAction = null;
                this._preflightSignal = null;
                Main.notifyError(
                    'Shutdown cancelled safely',
                    'The shutdown coordinator did not publish HUD status in time.'
                );
                return GLib.SOURCE_REMOVE;
            }
        );
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
        if (status?.mode !== 'startup')
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
            // completed HUD again, but shutdown interception remains intact.
            console.warn(`Login HUD could not persist startup dismissal: ${error.message}`);
        }
    }

    _handleHudKeyPress(event) {
        if (event.get_key_symbol() !== Clutter.KEY_Escape ||
            this._lastGoodStatus?.mode !== 'shutdown')
            return Clutter.EVENT_PROPAGATE;
        this._dismissHud();
        return Clutter.EVENT_STOP;
    }

    _dismissHud() {
        const status = this._lastGoodStatus;
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        if (status?.mode === 'shutdown') {
            if (!status.cancelled && !hasFailure) {
                this._requestCancel(status);
                return;
            }
            // Hiding the report does not stop backend recovery. It must never
            // allow a delayed ready update to authorize this shutdown again.
            this._withdrawShutdownAuthority(status);
        }
        if (status?.mode === 'startup')
            this._recordStartupDismissal(status, 'user');
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
            if (this._modalGrab && !this._hasShutdownAuthority(this._lastGoodStatus))
                this._releaseModal();
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
        if (!this._dismissed && atSessionBoundary &&
            this._startupCanAutoDismiss(this._lastGoodStatus))
            this._recordStartupDismissal(this._lastGoodStatus, 'session-boundary');
        // Do not render or reserve input before a complete, valid document is
        // available.  In particular, extension enablement must be passive
        // while GNOME is bringing up the session and display stack.
        const eligible = this._lastGoodStatus?.mode === 'shutdown' ||
            this._lastGoodStatus?.showOnStartup === true;
        const visible = Boolean(this._lastGoodStatus) && eligible && !this._dismissed &&
            !atSessionBoundary;
        if (!visible)
            this._releaseModal();
        const becameVisible = visible && !this._hud.visible;
        this._hud.visible = visible;
        if (visible) {
            if (becameVisible)
                this._hud.refreshVisibleGc();
            this._hud.scheduleProgressFill();
            this._syncModal();
            this._scheduleRenderedShutdownAck(this._lastGoodStatus);
        }
    }

    _syncModal() {
        const status = this._lastGoodStatus;
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        const shouldBeModal = this._hud?.visible && status?.mode === 'shutdown' &&
            !status.cancelled && !hasFailure && this._hasShutdownAuthority(status);
        if (!shouldBeModal) {
            this._releaseModal();
            return;
        }
        this._hud.reactive = true;
        if (this._modalGrab) {
            this._hud.focusPrimaryAction();
            return;
        }
        const grab = Main.pushModal(this._hud, {
            actionMode: Shell.ActionMode.SYSTEM_MODAL,
        });
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            this._hud.setTransportNotice(
                'Exclusive keyboard/pointer control is temporarily unavailable; ' +
                'cancellation remains available without an input grab.'
            );
            return;
        }
        this._modalGrab = grab;
        Main.layoutManager.emit('system-modal-opened');
        this._hud.focusPrimaryAction();
    }

    _releaseModal() {
        if (this._modalGrab) {
            const grab = this._modalGrab;
            this._modalGrab = null;
            try {
                Main.popModal(grab);
            } catch (error) {
                console.warn(`Login HUD modal cleanup failed: ${error.message}`);
            }
        }
        if (this._hud)
            this._hud.reactive = false;
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
                    this._recoverPendingPreflightRequest();
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

    _recoverPendingPreflightRequest() {
        if (this._preflightOperationId || !this._requestFile)
            return;
        const request = this._readProtocolFileSync(this._requestFile);
        const requestedAt = Date.parse(request?.requested_at);
        const age = Date.now() - requestedAt;
        const recent = Number.isFinite(requestedAt) && age >= 0 && age <= 120000;
        if (request?.schema_version !== 1 ||
            !/^[0-9a-f]{32}$/.test(request.operation_id) ||
            request.session_id !== this._currentSessionId ||
            !SHUTDOWN_ACTIONS.has(request.action) || !recent)
            return;
        if (this._isLocallyCancelled({operationId: request.operation_id,
            sessionId: request.session_id}))
            return;
        const cancellation = this._readProtocolFileSync(this._cancelFile);
        if (cancellation?.schema_version === 1 &&
            cancellation.operation_id === request.operation_id &&
            cancellation.session_id === request.session_id)
            return;

        this._preflightOperationId = request.operation_id;
        this._preflightAction = request.action;
        this._preflightSignal = request.action === 'restart'
            ? 'ConfirmedReboot' : 'ConfirmedShutdown';
        this._startPreflightWatchdog(request.operation_id, request.session_id);
    }

    _isLocallyCancelled(status) {
        return Boolean(status?.operationId) && (status.operationId === this._locallyCancelledOperationId ||
            this._cancelledOperations?.has(`${status.sessionId}:${status.operationId}`) === true);
    }

    _shutdownOperationBinding(status, request = this._readProtocolFileSync(this._requestFile)) {
        const validRequest = request?.schema_version === 1 &&
            /^[0-9a-f]{32}$/.test(request.operation_id) &&
            request.session_id === this._currentSessionId && SHUTDOWN_ACTIONS.has(request.action);
        const shutdown = status?.mode === 'shutdown' && status.sessionId === this._currentSessionId;
        const matchesRequest = shutdown && validRequest &&
            request.operation_id === status.operationId && request.action === status.shutdownAction;
        const matchesLocalPreflight = shutdown && Boolean(this._preflightOperationId) &&
            status.operationId === this._preflightOperationId &&
            status.shutdownAction === this._preflightAction;
        // A live confirmation owns the transaction even if its request file
        // still contains an older operation. Withdrawn requests are passive.
        const localOperationId = this._preflightOperationId || this._nativeHandoffOperationId;
        const currentOperationId = localOperationId || (validRequest &&
            !this._isLocallyCancelled({operationId: request.operation_id, sessionId: request.session_id})
            ? request.operation_id : null);
        const matchesCurrent = !this._preflightStarting && shutdown && Boolean(currentOperationId) &&
            status.operationId === currentOperationId && (localOperationId
                ? status.shutdownAction === (this._preflightAction || this._lastGoodStatus?.shutdownAction)
                : matchesRequest);
        return {matchesRequest, matchesLocalPreflight, currentOperationId, matchesCurrent};
    }

    _isCurrentOperation(status) {
        return status?.operationId === this._lastGoodStatus?.operationId &&
            sameOperationContext(status?.operationContext, this._lastGoodStatus?.operationContext);
    }

    _hasShutdownAuthority(status) {
        const context = status?.operationContext;
        return Boolean(context) && context.mode === 'shutdown' &&
            context.boot_id === this._bootId && context.login_generation === this._currentSessionId &&
            context.operation_id === status.operationId &&
            context.deadline > GLib.get_monotonic_time() / 1000000 &&
            !this._isLocallyCancelled(status);
    }

    _withdrawShutdownAuthority(status) {
        this._locallyCancelledOperationId = status.operationId;
        this._cancelledOperations ??= new Set();
        this._cancelledOperations.add(`${status.sessionId}:${status.operationId}`);
        this._cancelShutdownCountdown();
        this._stopPreparedPolling();
        this._releaseModal();
    }

    _shutdownStatusReady(status) {
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        return status?.mode === 'shutdown' && !status.cancelled && !hasFailure &&
            this._hasShutdownAuthority(status) &&
            ['prepared', 'authorized'].includes(status.operationState) &&
            ['ready', 'degraded'].includes(status.overallState) &&
            status.operationId !== this._locallyCancelledOperationId &&
            status.stages.length > 0 &&
            status.stages.every(stage => TERMINAL_STATES.has(stage.state));
    }

    _shutdownHudVisible(status) {
        const panel = this._hud?.getInteractiveActor();
        return this._shutdownStatusReady(status) && this._hud?.visible && this._hud.mapped &&
            panel?.mapped && panel.width > 0 && panel.height > 0 &&
            !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
    }

    _cancelUnseenShutdown(status) {
        this._cancelShutdownCountdown();
        const requested = this._requestCancel(status);
        this._hud?.setTransportNotice(
            requested
                ? 'Shutdown cancellation requested because its final countdown was no longer visible. Prepared jobs are being restored.'
                : 'Shutdown remains stopped: the countdown is not visible and cancellation could not be confirmed.'
        );
    }

    _cancelShutdownCountdown() {
        if (this._shutdownCountdownId)
            GLib.Source.remove(this._shutdownCountdownId);
        this._shutdownCountdownId = 0;
        this._shutdownCountdownOperationId = null;
        this._shutdownCountdownSeconds = 0;
    }

    _scheduleRenderedShutdownAck(status) {
        if (!this._shutdownStatusReady(status)) {
            if (status?.operationId === this._shutdownCountdownOperationId) {
                this._cancelShutdownCountdown();
                this._renderAckWrittenOperationId = null;
            }
            if (status?.operationId === this._renderAckScheduledOperationId)
                this._renderAckScheduledOperationId = null;
            return;
        }
        if (!this._hud?.visible || status.operationId === this._renderAckWrittenOperationId ||
            status.operationId === this._renderAckScheduledOperationId)
            return;

        const epoch = this._enableEpoch;
        const operationId = status.operationId;
        this._renderAckScheduledOperationId = operationId;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._ownsEpoch(epoch) || !this._isCurrentOperation(status))
                return GLib.SOURCE_REMOVE;
            if (this._activeOperationId !== operationId ||
                !this._shutdownStatusReady(this._lastGoodStatus)) {
                if (this._renderAckScheduledOperationId === operationId)
                    this._renderAckScheduledOperationId = null;
                return GLib.SOURCE_REMOVE;
            }
            const panel = this._hud.getInteractiveActor();
            if (!this._hud.visible) {
                this._renderAckScheduledOperationId = null;
                return GLib.SOURCE_REMOVE;
            }
            if (!this._hud.mapped || !panel.mapped || panel.width <= 0 || panel.height <= 0)
                return GLib.SOURCE_CONTINUE;

            global.stage.queue_redraw();
            Clutter.threads_add_repaint_func_full(
                Clutter.RepaintFlags.POST_PAINT,
                () => {
                    if (!this._ownsEpoch(epoch) || !this._isCurrentOperation(status))
                        return false;
                    if (this._activeOperationId !== operationId ||
                        !this._shutdownStatusReady(this._lastGoodStatus)) {
                        if (this._renderAckScheduledOperationId === operationId)
                            this._renderAckScheduledOperationId = null;
                        return false;
                    }
                    if (!this._shutdownHudVisible(this._lastGoodStatus)) {
                        this._renderAckScheduledOperationId = null;
                        return false;
                    }
                    try {
                        this._writeProtocolFile(this._renderedFile, 'shutdown-hud-rendered', {
                            schema_version: 1,
                            operation_id: operationId,
                            session_id: this._lastGoodStatus.sessionId,
                            operation_context: this._lastGoodStatus.operationContext,
                            rendered_at: new Date().toISOString(),
                        });
                        this._renderAckWrittenOperationId = operationId;
                        this._startShutdownCountdown(this._lastGoodStatus);
                    } catch (error) {
                        this._renderAckScheduledOperationId = null;
                        this._hud.setTransportNotice(
                            `Ready, but the visual acknowledgement failed: ${error.message}`
                        );
                    }
                    return false;
                }
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _startShutdownCountdown(status) {
        if (this._shutdownCountdownId ||
            this._shutdownCountdownOperationId === status.operationId ||
            this._commitWrittenOperationId === status.operationId)
            return;
        const epoch = this._enableEpoch;
        const operationId = status.operationId;
        const action = status.shutdownAction ||
            (this._preflightOperationId === operationId ? this._preflightAction : null);
        let seconds = SHUTDOWN_COUNTDOWN_SECONDS;
        this._shutdownCountdownOperationId = operationId;
        this._shutdownCountdownSeconds = seconds;
        this._hud.setShutdownCountdown(action, seconds);
        this._hud.focusPrimaryAction();
        global.stage.queue_redraw();
        Clutter.threads_add_repaint_func_full(
            Clutter.RepaintFlags.POST_PAINT,
            () => {
                if (!this._ownsEpoch(epoch) || !this._isCurrentOperation(status) || this._shutdownCountdownOperationId !== operationId ||
                    !this._shutdownStatusReady(this._lastGoodStatus))
                    return false;
                if (!this._shutdownHudVisible(this._lastGoodStatus)) {
                    this._cancelUnseenShutdown(this._lastGoodStatus);
                    return false;
                }
                console.info(`Login HUD: visible ${SHUTDOWN_COUNTDOWN_SECONDS}s countdown; operation=${operationId}`);
                const began = GLib.get_monotonic_time();
                this._shutdownCountdownId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    100,
                    () => {
                        if (!this._ownsEpoch(epoch) || !this._isCurrentOperation(status))
                            return GLib.SOURCE_REMOVE;
                        if (this._activeOperationId !== operationId ||
                            !this._shutdownStatusReady(this._lastGoodStatus)) {
                            this._shutdownCountdownId = 0;
                            this._shutdownCountdownOperationId = null;
                            this._shutdownCountdownSeconds = 0;
                            return GLib.SOURCE_REMOVE;
                        }
                        if (!this._shutdownHudVisible(this._lastGoodStatus)) {
                            this._cancelUnseenShutdown(this._lastGoodStatus);
                            return GLib.SOURCE_REMOVE;
                        }
                        const elapsed = (GLib.get_monotonic_time() - began) / 1000000;
                        const remaining = Math.ceil(SHUTDOWN_COUNTDOWN_SECONDS - elapsed);
                        if (remaining > 0) {
                            if (remaining !== seconds) {
                                seconds = remaining;
                                this._shutdownCountdownSeconds = seconds;
                                this._hud.setShutdownCountdown(action, seconds);
                                this._hud.focusPrimaryAction();
                            }
                            return GLib.SOURCE_CONTINUE;
                        }
                        this._shutdownCountdownId = 0;
                        this._shutdownCountdownOperationId = null;
                        this._shutdownCountdownSeconds = 0;
                        this._commitShutdown(this._lastGoodStatus);
                        return GLib.SOURCE_REMOVE;
                    }
                );
                return false;
            }
        );
    }

    _commitShutdown(status) {
        if (!this._isCurrentOperation(status) || !this._shutdownStatusReady(status) ||
            this._commitWrittenOperationId === status.operationId)
            return;
        if (!this._shutdownHudVisible(status)) {
            this._cancelUnseenShutdown(status);
            return;
        }
        try {
            this._writeProtocolFile(this._commitFile, 'shutdown-commit', {
                schema_version: 1,
                operation_id: status.operationId,
                session_id: status.sessionId,
                ...(status.operationContext ? {operation_context: status.operationContext} : {}),
                committed_at: new Date().toISOString(),
            });
            this._commitWrittenOperationId = status.operationId;
            this._hud.setAwaitingPrepared(status.shutdownAction || this._preflightAction);
            this._startPreparedPolling(status.operationId);
            this._checkPreparedHandoff();
        } catch (error) {
            this._hud.setTransportNotice(
                `Shutdown remains stopped because commit failed: ${error.message}`
            );
        }
    }

    _startPreparedPolling(operationId) {
        this._stopPreparedPolling();
        const began = GLib.get_monotonic_time();
        this._preparedPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            100,
            () => {
                if (!this._hud || this._activeOperationId !== operationId ||
                    this._commitWrittenOperationId !== operationId ||
                    this._nativeHandoffOperationId ||
                    this._locallyCancelledOperationId === operationId) {
                    this._preparedPollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                const elapsedMs = (GLib.get_monotonic_time() - began) / 1000;
                if (elapsedMs >= PREPARED_POLL_TIMEOUT_MS) {
                    this._preparedPollId = 0;
                    const status = this._lastGoodStatus;
                    const cancelled = status?.operationId === operationId &&
                        this._requestCancel(status);
                    if (cancelled) {
                        this._dismissed = true;
                        this._syncVisibility();
                        Main.notifyError(
                            'Shutdown cancelled safely',
                            'The coordinator did not publish final authorization in time.'
                        );
                    }
                    return GLib.SOURCE_REMOVE;
                }
                this._checkPreparedHandoff();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPreparedPolling() {
        if (this._preparedPollId)
            GLib.Source.remove(this._preparedPollId);
        this._preparedPollId = 0;
    }

    _checkPreparedHandoff() {
        const status = this._lastGoodStatus;
        if (!this._hud || this._preparedCheckPending ||
            status?.shutdownOrigin !== 'preflight' ||
            this._commitWrittenOperationId !== status.operationId ||
            this._nativeHandoffOperationId)
            return;
        try {
            const info = this._preparedFile.query_info(
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR) {
                this._hud.setTransportNotice(
                    'Shutdown remains stopped because the prepared marker is not a regular file.'
                );
                return;
            }
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                this._hud.setTransportNotice(
                    `Shutdown remains stopped while readiness is checked: ${error.message}`
                );
            return;
        }
        const epoch = this._enableEpoch;
        this._preparedCheckPending = true;
        this._preparedFile.load_contents_async(this._cancellable, (file, result) => {
            if (!this._ownsEpoch(epoch))
                return;
            this._preparedCheckPending = false;
            if (!this._hud || !this._isCurrentOperation(status))
                return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const prepared = JSON.parse(new TextDecoder().decode(bytes));
                if (prepared.schema_version !== 1 ||
                    prepared.operation_id !== status.operationId ||
                    prepared.session_id !== status.sessionId ||
                    prepared.action !== status.shutdownAction ||
                    !sameOperationContext(prepared.operation_context, status.operationContext))
                    return;
                this._handoffToGnome(status);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._hud.setTransportNotice(
                        `Shutdown remains stopped while readiness is checked: ${error.message}`
                    );
            }
        });
    }

    _handoffToGnome(status) {
        if (!this._isCurrentOperation(status) || !this._shutdownStatusReady(status) || this._nativeHandoffOperationId ||
            this._commitWrittenOperationId !== status.operationId)
            return;
        if (!this._shutdownHudVisible(this._lastGoodStatus) ||
            this._lastGoodStatus?.operationId !== status.operationId) {
            this._cancelUnseenShutdown(this._lastGoodStatus);
            return;
        }
        const signal = this._preflightOperationId === status.operationId
            ? this._preflightSignal
            : status.shutdownAction === 'restart'
                ? 'ConfirmedReboot'
                : status.shutdownAction === 'poweroff' ? 'ConfirmedShutdown' : null;
        if (!signal) {
            this._hud.setTransportNotice(
                'Shutdown remains stopped because the original GNOME action is unknown.'
            );
            return;
        }

        this._nativeHandoffOperationId = status.operationId;
        console.info(`Login HUD: completed visible countdown, handing off ${status.shutdownAction}; operation=${status.operationId}`);
        this._stopPreparedPolling();
        this._hud.setHandoffStarted(status.shutdownAction || this._preflightAction);
        const epoch = this._enableEpoch;
        this._confirmBypass = true;
        try {
            Promise.resolve(this._originalEndSessionConfirm.call(this._endSessionDialog, signal))
                .catch(error => {
                    if (this._ownsEpoch(epoch))
                        this._handleNativeHandoffFailure(status, error);
                });
        } catch (error) {
            this._handleNativeHandoffFailure(status, error);
        } finally {
            this._confirmBypass = false;
        }
    }

    _handleNativeHandoffFailure(status, error) {
        if (this._nativeHandoffOperationId !== status.operationId)
            return;
        console.error(`Login HUD GNOME handoff failed: ${error.message}`);
        this._nativeHandoffOperationId = null;
        this._locallyCancelledOperationId = status.operationId;
        try {
            this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                schema_version: 1,
                operation_id: status.operationId,
                session_id: status.sessionId,
                ...(status.operationContext ? {operation_context: status.operationContext} : {}),
                requested_at: new Date().toISOString(),
            });
        } catch (cancelError) {
            console.warn(
                `Login HUD could not cancel a rejected GNOME handoff: ${cancelError.message}`
            );
        }
        this._cancelNativeEndSessionOnce(status.operationId);
        if (this._preflightOperationId === status.operationId) {
            this._preflightOperationId = null;
            this._preflightAction = null;
            this._preflightSignal = null;
        }
        this._dismissed = true;
        this._syncVisibility();
        this._hud?.setTransportNotice(
            `Shutdown cancelled because GNOME rejected the final handoff: ${error.message}`
        );
        Main.notifyError(
            'Shutdown cancelled safely',
            `GNOME rejected the final shutdown handoff: ${error.message}`
        );
    }

    _handleTerminalShutdownStatus(status) {
        if (!this._shutdownOperationBinding(status).matchesCurrent ||
            ((status.operationContext || this._lastGoodStatus?.operationContext) &&
                !this._isCurrentOperation(status)))
            return;
        const hasFailure = status.overallState === 'failed' ||
            status.stages.some(stage => stage.state === 'failed');
        if (!status.cancelled && !hasFailure)
            return;

        const wasHandedOff = this._nativeHandoffOperationId === status.operationId;
        this._withdrawShutdownAuthority(status);
        this._renderAckScheduledOperationId = null;
        if (this._renderAckWrittenOperationId === status.operationId)
            this._renderAckWrittenOperationId = null;
        if (this._commitWrittenOperationId === status.operationId)
            this._commitWrittenOperationId = null;
        if (hasFailure) {
            try {
                this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                    schema_version: 1,
                    operation_id: status.operationId,
                    session_id: status.sessionId,
                    ...(status.operationContext ? {operation_context: status.operationContext} : {}),
                    requested_at: new Date().toISOString(),
                });
            } catch (error) {
                this._hud.setTransportNotice(
                    `Shutdown is stopped, but backend recovery could not be requested: ${error.message}`
                );
            }
        }
        // A terminal failure/cancellation ends the pending GNOME request
        // exactly once. Repeated cancel calls can accidentally close a new
        // dialog opened immediately afterwards.
        if (wasHandedOff) {
            // GNOME emitted CancelEndSession after the handed-off operation.
            // Mark that native side terminal before clearing handoff state so
            // repeated status writes cannot emit Canceled into a later dialog.
            this._nativeCancelledOperationId = status.operationId;
            this._nativeHandoffOperationId = null;
        } else {
            this._cancelNativeEndSessionOnce(status.operationId);
        }
        if (this._preflightOperationId === status.operationId) {
            this._preflightOperationId = null;
            this._preflightAction = null;
            this._preflightSignal = null;
        }
    }

    _cancelNativeEndSessionOnce(operationId) {
        if (!operationId || this._nativeCancelledOperationId === operationId)
            return;
        this._nativeCancelledOperationId = operationId;
        try {
            Main.endSessionDialog?.cancel?.();
        } catch (error) {
            console.warn(`Login HUD could not cancel GNOME's shutdown dialog: ${error.message}`);
        }
    }

    _abortActivePreflightOnDisable() {
        const operationId = this._preflightOperationId;
        if (!operationId || this._nativeHandoffOperationId === operationId)
            return;
        this._withdrawShutdownAuthority({operationId, sessionId: this._currentSessionId});
        try {
            this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                schema_version: 1,
                operation_id: operationId,
                session_id: this._currentSessionId,
                ...(this._lastGoodStatus?.operationId === operationId && this._lastGoodStatus.operationContext
                    ? {operation_context: this._lastGoodStatus.operationContext} : {}),
                requested_at: new Date().toISOString(),
            });
        } catch (error) {
            console.warn(`Login HUD could not cancel backend work while disabling: ${error.message}`);
        }
        this._cancelNativeEndSessionOnce(operationId);
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
                const request = parsed.mode === 'shutdown'
                    ? this._readProtocolFileSync(this._requestFile) : null;
                const {matchesRequest, matchesLocalPreflight, currentOperationId, matchesCurrent} =
                    this._shutdownOperationBinding(parsed, request);
                if ((this._preflightStarting || currentOperationId) && !matchesCurrent)
                    return;
                if (parsed.sessionId !== this._currentSessionId) {
                    this._lastGoodStatus = null;
                    this._syncVisibility();
                    return;
                }
                const terminalShutdown = parsed.mode === 'shutdown' &&
                    (parsed.cancelled || parsed.overallState === 'failed' ||
                        parsed.stages.some(stage => stage.state === 'failed'));
                if (parsed.mode === 'shutdown' &&
                    !matchesRequest && !matchesLocalPreflight && !terminalShutdown) {
                    // A backend-only QueryEndSession status must never make a
                    // HUD appear below GNOME's still-open confirmation. Every
                    // non-terminal shutdown status is bound to this
                    // extension's post-confirmation private request. A
                    // terminal failure is safe to keep visible because it can
                    // neither acquire a modal grab nor authorize handoff.
                    this._lastGoodStatus = null;
                    this._syncVisibility();
                    return;
                }
                if ((matchesRequest || matchesLocalPreflight) &&
                    !parsed.shutdownOriginExplicit)
                    parsed.shutdownOrigin = 'preflight';
                if (!parsed.shutdownActionExplicit &&
                    (matchesRequest || matchesLocalPreflight))
                    parsed.shutdownAction = matchesRequest ? request.action : this._preflightAction;
                const previousContext = this._lastGoodStatus?.operationContext;
                if (previousContext && parsed.mode === 'shutdown' &&
                    parsed.operationId === this._lastGoodStatus.operationId &&
                    (!parsed.operationContext || parsed.operationContext.attempt < previousContext.attempt ||
                    (parsed.operationContext.attempt === previousContext.attempt &&
                        !sameOperationContext(parsed.operationContext, previousContext))))
                    return;
                if (parsed.operationId === this._preflightOperationId &&
                    this._preflightWatchdogId) {
                    GLib.Source.remove(this._preflightWatchdogId);
                    this._preflightWatchdogId = 0;
                }
                const isNewSessionOrMode = parsed.sessionId !== this._activeSessionId ||
                    parsed.mode !== this._activeMode ||
                    parsed.operationId !== this._activeOperationId ||
                    parsed.startedAt !== this._activeStartedAt ||
                    Boolean(parsed.operationContext && !sameOperationContext(parsed.operationContext, previousContext));
                if (isNewSessionOrMode) {
                    this._cancelShutdownCountdown();
                    this._dismissed = false;
                    this._activeSessionId = parsed.sessionId;
                    this._activeMode = parsed.mode;
                    this._activeOperationId = parsed.operationId;
                    this._activeStartedAt = parsed.startedAt;
                    this._renderAckScheduledOperationId = null;
                    this._renderAckWrittenOperationId = null;
                    this._commitWrittenOperationId = null;
                    this._nativeHandoffOperationId = null;
                    this._cancelRequestPending = false;
                    this._hud.resetExpansion();
                    this._hud.setCancellationPending(false);
                }
                if (parsed.mode === 'startup') {
                    if (this._startupDismissalMatches(parsed)) {
                        this._dismissed = true;
                    } else if (this._startupPresentationIsStale(parsed)) {
                        this._recordStartupDismissal(parsed, 'stale-completion');
                    }
                }
                if (parsed.cancelled) {
                    this._cancelRequestPending = false;
                }
                if (matchesCurrent && parsed.shutdownOrigin === 'preflight' &&
                    !this._isLocallyCancelled(parsed) &&
                    (!this._preflightOperationId ||
                        this._preflightOperationId === parsed.operationId)) {
                    this._preflightOperationId = parsed.operationId;
                    this._preflightAction = parsed.shutdownAction;
                    this._preflightSignal = parsed.shutdownAction === 'restart'
                        ? 'ConfirmedReboot'
                        : parsed.shutdownAction === 'poweroff' ? 'ConfirmedShutdown' : null;
                }
                const cancellation = parsed.mode === 'shutdown'
                    ? this._readProtocolFileSync(this._cancelFile) : null;
                if (cancellation?.schema_version === 1 && cancellation.operation_id === parsed.operationId &&
                    cancellation?.session_id === parsed.sessionId &&
                    (!parsed.operationContext || sameOperationContext(
                        cancellation.operation_context, parsed.operationContext)))
                    this._withdrawShutdownAuthority(parsed);
                this._lastGoodStatus = parsed;
                if (parsed.mode === 'startup')
                    this._loadAlerts();
                if (parsed.mode === 'startup')
                    this._loadGcProfiles();
                const eligible = parsed.mode === 'shutdown' || parsed.showOnStartup;
                if (eligible) {
                    this._installHudChrome();
                    this._hud.setStatus(parsed);
                    const showShutdownProgress = this._shutdownStatusReady(parsed);
                    if (showShutdownProgress && this._nativeHandoffOperationId === parsed.operationId) {
                        this._hud.setHandoffStarted(parsed.shutdownAction || this._preflightAction);
                    } else if (showShutdownProgress && this._shutdownCountdownOperationId === parsed.operationId &&
                        this._shutdownCountdownSeconds > 0) {
                        this._hud.setShutdownCountdown(
                            parsed.shutdownAction || this._preflightAction,
                            this._shutdownCountdownSeconds
                        );
                    } else if (showShutdownProgress && this._commitWrittenOperationId === parsed.operationId &&
                        parsed.shutdownOrigin === 'preflight') {
                        this._hud.setAwaitingPrepared(
                            parsed.shutdownAction || this._preflightAction
                        );
                    }
                }
                this._syncVisibility();
                if (parsed.mode === 'shutdown' && !parsed.operationContext)
                    this._hud.setTransportNotice('Shutdown is stopped: the coordinator must be upgraded to publish operation context.');
                else if (parsed.mode === 'shutdown' && !this._hasShutdownAuthority(parsed) &&
                    !this._isLocallyCancelled(parsed))
                    this._hud.setTransportNotice('Shutdown is stopped: operation context is expired or belongs to another login.');
                else if (this._isLocallyCancelled(parsed) && !parsed.cancelled)
                    this._hud.setTransportNotice(shutdownRecoveryPending(parsed, true)
                        ? 'Shutdown authorization withdrawn. Backend recovery remains pending; desktop input is released.'
                        : 'Shutdown is stopped; desktop input is released. Review the reported error before retrying.');
                this._handleTerminalShutdownStatus(parsed);
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

    _requestCancel(status) {
        if (
            !this._hud || !this._cancelFile || status.mode !== 'shutdown' ||
            status.cancelled || !status.operationId || this._cancelRequestPending ||
            this._nativeHandoffOperationId === status.operationId
        )
            return false;

        this._withdrawShutdownAuthority(status);
        this._cancelNativeEndSessionOnce(status.operationId);
        try {
            this._writeProtocolFile(this._cancelFile, 'shutdown-cancel', {
                schema_version: 1,
                operation_id: status.operationId,
                session_id: status.sessionId,
                ...(status.operationContext ? {operation_context: status.operationContext} : {}),
                requested_at: new Date().toISOString(),
            });
            this._cancelRequestPending = true;
            this._hud.setCancellationPending(true);
            this._hud.setTransportNotice(
                'Cancellation requested. Prepared jobs are being restored ' +
                'before the shutdown transaction closes.'
            );
            return true;
        } catch (error) {
            this._cancelRequestPending = false;
            this._hud.setCancellationPending(false);
            this._hud.setTransportNotice(
                `Shutdown authorization withdrawn locally; desktop input is released. ` +
                `Backend recovery request could not be delivered: ${error.message}`
            );
            return false;
        }
    }

    _openErrorLog(path) {
        if (!path) {
            this._hud?.reportLogLaunchFailure('no local error_log_path was supplied.');
            return;
        }

        const status = this._lastGoodStatus;
        const hasFailure = status?.overallState === 'failed' ||
            status?.stages.some(stage => stage.state === 'failed');
        const keepVisible = status?.mode === 'shutdown' && hasFailure;
        const epoch = this._enableEpoch;
        const uri = Gio.File.new_for_path(path).get_uri();
        try {
            if (!keepVisible) {
                this._dismissed = true;
                this._syncVisibility();
            }
            Gio.AppInfo.launch_default_for_uri_async(uri, null, this._cancellable, (_source, result) => {
                if (!this._ownsEpoch(epoch))
                    return;
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (error) {
                    if (!keepVisible) {
                        this._dismissed = false;
                        this._syncVisibility();
                    }
                    this._hud?.reportLogLaunchFailure(error.message);
                }
            });
        } catch (error) {
            if (!keepVisible) {
                this._dismissed = false;
                this._syncVisibility();
            }
            this._hud?.reportLogLaunchFailure(error.message);
        }
    }
}
