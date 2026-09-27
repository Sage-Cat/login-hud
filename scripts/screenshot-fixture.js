// Documentation-only controller, loaded exclusively in a disposable Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HUD = 'login-hud-docs@example.invalid';
const SESSION = 'documentation-session';

export default class DocumentationFixture extends Extension {
    enable() {
        if (!GLib.get_user_runtime_dir().startsWith('/tmp/login-hud-docs-'))
            throw new Error('Documentation controller requires its disposable runtime');
        this._diagnostics = Gio.DBusExportedObject.wrapJSObject(
            '<node><interface name="org.example.HudDocumentation"><method name="Control"><arg type="s" direction="in"/><arg type="s" direction="out"/></method></interface></node>',
            {Control: value => JSON.stringify(this.control(JSON.parse(value)))});
        this._diagnostics.export(Gio.DBus.session, '/org/example/HudDocumentation');
    }

    disable() {
        this._diagnostics?.unexport();
        this._diagnostics = null;
    }

    control(request) {
        const extension = Main.extensionManager.lookup(HUD)?.stateObj;
        if (!extension)
            return {ready: false};
        const panel = extension._hud;
        if (request.action === 'setup') {
            Main.overview.hide();
            extension._currentSessionId = SESSION;
            extension._originalEndSessionConfirm = () => {
                throw new Error('Native shutdown is forbidden in documentation capture');
            };
            // Controls are never clicked; also remove all external launch callbacks.
            extension._openErrorLog = () => {};
            extension._ackAlert = () => {};
        } else if (request.action === 'scene') {
            const now = new Date().toISOString();
            const earlier = new Date(Date.now() - 120000).toISOString();
            const directory = extension._statusDirectory.get_path();
            const shutdown = request.scene === 'shutdown' || request.scene === 'attention';
            const failed = request.scene === 'attention';
            const operation = failed ? 'd0c00000000000000000000000000002' : 'd0c00000000000000000000000000001';
            const stages = shutdown ? [
                ['terminals', 'Terminal checkpoint', 'ready', 'Window and pane layout saved', 1],
                ['workspace-save', 'Desktop and browser checkpoint', failed ? 'failed' : 'running',
                    failed ? 'Browser verification needs attention; the previous checkpoint is preserved' : 'Verifying browser tabs and window placement', .65],
                ['profiles', 'Pre-shutdown profiles', 'waiting', 'Waiting for the checkpoint', 0],
                ['integrity', 'Checkpoint integrity', 'pending', 'Compare saved identities before final handoff', 0],
            ] : [
                ['shell', 'GNOME and displays', 'ready', 'Display layout and workspaces are ready', 1],
                ['terminals', 'Terminals and pane layout', 'ready', '3 terminal windows restored', 1],
                ['browsers', 'Browser windows', 'running', 'Verified 2 of 3 browser windows', 2 / 3],
                ['editors', 'Editor projects', 'running', 'Reopening the documentation project', .5],
                ['files', 'File manager', 'waiting', 'Waiting for a shared folder', null],
                ['drives', 'Cloud drives', 'pending', 'Starts after workspace restoration', null],
            ];
            const status = {
                schema_version: 1, mode: shutdown ? 'shutdown' : 'startup',
                session_id: SESSION, show_startup_hud: true,
                started_at: new Date(Date.now() - 24000).toISOString(), updated_at: now,
                overall_state: failed ? 'failed' : 'running',
                overall_message: failed ? 'Preparation stopped safely; review the failed step'
                    : shutdown ? 'Saving a verified workspace before power off' : 'Your workspace is being restored',
                error_log_path: GLib.build_filenamev([directory, 'synthetic-example.txt']),
                stages: stages.map(([id, label, state, message, fraction]) => ({id, label, state, message, fraction,
                    events: [{at: earlier, state: 'running', message: 'Read the saved window recipe'},
                        {at: now, state, message}]})),
            };
            if (shutdown) {
                extension._preflightOperationId = operation;
                extension._preflightAction = 'poweroff';
                extension._preflightSignal = 'ConfirmedShutdown';
                Object.assign(status, {operation_id: operation, cancelled: false,
                    shutdown_action: 'poweroff', shutdown_origin: 'preflight',
                    operation_state: failed ? 'failed' : 'preparing',
                    operation_context: {boot_id: extension._bootId, login_generation: SESSION,
                        operation_id: operation, mode: 'shutdown', attempt: 1,
                        deadline: GLib.get_monotonic_time() / 1000000 + 120}});
                extension._writeProtocolFile(extension._requestFile, 'docs-request', {
                    schema_version: 1, operation_id: operation, session_id: SESSION,
                    action: 'poweroff', requested_at: now});
            }
            const alerts = {schema_version: 1, boot_id: 'synthetic-boot', last_scan_boot_id: 'synthetic-boot',
                last_scan_at: now, scanning: false, sources: [
                    {id: 'drive-sync', label: 'Shared folder sync', host: 'local', ownership: 'first-party', source_ref: 'example sync service'},
                    {id: 'editor-bridge', label: 'Editor companion', host: 'local', ownership: 'first-party', source_ref: 'example editor bridge'},
                ], incidents: [
                    {source: 'drive-sync', code: 'auth-required', severity: 'blocker', active: true,
                        acknowledged: false, message: 'Sign in again to reconnect the shared folder',
                        detail: 'Synthetic example: the collector cannot verify this connection.',
                        first_seen: 'Example scan', last_seen: 'Current scan', occurrences: 2},
                    {source: 'editor-bridge', code: 'service-unavailable', severity: 'critical', active: true,
                        acknowledged: true, message: 'One editor window has not connected yet',
                        detail: 'Synthetic example: reopening the window loads its companion.',
                        first_seen: 'Example scan', last_seen: 'Current scan', occurrences: 1},
                ]};
            extension._writeProtocolFile(extension._alertsFile, 'docs-alerts', alerts);
            GLib.mkdir_with_parents(extension._gcStatusDirectory.get_path(), 0o700);
            const profiles = [['Temporary build files', 'ok', true, 'Last run completed'],
                ['Thumbnail cache', 'running', true, 'Scheduled cleanup is running'],
                ['Archived downloads', 'failed', true, 'Synthetic example: target unavailable'],
                ['Optional cache', 'disabled', false, 'Not enabled']];
            extension._writeProtocolFile(extension._gcStatusFile, 'docs-gc', {
                schema_version: 1, updated_at: now, daemon: {state: 'running', pid: 100},
                profiles: profiles.map(([name, state, enabled, message]) => ({name, state, enabled, message,
                    last_started_at: earlier, last_finished_at: state === 'ok' ? earlier : null,
                    last_success_at: state === 'ok' ? earlier : null,
                    last_failure_at: state === 'failed' ? earlier : null, next_run_at: null}))});
            extension._writeProtocolFile(extension._statusFile, 'docs-status', status);
            extension._loadStatus();
            this._scene = request.scene;
        } else if (request.action === 'tab') {
            panel._selectedTab = request.tab;
            if (request.expand)
                panel._expandedJobs.add(request.expand);
            panel._renderTabs();
            panel._renderContent();
        } else if (request.action === 'screenshot') {
            if (!request.path.startsWith(GLib.get_user_runtime_dir() + '/'))
                throw new Error('Screenshot output must be in the disposable runtime');
            const [x, y] = panel._panel.get_transformed_position();
            const [width, height] = panel._panel.get_transformed_size();
            this._capture = {done: false};
            const screenshot = new Shell.Screenshot();
            // screenshot_area() crashes Shell 46 if painting fails: its PNG worker
            // dereferences the absent image. Stage-to-content reports that failure.
            screenshot.screenshot_stage_to_content((object, result) => {
                try {
                    const [content, scale] = object.screenshot_stage_to_content_finish(result);
                    const texture = content.get_texture();
                    const left = Math.max(0, Math.floor((x - 16) * scale));
                    const top = Math.max(0, Math.floor((y - 16) * scale));
                    const right = Math.min(texture.get_width(), Math.ceil((x + width + 16) * scale));
                    const bottom = Math.min(texture.get_height(), Math.ceil((y + height + 16) * scale));
                    if (right <= left || bottom <= top)
                        throw new Error('HUD capture is outside the virtual monitor');
                    const stream = Gio.File.new_for_path(request.path).replace(
                        null, false, Gio.FileCreateFlags.PRIVATE, null);
                    Shell.Screenshot.composite_to_stream(texture, left, top, right - left, bottom - top,
                        scale, null, 0, 0, 1, stream, (_source, writeResult) => {
                            try {
                                Shell.Screenshot.composite_to_stream_finish(writeResult);
                                stream.close(null);
                                this._capture = {done: true};
                            } catch (error) {
                                try {
                                    stream.close(null);
                                } catch (_) {
                                    // Keep the original capture error for the caller.
                                }
                                this._capture = {done: true, error: error.message};
                            }
                        });
                } catch (error) {
                    this._capture = {done: true, error: error.message};
                }
            });
        }
        return {ready: !Main.layoutManager._startingUp, overview: Main.overview.visible,
            visible: Boolean(panel?.visible), mapped: Boolean(panel?.mapped),
            modal: Boolean(extension._modalGrab), scene: this._scene, capture: this._capture};
    }
}
