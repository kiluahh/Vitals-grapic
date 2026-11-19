import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St'

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import * as Sensors from './sensors.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Values from './values.js';
import * as MenuItem from './menuItem.js';
import * as SensorCatalog from './helpers/catalog.js';

let vitalsMenu;

// Mini panel charts next to pinned sensors.
const CHART_POINTS = 32;   // samples kept per sensor
const CHART_WIDTH = 34;    // logical px, line + horizontal battery
const CHART_VERTICAL_WIDTH = 10;
const CHART_HEIGHT = 14;   // logical px
const CHART_LINE = 1;
const CHART_HBATTERY = 2;
const CHART_VBATTERY = 3;
const CHART_RGBA = [0.208, 0.518, 0.894, 0.9]; // #3584e4 fallback

var VitalsMenuButton = GObject.registerClass({
    GTypeName: 'VitalsMenuButton',
}, class VitalsMenuButton extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(Clutter.ActorAlign.FILL);

        this._extensionObject = extensionObject;
        this._settings = extensionObject.getSettings();

        this._sensorIcons = SensorCatalog.sensorCatalog;

        // list with the prefixes for the according themes, the index of each
        // item must match the index on the combo box
        this._sensorsIconPathPrefix = ['/icons/original/', '/icons/gnome/'];

        this._sensorMenuItems = {};
        this._hotLabels = {};
        this._hotItems = {};
        this._hotCharts = {};
        this._chartHistory = {};
        this._chartNetPrev = {};
        this._groups = {};
        this._widths = {};
        this._numGpus = 1;
        this._newGpuDetected = false;
        this._newGpuDetectedCount = 0;
        this._last_query = new Date().getTime();

        this._sensors = new Sensors.Sensors(this._settings, this._sensorIcons, _);
        this._values = new Values.Values(this._settings, this._sensorIcons);
        this._menuLayout = new St.BoxLayout({
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            x_expand: true,
            style_class: 'vitals-panel-menu'
        });

        this._drawMenu();
        this.add_child(this._menuLayout);
        this._refreshTimeoutId = null;

        this._connectSettingsSignals();

        this._initializeMenu();

        // start off with fresh sensors
        this._querySensors();

        // start monitoring sensors
        this._initializeTimer();
    }

    _connectSettingsSignals() {
        this._settings.connectObject(
            'changed::update-time', this._initializeTimer.bind(this),
            'changed::position-in-panel', this._positionInPanelChanged.bind(this),
            'changed::menu-centered', this._positionInPanelChanged.bind(this),
            'changed::panel-chart-mode', this._redrawHotSensors.bind(this),
            'changed::panel-chart-show-value', this._redrawHotSensors.bind(this),
            'changed::panel-chart-color', this._repaintCharts.bind(this),
            'changed::panel-font-size', this._redrawHotSensors.bind(this),
            'changed::panel-sensor-config', this._redrawHotSensors.bind(this),
            'changed::hot-sensors', this._redrawHotSensors.bind(this),
            this);

        let settings = [ 'use-higher-precision', 'alphabetize', 'hide-zeros',
                         'fixed-widths', 'hide-icons', 'unit', 'icon-style',
                         'memory-measurement', 'include-public-ip', 'network-public-ip-interval',
                         'network-public-ip-show-flag', 'network-public-ip-provider', 'network-speed-format', 'network-speed-unit', 'storage-measurement',
                         'include-static-info', 'include-processor-cores', 'include-static-gpu-info' ];

        for (let setting of settings)
            this._settings.connectObject('changed::' + setting, this._redrawMenu.bind(this), this);

        for (let setting of SensorCatalog.colorSettingsKeys())
            this._settings.connectObject('changed::' + setting, this._thresholdColorsChanged.bind(this), this);

        for (let sensor in this._sensorIcons)
            this._settings.connectObject('changed::show-' + sensor, this._showHideSensorsChanged.bind(this), this);
    }

    _thresholdColorsChanged() {
        this._values.resetHistory(this._numGpus);
        this._querySensors();
    }

    _initializeMenu() {
        // display sensor categories
        for (let sensor in this._sensorIcons) {
            // groups associated sensors under accordion menu
            if (sensor in this._groups) continue;

            //handle gpus separately.
            if (sensor === 'gpu') continue;

            this._initializeMenuGroup(sensor, sensor);
        }

        for (let i = 1; i <= this._numGpus; i++)
            this._initializeMenuGroup('gpu#' + i, 'gpu', (this._numGpus > 1 ? ' ' + i : ''));

        // add separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'vitals-menu-button-container'
        });

        let customButtonBox = new St.BoxLayout({
            style_class: 'vitals-button-box',
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            x_expand: true
        });

        // custom round refresh button
        let refreshButton = this._createRoundButton('view-refresh-symbolic', _('Refresh'));
        refreshButton.connect('clicked', (self) => {
            // soft reset: clear history without rediscovering hardware (rediscover races
            // _queryGpu when DRM indices are briefly empty and disables the group header)
            this._sensors.resetHistory(false);
            this._values.resetHistory(this._numGpus);

            // make sure timer fires at next full interval
            this._initializeTimer();

            // refresh sensors now
            this._querySensors();
        });
        customButtonBox.add_child(refreshButton);

        // custom round monitor button
        let monitorButton = this._createRoundButton('org.gnome.SystemMonitor-symbolic', _('System Monitor'));
        monitorButton.connect('clicked', (self) => {
            this.menu._getTopMenu().close();
            Util.spawn(this._settings.get_string('monitor-cmd').split(" "));
        });
        customButtonBox.add_child(monitorButton);

        // custom round preferences button
        let prefsButton = this._createRoundButton('preferences-system-symbolic', _('Preferences'));
        prefsButton.connect('clicked', (self) => {
            this.menu._getTopMenu().close();
            this._extensionObject.openPreferences();
        });
        customButtonBox.add_child(prefsButton);

        // now add the buttons to the top bar
        item.actor.add_child(customButtonBox);

        // add buttons
        this.menu.addMenuItem(item);

        // query sensors on menu open
        this.menu.connectObject('open-state-changed', (menu, isMenuOpen) => {
            if (isMenuOpen) {
                // make sure timer fires at next full interval
                this._initializeTimer();

                // refresh sensors now
                this._querySensors();
            }
        }, this);
    }

    _initializeMenuGroup(groupName, optionName, menuSuffix = '', position = -1) {
        this._groups[groupName] = new PopupMenu.PopupSubMenuMenuItem(_(this._ucFirst(groupName) + menuSuffix), true);
        this._groups[groupName].icon.gicon = Gio.icon_new_for_string(this._sensorIconPath(groupName));

        // hide menu items that user has requested to not include
        if (!this._settings.get_boolean('show-' + optionName))
            this._groups[groupName].actor.hide();

        if (!this._groups[groupName]._statusLabel) {
            this._groups[groupName]._statusLabel = this._defaultLabel();
            this._groups[groupName].actor.insert_child_at_index(this._groups[groupName]._statusLabel, 4);
            this._groups[groupName]._statusLabel.text = _('No Data');
        }

        if(position == -1) this.menu.addMenuItem(this._groups[groupName]);
        else this.menu.addMenuItem(this._groups[groupName], position);
    }

    _createRoundButton(iconName) {
        let button = new St.Button({
            style_class: 'button vitals-button-action'
        });

        button.child = new St.Icon({
            icon_name: iconName
        });

        return button;
    }

    _removeMissingHotSensors(hotSensors) {
        for (let i = hotSensors.length - 1; i >= 0; i--) {
            let sensor = hotSensors[i];

            // make sure default icon (if any) stays visible
            if (sensor == '_default_icon_') continue;

            // removes sensors that are no longer available
            if (!this._sensorMenuItems[sensor]) {
                hotSensors.splice(i, 1);
                this._removeHotItem(sensor);
            }
        }

        return hotSensors;
    }

    _saveHotSensors(hotSensors) {
        // removes any sensors that may not currently be available
        hotSensors = this._removeMissingHotSensors(hotSensors);

        this._settings.set_strv('hot-sensors', hotSensors.filter(
            function(item, pos) {
                return hotSensors.indexOf(item) == pos;
            }
        ));
    }

    _initializeTimer() {
        this._destroyTimer();

        // used to query sensors and update display
        let update_time = this._settings.get_int('update-time');
        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            update_time,
            (self) => {
                // always query sensors (for panel display when hot)
                this._querySensors();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _createHotItem(key, value, gicon, style) {
        let item = new St.BoxLayout({
            style_class: 'vitals-panel-item',
        });
        this._hotItems[key] = item;
        this._menuLayout.add_child(item);

        let displayOptions = this._sensorDisplay(key);

        if (displayOptions.display != 'name' &&
            (!this._settings.get_boolean('hide-icons') || key == '_default_icon_')) {
            let icon = this._defaultIcon(key);
            if (gicon) icon.gicon = gicon;
            item.add_child(icon);
        }

        // don't add a label when no sensors are in the panel
        if (key == '_default_icon_') return;

        // optional short name instead of (or next to) the icon
        if (displayOptions.display != 'icon') {
            let nameLabel = new St.Label({
                style_class: 'vitals-panel-name',
                text: displayOptions.name,
                style: this._fontStyle(null),
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            item.add_child(nameLabel);
        }

        // optional mini chart, drawn from the samples recorded below
        let chartOptions = this._chartSettings(key);
        let chartMode = chartOptions.mode;
        if (chartMode != 0) {
            let chart = new St.DrawingArea({
                style_class: 'vitals-panel-chart',
                width: chartMode == CHART_VBATTERY ? CHART_VERTICAL_WIDTH : CHART_WIDTH,
                height: CHART_HEIGHT,
                y_align: Clutter.ActorAlign.CENTER
            });
            chart.connect('repaint', () => this._drawChart(chart, key));
            this._hotCharts[key] = chart;
            item.add_child(chart);
        }

        let label = new St.Label({
            style_class: 'vitals-panel-label',
            text: (value)?value:'\u2026', // ...
            style: this._fontStyle(style),
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        // attempt to prevent ellipsizes
        label.get_clutter_text().ellipsize = 0;
        // keep track of label for removal later
        this._hotLabels[key] = label;
        // prevent "called on the widget"  "which is not in the stage" errors by adding before width below
        item.add_child(label);

        // support for fixed widths #55, save label (text) width
        this._widths[key] = label.get_clutter_text().width;

        // chart-only mode: keep the label alive for value updates but hide it
        if (chartMode != 0 && !chartOptions.showValue)
            label.hide();
    }

    _showHideSensorsChanged(self, sensor) {
        const sensorName = sensor.substr(5);
        if(sensorName === 'gpu') {
            for(let i = 1; i <= this._numGpus; i++)
                this._groups[sensorName + '#' + i].visible = this._settings.get_boolean(sensor);
        } else
            this._groups[sensorName].visible = this._settings.get_boolean(sensor);

        // prefs may have removed this group's sensors from hot-sensors; rebuild panel/menu
        this._redrawMenu();
    }

    _positionInPanelChanged() {
        this.container.get_parent().remove_child(this.container);
        let position = this._positionInPanel();

        // allows easily addressable boxes
        let boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox
        };

        // update position when changed from preferences
        boxes[position[0]].insert_child_at_index(this.container, position[1]);
    }

    _removeHotItems(){
        for (let key in this._hotItems) {
            this._removeHotItem(key);
        }
    }

    _removeHotItem(key) {
        if (key in this._hotItems) {
            delete this._hotLabels[key];
            delete this._widths[key];
            delete this._hotCharts[key];
            this._hotItems[key].destroy();
            delete this._hotItems[key];
        }
    }

    // Record one sample per poll for pinned sensors, normalized to 0..1 for
    // drawing. Percent values get a fixed 0–100% scale, temperatures 0–100 °C,
    // everything else (network rates, byte counters, …) scales to the window max.
    _recordChartSample(key, value, type, format, dwell) {
        if (this._chartSettings(key).mode == 0 ||
            !(key in this._hotCharts))
            return;

        let numeric = (typeof value === 'number') ? value : Number(value);
        if (!Number.isFinite(numeric))
            return;

        let mode = 'auto';
        let sample = numeric;

        if (type === 'network-rx' || type === 'network-tx') {
            // sensors report a byte counter; plot the rate since the last poll
            let previous = this._chartNetPrev[key];
            sample = (previous !== undefined && numeric >= previous && dwell > 0)
                ? (numeric - previous) / dwell
                : 0;
            this._chartNetPrev[key] = numeric;
        } else if (format === 'percent') {
            sample = Math.max(0, Math.min(1, numeric));
            mode = 'fixed';
        } else if (format === 'temp') {
            sample = Math.max(0, Math.min(100, numeric / 1000)) / 100;
            mode = 'fixed';
        }

        let history = this._chartHistory[key];
        if (!history || history.mode !== mode)
            history = this._chartHistory[key] = { mode, data: [] };

        history.data.push(sample);
        if (history.data.length > CHART_POINTS)
            history.data.splice(0, history.data.length - CHART_POINTS);

        this._hotCharts[key].queue_repaint();
    }

    _drawChart(area, key) {
        let cr = area.get_context();
        try {
            let [width, height] = area.get_surface_size();
            let history = this._chartHistory[key];
            let data = history ? history.data : [];
            if (width <= 0 || height <= 0 || data.length == 0)
                return;

            let values;
            if (history.mode === 'fixed') {
                values = data;
            } else {
                let max = Math.max(...data);
                if (!(max > 0))
                    max = 1;
                values = data.map(value => Math.max(0, Math.min(1, value / max)));
            }

            let slot = width / CHART_POINTS;
            let chartOptions = this._chartSettings(key);
            let mode = chartOptions.mode;
            let chartColor = this._chartRGBA(chartOptions.color);

            if (mode == CHART_LINE) {
                cr.setSourceRGBA(...chartColor);
                cr.setLineWidth(1.5);
                let x = (CHART_POINTS - values.length) * slot;
                if (values.length == 1) {
                    cr.arc(x, height - values[0] * height, 1.2, 0, 2 * Math.PI);
                    cr.fill();
                    return;
                }
                cr.moveTo(x, height - values[0] * height);
                for (let i = 1; i < values.length; i++) {
                    x += slot;
                    cr.lineTo(x, height - values[i] * height);
                }
                cr.stroke();
            } else if (mode == CHART_HBATTERY) {
                // horizontal battery-style gauge of the latest sample
                let value = Math.max(0, Math.min(1, values[values.length - 1]));
                let barHeight = Math.min(height, 10);
                let y = (height - barHeight) / 2;
                let radius = barHeight / 2;

                // empty track
                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.28);
                this._roundRect(cr, 0, y, width, barHeight, radius);
                cr.fill();

                // filled part
                if (value > 0) {
                    let fillWidth = Math.max(barHeight, width * value);
                    cr.setSourceRGBA(...chartColor);
                    this._roundRect(cr, 0, y, fillWidth, barHeight, radius);
                    cr.fill();
                }
            } else if (mode == CHART_VBATTERY) {
                // vertical battery-style gauge, filled from the bottom
                let value = Math.max(0, Math.min(1, values[values.length - 1]));
                let barWidth = Math.min(width, 8);
                let x = (width - barWidth) / 2;
                let radius = barWidth / 2;

                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.28);
                this._roundRect(cr, x, 0, barWidth, height, radius);
                cr.fill();

                if (value > 0) {
                    let fillHeight = Math.max(barWidth, height * value);
                    cr.setSourceRGBA(...chartColor);
                    this._roundRect(cr, x, height - fillHeight, barWidth,
                        fillHeight, radius);
                    cr.fill();
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    _roundRect(cr, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        cr.newSubPath();
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.arc(x + w - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
        cr.arc(x + w - r, y + h - r, r, 0, 0.5 * Math.PI);
        cr.arc(x + r, y + h - r, r, 0.5 * Math.PI, Math.PI);
        cr.closePath();
    }

    _sensorConfig() {
        let raw = this._settings.get_string('panel-sensor-config') || '{}';
        try {
            let config = JSON.parse(raw);
            if (config && typeof config === 'object' && !Array.isArray(config))
                return config;
        } catch (e) { }
        return {};
    }

    _chartSettings(key) {
        let config = this._sensorConfig()[key] || {};
        return {
            mode: Number.isInteger(config.mode)
                ? config.mode : this._settings.get_int('panel-chart-mode'),
            showValue: (typeof config.showValue === 'boolean')
                ? config.showValue : this._settings.get_boolean('panel-chart-show-value'),
            color: (typeof config.color === 'string')
                ? config.color : this._settings.get_string('panel-chart-color'),
        };
    }

    _fontStyle(style) {
        let size = this._settings.get_int('panel-font-size');
        if (size <= 0)
            return style || null;
        return (style ? style + ' ' : '') + `font-size: ${size}px;`;
    }

    _sensorShortName(key) {
        if (key == '_default_icon_')
            return '';

        let type = key.slice(1, key.indexOf('_', 1));
        let end = key.endsWith('_') ? key.length - 1 : key.length;
        let label = key.slice(key.indexOf('_', 1) + 1, end).replaceAll('_', ' ');

        if (type === 'processor' || type.startsWith('processor-'))
            return 'CPU';
        if (type === 'memory')
            return 'RAM';
        if (type.startsWith('gpu'))
            return /memory/i.test(label) ? 'VRAM' : 'GPU';
        if (type === 'network-rx')
            return '↓';
        if (type === 'network-tx')
            return '↑';
        if (type === 'temperature')
            return '°C';
        if (type === 'fan')
            return 'RPM';
        if (type === 'storage')
            return 'DISK';
        if (type === 'battery')
            return 'BAT';
        return label || type;
    }

    _sensorDisplay(key) {
        let config = this._sensorConfig()[key] || {};
        let display = (config.display === 'name' || config.display === 'both')
            ? config.display : 'icon';
        let name = (typeof config.name === 'string' && config.name.trim())
            ? config.name.trim() : this._sensorShortName(key);
        return {display, name};
    }

    _chartRGBA(value = this._settings.get_string('panel-chart-color')) {
        value = value || '';
        let match = value.trim().match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
        if (!match)
            return CHART_RGBA;

        let hex = match[1];
        let alpha = match[2] ? parseInt(match[2], 16) / 255 : 0.9;
        return [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            alpha,
        ];
    }

    _repaintCharts() {
        for (let chart of Object.values(this._hotCharts))
            chart.queue_repaint();
    }

    _redrawHotSensors() {
        this._removeHotItems();
        this._drawMenu();
        this._values.resetHistory(this._numGpus);
        this._querySensors();
    }

    _redrawMenu() {
        for (let key in this._sensorMenuItems) {
            if (key.includes('-group')) continue;
            let item = this._sensorMenuItems[key];
            delete this._sensorMenuItems[key];
            item.destroy();
        }

        // group headers persist across row rebuilds; refresh pack (original vs gnome)
        for (let groupName in this._groups)
            this._groups[groupName].icon.gicon = Gio.icon_new_for_string(this._sensorIconPath(groupName));

        this._sensors.resetHistory(false);
        this._redrawHotSensors();
    }

    _drawMenu() {
        // grab list of selected menubar icons
        let hotSensors = this._settings.get_strv('hot-sensors');
        for (let key of Object.values(hotSensors)) {
            // fixes issue #225 which started when _max_ was moved to the end
            if (key == '__max_network-download__') key = '__network-rx_max__';
            if (key == '__max_network-upload__') key = '__network-tx_max__';

            // reuse dropdown value/icon/style so pin doesn't flash "…" or uncolored text
            let menuItem = this._sensorMenuItems[key];
            this._createHotItem(key, menuItem?.value, menuItem?.gicon, menuItem?.valueStyle);
        }
    }

    _destroyTimer() {
        if (this._refreshTimeoutId != null) {
            GLib.Source.remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
    }

    _updateDisplay(label, value, type, key, style) {
        // update sensor value in menubar
        let hotLabel = this._hotLabels[key];
        if (hotLabel) {
            hotLabel.set_text(value);
            hotLabel.style = this._fontStyle(style);

            // support for fixed widths #55
            if (this._settings.get_boolean('fixed-widths')) {
                // grab text box width and see if new text is wider than old text
                let width2 = hotLabel.get_clutter_text().width;
                if (width2 > this._widths[key]) {
                    hotLabel.set_width(width2);
                    this._widths[key] = width2;
                }
            }
        }

        // have we added this sensor before?
        let item = this._sensorMenuItems[key];
        if (item) {
            // update sensor value in the group
            item.value = value;
            item.valueStyle = style;
        } else if (type.includes('-group')) {
            // update text next to group header
            let group = type.split('-')[0];
            let statusLabel = this._groups[group]?._statusLabel;
            if (statusLabel) {
                statusLabel.text = value;
                statusLabel.style = style;
                this._sensorMenuItems[type] = this._groups[group];
            }
        } else {
            // add item to group for the first time
            let sensor = { 'label': label, 'value': value, 'type': type }
            this._appendMenuItem(sensor, key);
            this._sensorMenuItems[key].valueStyle = style;
        }
    }

    _appendMenuItem(sensor, key) {
        let split = sensor.type.split('-');
        let type = split[0];
        let icon = (split.length == 2)?'icon-' + split[1]:'icon';
        let gicon = Gio.icon_new_for_string(this._sensorIconPath(type, icon, key));

        let item = new MenuItem.MenuItem(gicon, key, sensor.label, sensor.value, this._hotLabels[key]);
        item.connect('toggle', (self) => {
            let hotSensors = this._settings.get_strv('hot-sensors');

            if (self.checked) {
                // add selected sensor to panel
                hotSensors.push(self.key);
            } else {
                // remove selected sensor from panel
                hotSensors.splice(hotSensors.indexOf(self.key), 1);
            }

            if (hotSensors.length <= 0) {
                // add generic icon to panel when no sensors are selected
                hotSensors.push('_default_icon_');
            } else {
                let defIconPos = hotSensors.indexOf('_default_icon_');
                if (defIconPos >= 0)
                    hotSensors.splice(defIconPos, 1);
            }

            // this code is called asynchronously - make sure to save it for next round
            // the changed::hot-sensors handler rebuilds the panel
            this._saveHotSensors(hotSensors);
        });

        this._sensorMenuItems[key] = item;
        let i = Object.keys(this._sensorMenuItems[key]).length;

        // alphabetize the sensors for these categories
        if (this._settings.get_boolean('alphabetize')) {
            let menuItems = this._groups[type].menu._getMenuItems();
            for (i = 0; i < menuItems.length; i++)
                // use natural sort order for system load, etc
                if (menuItems[i].label.localeCompare(item.label, undefined, { numeric: true, sensitivity: 'base' }) > 0)
                    break;
        }

        this._groups[type].menu.addMenuItem(item, i);
    }

    _defaultLabel() {
        return new St.Label({
               y_expand: true,
                y_align: Clutter.ActorAlign.CENTER
        });
    }

    _defaultIcon(key) {
        let split = key.replaceAll('_', ' ').trim().split(' ')[0].split('-');
        let type = split[0];
        let panelType = type.startsWith('gpu') ? 'gpu' : type;
        if (type === 'network' && (split[1] === 'rx' || split[1] === 'tx'))
            panelType += '-' + split[1];
        let iconStyle = this._settings.get_int('icon-style') === 1 ? 'gnome' : 'original';

        let icon = new St.Icon({
          style_class: `system-status-icon vitals-panel-icon vitals-panel-icon-${panelType} vitals-panel-icon-${iconStyle}`,
            reactive: true
        });

        // second condition prevents crash due to issue #225, which started when _max_ was moved to the end
        // don't use the default system icon if the type is a gpu; use the universal gpu icon instead
        if (type == 'default' || (!(type in this._sensorIcons) && !type.startsWith('gpu'))) {
            icon.gicon = Gio.icon_new_for_string(this._sensorIconPath('system'));
        } else { // support for hide icons #80
            let iconObj = (split.length == 2)?'icon-' + split[1]:'icon';
            icon.gicon = Gio.icon_new_for_string(this._sensorIconPath(type, iconObj, key));
        }

        return icon;
    }

    _sensorIconPath(sensor, icon = 'icon', key = '') {
        let sensorKey = sensor;

        // If the sensor is a numbered gpu, use the gpu icon. Otherwise use whatever icon associated with the sensor name.
        if (sensor.startsWith('gpu')) sensorKey = 'gpu';

        // allows country flags to show
        const icons = this._sensorIcons[sensorKey];
        if (sensorKey === 'network' && icon.startsWith('icon-') && !(icons && icons[icon])) {
            let cc = icon.slice('icon-'.length);
            if (/^[a-z]{2}$/.test(cc))
                return this._extensionObject.path + '/icons/flags/1x1/' + cc + '.svg';
        }

        const iconPathPrefixIndex = this._settings.get_int('icon-style');
        if (sensorKey === 'memory' && iconPathPrefixIndex === 1 && key.startsWith('_memory_swap_'))
            icon = 'icon-swap';
        return this._extensionObject.path + this._sensorsIconPathPrefix[iconPathPrefixIndex] + icons[icon];
    }

    _ucFirst(string) {
        if(string.startsWith('gpu')) return 'Graphics';
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    _positionInPanel() {
        let alignment = '';
        let gravity = 0;
        let arrow_pos = 0;

        switch (this._settings.get_int('position-in-panel')) {
            case 0: // left
                alignment = 'left';
                gravity = -1;
                arrow_pos = 1;
                break;
            case 1: // center
                alignment = 'center';
                gravity = -1;
                arrow_pos = 0.5;
                break;
            case 2: // right
                alignment = 'right';
                gravity = 0;
                arrow_pos = 0;
                break;
            case 3: // far left
                alignment = 'left';
                gravity = 0;
                arrow_pos = 1;
                break;
            case 4: // far right
                alignment = 'right';
                gravity = -1;
                arrow_pos = 0;
                break;
        }

        let centered = this._settings.get_boolean('menu-centered')
        if (centered) arrow_pos = 0.5;

        // set arrow position when initializing and moving vitals
        this.menu._arrowAlignment = arrow_pos;

        return [alignment, gravity];
    }

    _querySensors() {
        // figure out last run time
        let now = new Date().getTime();
        let dwell = (now - this._last_query) / 1000;
        this._last_query = now;

        // panel labels only when closed — `_default_icon_` is in _hotItems, not _hotLabels
        // empty set still queries so dwell-based sensors keep warm baselines
        let wantedKeys = this.menu.isOpen ? null : new Set(Object.keys(this._hotLabels));

        this._sensors.query((label, value, type, format) => {
            // async reads can resolve after disable(); the panel widgets are gone by then
            if (this._destroyed) return;

            let typeKey = type.replace('-group', '');
            if (/^network-(?!rx$|tx$)/.test(typeKey)) typeKey = 'network';
            let key = '_' + typeKey + '_' + label.replaceAll(' ', '_').toLowerCase() + '_';

            // issue #557 - interface is gone, drop it rather than show its last reading
            if (value == 'destroy') {
                this._values.removeNetworkSensor(key, label, type.replace('network-', ''));
                if (key in this._sensorMenuItems) {
                    this._sensorMenuItems[key].destroy();
                    delete this._sensorMenuItems[key];
                }
                this._removeHotItem(key);

                // an empty panel box leaves no way to open the menu
                if (Object.keys(this._hotItems).length == 0)
                    this._createHotItem('_default_icon_');
                return;
            }

            // if a sensor is disabled, gray it out
            if (key in this._sensorMenuItems) {
                this._sensorMenuItems[key].setSensitive((value!='disabled'));

                // don't continue below, last known value is shown
                if (value == 'disabled') return;
            } else if (value == 'disabled' && type.includes('-group')) {
                // group headers are not menu rows; formatting 'disabled' yields NaN
                return;
            }

            this._recordChartSample(key, value, type, format, dwell);

            // add/initialize any gpu groups that we haven't added yet
            if (typeKey.startsWith('gpu') && typeKey !== 'gpu#1') {
                const split = typeKey.split('#');
                if(split.length == 2 && this._numGpus < parseInt(split[1])) {
                    // occasionally two lines from nvidia-smi will be read at once
                    // so we only actually update the number of gpus if we have recieved multiple lines at least 3 times in a row
                    // i.e. we make sure that mutiple queries have detected a new gpu back-to-back
                    if(this._newGpuDetectedCount < 2) {
                        this._newGpuDetected = true;
                        return;
                    }

                    this._numGpus = parseInt(split[1]);
                    this._newGpuDetectedCount = 0;
                    this._newGpuDetected = false;
                    // change label for gpu 1 from "Graphics" to "Graphics 1" since we have multiple gpus now
                    this._groups['gpu#1'].label.text = this._ucFirst('gpu#1') + ' 1';
                    for(let i = 2; i <= this._numGpus; i++)
                        if(!('gpu#' + i in this._groups))
                            this._initializeMenuGroup('gpu#' + i, 'gpu', ' ' + i, Object.keys(this._groups).length);
                }
            }

            let items = this._values.returnIfDifferent(dwell, label, value, type, format, key);
            for (let item of items) {
                if (item.type.startsWith('network-') && item.type.length == 10 && item.type != 'network-rx' && item.type != 'network-tx') {
                    // Geo / flags: stable key (no country in key); type stays network-<cc> for icon-us etc.
                    const stem = item.type.slice('network-'.length);
                    let flagGIcon = Gio.icon_new_for_string(this._sensorIconPath('network', 'icon-' + stem));
                    if (this._hotItems[item.key] && !this._settings.get_boolean('hide-icons')) {
                        // change icon in menu bar
                        let icon = this._hotItems[item.key].get_first_child();
                        if (icon instanceof St.Icon)
                        icon.gicon = flagGIcon;
                    }
                    // change icon in dropdown
                    let menuRow = this._sensorMenuItems[item.key];
                    if (menuRow) menuRow.gicon = flagGIcon;
                }

                this._updateDisplay(_(item.label), item.value, item.type, item.key, item.style);
            }
        }, dwell, wantedKeys);

        //if a new gpu has been detected during the last query, then increment the amount of times we've detected a new gpu
        if(this._newGpuDetected) this._newGpuDetectedCount++;
        else this._newGpuDetectedCount = 0;
        this._newGpuDetected = false;
    }

    destroy() {
        this._destroyed = true;
        this._destroyTimer();
        this._sensors.destroy();

        this._settings.disconnectObject(this);
        this.menu.disconnectObject(this);

        this._hotLabels = {};
        this._hotItems = {};
        this._hotCharts = {};
        this._chartHistory = {};
        this._chartNetPrev = {};
        this._sensorMenuItems = {};

        super.destroy();
    }
});

export default class VitalsExtension extends Extension {
    enable() {
        vitalsMenu = new VitalsMenuButton(this);
        let position = vitalsMenu._positionInPanel();
        Main.panel.addToStatusArea('vitalsMenu', vitalsMenu, position[1], position[0]);
    }

    disable() {
        vitalsMenu.destroy();
        vitalsMenu = null;
    }
}
