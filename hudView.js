/* GNOME Shell presentation for the login HUD. */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import {
    TERMINAL_STATES, GC_MAX_PROFILES, shutdownRecoveryPending, gcViewKey, gcProfilePresentation,
    gcEventTime, elapsedSince, stateIcon, displayState, eventTime, overallFraction,
    hudBounds,
} from './reports.js';

export const LoginHud = GObject.registerClass(
class LoginHud extends St.Widget {
    _init() {
        super._init({
            style_class: 'login-hud-overlay',
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        this._status = null;
        this._transportNotice = '';
        this._onCloseRequested = null;
        this._onOpenLogRequested = null;
        this._onCancelRequested = null;
        this._cancelPending = false;
        this._primaryAction = null;
        this._expandedJobs = new Set();
        this._overallProgressFillId = 0;
        this._shutdownCountdown = null;
        this._handoffStarted = false;
        this._selectedTab = 'startup';
        this._alerts = null;
        this._alertError = '';
        this._gcProfiles = null;
        this._gcError = '';
        this._onAlertAckRequested = null;

        this._viewport = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._viewport);
        this._panel = new St.BoxLayout({
            style_class: 'login-hud-panel',
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._viewport.add_child(this._panel);

        this._kicker = new St.Label({
            style_class: 'login-hud-kicker',
            text: 'SESSION / STARTUP TELEMETRY',
        });
        this._title = new St.Label({
            style_class: 'login-hud-title',
            text: 'Restoring workspace',
        });
        this._elapsed = new St.Label({
            style_class: 'login-hud-elapsed',
            text: 'Elapsed —',
        });
        this._overall = new St.Label({
            style_class: 'login-hud-overall',
            text: 'Waiting for session status…',
        });
        this._overallProgressLabel = new St.Label({
            style_class: 'login-hud-overall-progress-label',
            text: 'Overall progress 0%',
        });
        this._overallProgressTrack = new St.Widget({
            style_class: 'login-hud-overall-progress-track',
            x_expand: true,
            height: 7,
            layout_manager: new Clutter.BinLayout(),
        });
        this._overallProgressFill = new St.Widget({
            style_class: 'login-hud-overall-progress-fill',
            x_align: Clutter.ActorAlign.START,
            y_expand: true,
        });
        this._overallProgressTrack.add_child(this._overallProgressFill);
        this._overallProgressTrack.connect('notify::width', () => this._updateOverallProgressFill());
        this._notice = new St.Label({
            style_class: 'login-hud-notice',
            visible: false,
        });
        this._rows = new St.BoxLayout({
            style_class: 'login-hud-rows',
            vertical: true,
        });
        this._tabs = new St.BoxLayout({style_class: 'login-hud-tabs', visible: false});
        this._rowsScroll = new St.ScrollView({
            style_class: 'login-hud-rows-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            enable_mouse_scrolling: true,
            x_expand: true,
        });
        this._rowsScroll.add_child(this._rows);
        this._actions = new St.BoxLayout({
            style_class: 'login-hud-actions',
            x_align: Clutter.ActorAlign.END,
        });

        this._panel.add_child(this._kicker);
        this._panel.add_child(this._title);
        this._panel.add_child(this._elapsed);
        this._panel.add_child(this._overall);
        this._panel.add_child(this._overallProgressLabel);
        this._panel.add_child(this._overallProgressTrack);
        this._panel.add_child(this._notice);
        this._panel.add_child(this._tabs);
        this._panel.add_child(this._rowsScroll);
        this._panel.add_child(this._actions);
    }

    setCallbacks(onCloseRequested, onOpenLogRequested, onCancelRequested, onAlertAckRequested = null) {
        this._onCloseRequested = onCloseRequested;
        this._onOpenLogRequested = onOpenLogRequested;
        this._onCancelRequested = onCancelRequested;
        this._onAlertAckRequested = onAlertAckRequested;
    }

    setStatus(status) {
        this._status = status;
        this._transportNotice = '';
        this._shutdownCountdown = null;
        this._handoffStarted = false;
        if (status.cancelled)
            this._cancelPending = false;
        const isShutdown = status.mode === 'shutdown';
        this._kicker.text = isShutdown
            ? 'SYSTEM / SHUTDOWN TELEMETRY'
            : 'SESSION / STARTUP TELEMETRY';
        this._title.text = isShutdown && status.cancelled
            ? 'System shutdown cancelled'
            : status.overallState === 'failed'
            ? isShutdown ? 'System shutdown needs attention' : 'Session startup needs attention'
            : status.overallState === 'degraded'
                ? isShutdown
                    ? 'System shutdown ready with safe fallbacks'
                    : 'Session systems ready with safe fallbacks'
            : TERMINAL_STATES.has(status.overallState)
                ? isShutdown ? 'System shutdown complete' : 'Session systems ready'
                : isShutdown ? 'Deinitializing system' : 'Restoring workspace';
        this._overall.text = isShutdown
            ? `System shutdown: ${status.overallMessage}`
            : status.overallMessage;
        this._overallProgress = overallFraction(status.stages);
        this._overallProgressLabel.text = `Overall progress ${Math.round(this._overallProgress * 100)}%`;
        this.scheduleProgressFill();
        this._renderTabs();
        this._renderContent();
        this._renderActions(status);
        this._refreshElapsed();
        this._renderNotice();
    }

    setTransportNotice(message) {
        this._transportNotice = message;
        this._renderNotice();
    }

    setCancellationPending(pending) {
        this._cancelPending = pending;
        if (this._status)
            this._renderActions(this._status);
    }

    setShutdownCountdown(action, seconds) {
        this._shutdownCountdown = {action, seconds};
        const verb = action === 'restart'
            ? 'Restarting'
            : action === 'poweroff' ? 'Powering off' : 'Completing shutdown';
        this._title.text = action === 'restart'
            ? 'Ready to restart'
            : action === 'poweroff' ? 'Ready to power off' : 'Ready for shutdown';
        this._overall.text = `${verb} in ${seconds}…`;
        if (this._status)
            this._renderActions(this._status);
    }

    setHandoffStarted(action) {
        this._shutdownCountdown = null;
        this._handoffStarted = true;
        this._overall.text = action === 'restart'
            ? 'Handing control to GNOME for restart…'
            : action === 'poweroff'
                ? 'Handing control to GNOME for power off…'
                : 'Handing control back to GNOME…';
        if (this._status)
            this._renderActions(this._status);
    }

    setAwaitingPrepared(action) {
        this._shutdownCountdown = null;
        this._title.text = action === 'restart' ? 'Ready to restart' : 'Ready to power off';
        this._overall.text = 'Preparation complete · verifying final safety marker…';
        if (this._status)
            this._renderActions(this._status);
    }

    resetExpansion() {
        this._expandedJobs.clear();
        this._selectedTab = 'startup';
    }

    setAlerts(alerts, error = '') {
        this._alerts = alerts;
        this._alertError = error;
        if (this._status?.mode !== 'startup')
            return;
        this._renderTabs();
        if (this._selectedTab === 'important')
            this._renderContent();
    }

    setGcProfiles(profiles, error = '') {
        const changed = gcViewKey(this._gcProfiles, this._gcError) !== gcViewKey(profiles, error);
        this._gcProfiles = profiles;
        this._gcError = error;
        if (changed)
            this.refreshVisibleGc();
    }

    refreshVisibleGc() {
        if (this.visible && this._status?.mode === 'startup' && this._selectedTab === 'gc')
            this._renderContent();
    }

    _renderTabs() {
        this._tabs.destroy_all_children();
        this._tabs.visible = this._status?.mode === 'startup';
        if (!this._tabs.visible) {
            this._selectedTab = 'startup';
            return;
        }
        const count = this._alerts?.unread ?? 0;
        for (const [tab, label] of [['startup', 'Відновлення'], ['important', `Важливе${count ? ` · ${count}` : ''}`], ['gc', 'GC-профілі']]) {
            const button = new St.Button({
                style_class: `login-hud-tab${this._selectedTab === tab ? ' login-hud-tab-selected' : ''}`,
                label, reactive: true, can_focus: true, x_expand: true,
            });
            button.connect('clicked', () => {
                this._selectedTab = tab;
                this._renderTabs();
                this._renderContent();
            });
            this._tabs.add_child(button);
        }
        this.scheduleProgressFill();
    }

    _renderContent() {
        if (this._status?.mode === 'startup' && this._selectedTab === 'important')
            this._renderAlerts();
        else if (this._status?.mode === 'startup' && this._selectedTab === 'gc')
            this._renderGcProfiles();
        else if (this._status)
            this._renderRows(this._status.stages);
    }

    _renderGcProfiles() {
        this._rows.destroy_all_children();
        this.scheduleProgressFill();
        const addLabel = (parent, message, style = 'login-hud-row-message') => {
            const label = new St.Label({style_class: style, text: message});
            label.clutter_text.line_wrap = true;
            label.clutter_text.ellipsize = 0;
            parent.add_child(label);
        };
        if (!this._gcProfiles || this._gcError) {
            addLabel(this._rows, this._gcError || 'Очікую звіт GC-профілів…', 'login-hud-alert-summary');
            if (!this._gcProfiles)
                return;
        }
        if (!this._gcProfiles.daemonAvailable)
            addLabel(this._rows, this._gcProfiles.stale
                ? 'Демон GC-профілів недоступний: звіт застарів.'
                : 'Демон GC-профілів недоступний.', 'login-hud-alert-summary');
        if (this._gcProfiles.truncated)
            addLabel(this._rows, `Показано перші ${GC_MAX_PROFILES} профілів; решту приховано.`,
                'login-hud-alert-summary');
        if (!this._gcProfiles.profiles.length) {
            addLabel(this._rows, 'Профілі GC не зареєстровані.', 'login-hud-alert-summary');
            return;
        }
        for (const profile of this._gcProfiles.profiles) {
            const presentation = gcProfilePresentation(profile, this._gcProfiles.daemonAvailable);
            const row = new St.BoxLayout({vertical: true,
                style_class: `login-hud-row login-hud-row-${presentation.style}`});
            const heading = new St.BoxLayout({style_class: 'login-hud-row-heading'});
            heading.add_child(new St.Icon({style_class: 'login-hud-row-icon',
                icon_name: presentation.icon, icon_size: 16}));
            heading.add_child(new St.Label({style_class: 'login-hud-row-name',
                text: profile.name, x_expand: true}));
            heading.add_child(new St.Label({style_class: 'login-hud-row-state',
                text: presentation.label}));
            row.add_child(heading);
            if (presentation.timeLabel && presentation.time)
                addLabel(row, `${presentation.timeLabel}: ${gcEventTime(presentation.time)}`);
            if (profile.message)
                addLabel(row, profile.message);
            this._rows.add_child(row);
        }
    }

    _renderAlerts() {
        this._rows.destroy_all_children();
        this.scheduleProgressFill();
        const addLabel = (parent, message, style = 'login-hud-row-message') => {
            const label = new St.Label({style_class: style, text: message});
            label.clutter_text.line_wrap = true;
            label.clutter_text.ellipsize = 0;
            parent.add_child(label);
        };
        if (!this._alerts || this._alertError) {
            addLabel(this._rows, this._alertError || 'Очікую перевірку власних систем…', 'login-hud-alert-summary');
            if (!this._alerts)
                return;
        }
        const alerts = this._alerts;
        if (alerts.scanning || alerts.stale || alerts.scanError || alerts.incomplete)
            addLabel(this._rows, 'Перевірка власних систем неповна; показано лише підтверджені важливі проблеми.', 'login-hud-alert-summary');
        if (!alerts.incidents.length)
            addLabel(this._rows, 'Підтверджених важливих проблем немає.', 'login-hud-alert-summary');
        for (const incident of alerts.incidents) {
            const source = alerts.sources.find(item => item.id === incident.source);
            const row = new St.BoxLayout({vertical: true,
                style_class: 'login-hud-row login-hud-row-failed'});
            const key = `alert:${incident.source}:${incident.code}`;
            const expanded = this._expandedJobs.has(key);
            const button = new St.Button({
                style_class: 'login-hud-row-heading-button', reactive: true, can_focus: true,
                label: `${expanded ? '▾' : '▸'} ${source.label} · ${source.host} · ${incident.severity}`,
            });
            button.connect('clicked', () => {
                if (expanded)
                    this._expandedJobs.delete(key);
                else
                    this._expandedJobs.add(key);
                this._renderContent();
            });
            row.add_child(button);
            addLabel(row, incident.message);
            if (expanded) {
                addLabel(row, `Код: ${incident.code}\nВперше: ${incident.first_seen}\n` +
                    `Востаннє: ${incident.last_seen}\nПовторень: ${incident.occurrences}\n` +
                    `Стан: активна; рівень: ${incident.severity}\n` +
                    `Власний код: ${source.source_ref}\n${incident.detail}`, 'login-hud-alert-details');
            }
            if (!incident.acknowledged) {
                const ack = new St.Button({style_class: 'login-hud-tab', label: 'Переглянуто',
                    reactive: true, can_focus: true, x_align: Clutter.ActorAlign.END});
                ack.connect('clicked', () => this._onAlertAckRequested?.(incident.source, incident.code));
                row.add_child(ack);
            }
            this._rows.add_child(row);
        }
    }

    getInteractiveActor() {
        return this._panel;
    }

    setWorkArea(workArea, scaleFactor) {
        this._workArea = workArea;
        this._scaleFactor = scaleFactor;
        this._viewport.set_position(workArea.x, workArea.y);
        this._viewport.set_size(workArea.width, workArea.height);
        this.scheduleProgressFill();
    }

    _updatePanelLayout() {
        if (!this._workArea || !this._panel.get_stage())
            return;
        const bounds = hudBounds(this._workArea, this._scaleFactor);
        const panelStyle = `width: ${bounds.width}px; max-width: ${bounds.width}px; ` +
            `max-height: ${bounds.height}px;`;
        if (this._panel.get_style() !== panelStyle)
            this._panel.set_style(panelStyle);

        // Reserve the real header, notice and action heights, not a fixed row
        // cap. Expanded logs may scroll; the Close/Cancel controls stay outside.
        const theme = this._panel.get_theme_node();
        const innerWidth = theme.adjust_for_width(bounds.width * this._scaleFactor);
        const children = this._panel.get_children().filter(child => child.visible);
        let chromeHeight = theme.adjust_preferred_height(0, 0)[1] +
            theme.get_length('spacing') * Math.max(0, children.length - 1);
        for (const child of children) {
            if (child !== this._rowsScroll)
                chromeHeight += child.get_preferred_height(innerWidth)[1];
        }
        // Include the list's top margin in the available-height calculation.
        const rowsHeight = Math.max(1, Math.floor(bounds.height -
            chromeHeight / this._scaleFactor - 8));
        const rowsStyle = `max-height: ${rowsHeight}px;`;
        if (this._rowsScroll.get_style() !== rowsStyle)
            this._rowsScroll.set_style(rowsStyle);
    }

    focusPrimaryAction() {
        this._primaryAction?.grab_key_focus();
    }

    reportLogLaunchFailure(message) {
        this._transportNotice = `Could not open error log: ${message}`;
        this._renderNotice();
    }

    refreshClock() {
        this._refreshElapsed();
        // A stopped collector emits no new file events. Age the displayed
        // report anyway instead of leaving an old green result fresh forever.
        if (this._alerts && !this._alerts.stale &&
            Date.now() - Date.parse(this._alerts.updatedAt) > 15 * 60 * 1000) {
            this._alerts.stale = true;
            if (this._status?.mode === 'startup' && this._selectedTab === 'important')
                this._renderContent();
        }
    }

    scheduleProgressFill() {
        if (this._overallProgressFillId)
            return;
        this._overallProgressFillId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._overallProgressFillId = 0;
            this._updatePanelLayout();
            this._updateOverallProgressFill();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelDeferredUpdates() {
        if (this._overallProgressFillId)
            GLib.Source.remove(this._overallProgressFillId);
        this._overallProgressFillId = 0;
    }

    _refreshElapsed() {
        this._elapsed.text = this._status ? elapsedSince(this._status.startedAt) : 'Elapsed —';
    }

    _updateOverallProgressFill() {
        if (!this._overallProgressTrack.get_stage() || !this._overallProgressTrack.mapped)
            return;
        const width = this._overallProgressTrack.width;
        this._overallProgressFill.set_width(Math.round(width * (this._overallProgress ?? 0)));
    }

    _renderNotice() {
        this._notice.text = this._transportNotice;
        this._notice.visible = Boolean(this._transportNotice);
        this.scheduleProgressFill();
    }

    _renderRows(stages) {
        this.scheduleProgressFill();
        this._rows.destroy_all_children();
        if (stages.length === 0) {
            this._rows.add_child(new St.Label({
                style_class: 'login-hud-empty',
                text: this._status?.mode === 'shutdown'
                    ? 'No shutdown stages have been published yet.'
                    : 'No startup stages have been published yet.',
            }));
            return;
        }

        for (const stage of stages)
            this._rows.add_child(this._makeStageRow(stage));
    }

    _makeStageRow(stage) {
        const row = new St.BoxLayout({
            style_class: `login-hud-row login-hud-row-${stage.state}`,
            vertical: true,
        });
        const expanded = this._expandedJobs.has(stage.id);
        const headingContent = new St.BoxLayout({style_class: 'login-hud-row-heading'});
        const expander = new St.Icon({
            style_class: 'login-hud-row-expander',
            icon_name: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
            icon_size: 12,
        });
        const icon = new St.Icon({
            style_class: 'login-hud-row-icon',
            icon_name: stateIcon(stage.state),
            icon_size: 16,
        });
        const name = new St.Label({
            style_class: 'login-hud-row-name',
            text: stage.name,
            x_expand: true,
        });
        const status = new St.Label({
            style_class: 'login-hud-row-state',
            text: displayState(stage.state),
        });
        headingContent.add_child(expander);
        headingContent.add_child(icon);
        headingContent.add_child(name);
        headingContent.add_child(status);
        const heading = new St.Button({
            style_class: 'login-hud-row-heading-button',
            child: headingContent,
            reactive: true,
            can_focus: true,
            x_expand: true,
            accessible_name: `${expanded ? 'Collapse' : 'Expand'} ${stage.name}`,
        });
        heading.connect('clicked', () => {
            if (this._expandedJobs.has(stage.id))
                this._expandedJobs.delete(stage.id);
            else
                this._expandedJobs.add(stage.id);
            if (this._status)
                this._renderContent();
        });
        row.add_child(heading);

        if (stage.message) {
            row.add_child(new St.Label({
                style_class: 'login-hud-row-message',
                text: stage.message,
            }));
        }

        if (stage.fraction !== null) {
            const track = new St.Widget({
                style_class: 'login-hud-progress-track',
                x_expand: true,
                height: 5,
                layout_manager: new Clutter.BinLayout(),
            });
            const fill = new St.Widget({
                style_class: 'login-hud-progress-fill',
                x_align: Clutter.ActorAlign.START,
                y_expand: true,
            });
            const updateFill = () => {
                if (!track.get_stage() || !track.mapped)
                    return;
                fill.set_width(Math.round(track.width * stage.fraction));
            };
            track.add_child(fill);
            track.connect('notify::width', updateFill);
            track.connect('notify::mapped', updateFill);
            row.add_child(track);
        } else if (!TERMINAL_STATES.has(stage.state)) {
            const indeterminate = new St.BoxLayout({style_class: 'login-hud-indeterminate'});
            const spinner = new Spinner(14, {animate: true});
            spinner.add_style_class_name('login-hud-spinner');
            spinner.play();
            indeterminate.add_child(spinner);
            indeterminate.add_child(new St.Label({
                style_class: 'login-hud-indeterminate-label',
                text: 'In progress',
            }));
            row.add_child(indeterminate);
        }

        if (expanded)
            row.add_child(this._makeJobDetails(stage));

        return row;
    }

    _makeJobDetails(stage) {
        const details = new St.BoxLayout({
            style_class: 'login-hud-job-details',
            vertical: true,
        });
        if (stage.children.length > 0) {
            details.add_child(new St.Label({
                style_class: 'login-hud-detail-heading',
                text: 'INTERNAL STEPS',
            }));
            for (const child of stage.children) {
                const substep = new St.BoxLayout({style_class: 'login-hud-substep'});
                substep.add_child(new St.Icon({
                    style_class: 'login-hud-substep-icon',
                    icon_name: stateIcon(child.state),
                    icon_size: 13,
                }));
                substep.add_child(new St.Label({
                    style_class: 'login-hud-substep-name',
                    text: child.name,
                    x_expand: true,
                }));
                substep.add_child(new St.Label({
                    style_class: 'login-hud-substep-state',
                    text: displayState(child.state),
                }));
                details.add_child(substep);
                details.add_child(new St.Label({
                    style_class: 'login-hud-substep-message',
                    text: child.message,
                }));
            }
        }

        details.add_child(new St.Label({
            style_class: 'login-hud-detail-heading',
            text: 'ACTIVITY LOG',
        }));
        if (stage.events.length === 0) {
            details.add_child(new St.Label({
                style_class: 'login-hud-log-empty',
                text: 'No activity has been reported yet.',
            }));
            return details;
        }
        for (const event of stage.events) {
            const source = event.source ? `${event.source} · ` : '';
            details.add_child(new St.Label({
                style_class: `login-hud-log-line login-hud-log-${event.state}`,
                text: `${eventTime(event.at)}  ${source}${displayState(event.state)} — ${event.message}`,
            }));
        }
        return details;
    }

    _renderActions(status) {
        this.scheduleProgressFill();
        this._actions.destroy_all_children();
        this._primaryAction = null;
        const hasFailure = status.overallState === 'failed' || status.stages.some(stage => stage.state === 'failed');
        const allTerminal = status.stages.length > 0 && status.stages.every(stage => TERMINAL_STATES.has(stage.state));

        if (hasFailure) {
            const button = new St.Button({
                style_class: 'login-hud-button',
                label: 'Show full error log',
                can_focus: true,
                reactive: true,
            });
            button.connect('clicked', () => this._onOpenLogRequested?.(status.errorLogPath));
            this._actions.add_child(button);
            this._primaryAction = button;
            if (status.mode === 'shutdown') {
                this._actions.add_child(new St.Label({
                    style_class: 'login-hud-action-status',
                    text: 'Shutdown stopped · review the error and retry power off',
                }));
            }
            this._addCloseButton(status.mode === 'shutdown' && shutdownRecoveryPending(status)
                ? 'Hide (recovery continues)' : 'Close');
        } else if (status.mode === 'shutdown' && this._handoffStarted) {
            this._actions.add_child(new St.Label({
                style_class: 'login-hud-action-status',
                text: 'Shutdown handoff in progress',
            }));
        } else if (status.mode === 'shutdown' && !status.cancelled) {
            const button = new St.Button({
                style_class: 'login-hud-button login-hud-button-cancel',
                label: this._cancelPending
                    ? 'Cancelling safely…'
                    : this._shutdownCountdown
                        ? `Cancel (${this._shutdownCountdown.seconds}s)`
                        : 'Cancel shutdown',
                can_focus: true,
                reactive: !this._cancelPending,
            });
            button.connect('clicked', () => this._onCancelRequested?.(status));
            this._actions.add_child(button);
            this._primaryAction = button;
        } else if (status.mode === 'shutdown' && status.cancelled) {
            this._addCloseButton(shutdownRecoveryPending(status) ? 'Hide (recovery continues)' : 'Close');
        } else if (allTerminal && status.mode !== 'shutdown') {
            this._addCloseButton('OK', true);
        }
    }

    _addCloseButton(label, primary = false) {
        const button = new St.Button({
            style_class: `login-hud-button${primary ? ' login-hud-button-primary' : ''}`,
            label,
            can_focus: true,
            reactive: true,
        });
        button.connect('clicked', () => this._onCloseRequested?.());
        this._actions.add_child(button);
        if (!this._primaryAction)
            this._primaryAction = button;
    }
});
