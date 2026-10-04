'use strict';

const Homey = require('homey');
const got = require('got');

const POLL_INTERVAL = 10000;
// The wimbib can take several seconds to answer the first request after being idle
const REQUEST_TIMEOUT = 15000;
// Consecutive failed polls before the device is marked unavailable
const MAX_FAILED_POLLS = 3;
// Hourly meter readings kept for the dashboard widget
const HISTORY_HOURS = 24;

// Litres used between two meter readings in m³
const toLitres = (from, to) => Math.max(0, Math.round((to - from) * 1000));

// m³/h -> L/min, the unit Homey uses for measure_water
const M3H_TO_LMIN = 1000 / 60;

// Capabilities used before v1.1.0, replaced by their main capability
const LEGACY_CAPABILITIES = {
  'alarm_water.leak': 'alarm_water',
  'meter_water.total': 'meter_water',
  'measure_water.flow': 'measure_water',
};

// Maps keys in the wimbib /meterData response ("meter" and "info" sections) to capabilities.
// desc is a key in locales/*.json under "desc".
const METRICS = {
  // meter
  'leak-alarm': { desc: 'leak_alarm', unit: '', capability: 'alarm_water' },
  'burst-alarm': { desc: 'burst_alarm', unit: '', capability: 'alarm_water.burst', triggerOnTrue: 'alarm_water.burst_true' },
  'dry-alarm': { desc: 'dry_alarm', unit: '', capability: 'alarm_water.dry', triggerOnTrue: 'alarm_water.dry_true' },
  'reverse-alarm': { desc: 'reverse_alarm', unit: '', capability: 'alarm_water.reverse', triggerOnTrue: 'alarm_water.reverse_true' },

  total_volume: { desc: 'total_volume', unit: 'm³', capability: 'meter_water' },
  target_volume: { desc: 'target_volume', unit: 'm³', capability: 'meter_water.target', triggerOnChange: 'meter_water.target_changed' },
  flow_actual: { desc: 'flow_actual', unit: 'L/min', capability: 'measure_water', scale: M3H_TO_LMIN, triggerOnChange: 'measure_water.actual_changed' },

  max_flow_day: { desc: 'max_flow_day', unit: 'L/min', capability: 'measure_water.max_flow_day', scale: M3H_TO_LMIN },
  max_flow_month: { desc: 'max_flow_month', unit: 'L/min', capability: 'measure_water.max_flow_month', scale: M3H_TO_LMIN },
  max_flow_year: { desc: 'max_flow_year', unit: 'L/min', capability: 'measure_water.max_flow_year', scale: M3H_TO_LMIN },

  min_flow_day: { desc: 'min_flow_day', unit: 'L/min', capability: 'measure_water.min_flow_day', scale: M3H_TO_LMIN },
  min_flow_month: { desc: 'min_flow_month', unit: 'L/min', capability: 'measure_water.min_flow_month', scale: M3H_TO_LMIN },

  volume_weighted_water_temp_day: { desc: 'volume_weighted_water_temp_day', unit: 'C', capability: 'measure_temperature.volume_weighted_water_temp_day' },
  volume_weighted_water_temp_month: { desc: 'volume_weighted_water_temp_month', unit: 'C', capability: 'measure_temperature.volume_weighted_water_temp_month' },

  max_water_temp_day: { desc: 'max_water_temp_day', unit: 'C', capability: 'measure_temperature.max_water_temp_day' },
  max_water_temp_month: { desc: 'max_water_temp_month', unit: 'C', capability: 'measure_temperature.max_water_temp_month' },
  max_water_temp_year: { desc: 'max_water_temp_year', unit: 'C', capability: 'measure_temperature.max_water_temp_year' },

  min_water_temp_day: { desc: 'min_water_temp_day', unit: 'C', capability: 'measure_temperature.min_water_temp_day' },
  min_water_temp_month: { desc: 'min_water_temp_month', unit: 'C', capability: 'measure_temperature.min_water_temp_month' },
  min_water_temp_year: { desc: 'min_water_temp_year', unit: 'C', capability: 'measure_temperature.min_water_temp_year' },

  time_weighted_meter_temp_day: { desc: 'time_weighted_meter_temp_day', unit: 'C', capability: 'measure_temperature.time_weighted_meter_temp_day' },

  max_meter_temp_month: { desc: 'max_meter_temp_month', unit: 'C', capability: 'measure_temperature.max_meter_temp_month' },
  max_meter_temp_year: { desc: 'max_meter_temp_year', unit: 'C', capability: 'measure_temperature.max_meter_temp_year' },

  min_meter_temp_day: { desc: 'min_meter_temp_day', unit: 'C', capability: 'measure_temperature.min_meter_temp_day' },
  min_meter_temp_month: { desc: 'min_meter_temp_month', unit: 'C', capability: 'measure_temperature.min_meter_temp_month' },
  min_meter_temp_year: { desc: 'min_meter_temp_year', unit: 'C', capability: 'measure_temperature.min_meter_temp_year' },

  instantaneous_flow_temp: { desc: 'instantaneous_flow_temp', unit: 'C', capability: 'measure_temperature.instantaneous_flow_temp' },

  // info
  wifi_rssi: { desc: 'wifi_rssi', unit: 'dBm', capability: 'measure_signal_strength.wifi' },
  wmbus_rssi: { desc: 'wmbus_rssi', unit: 'dBm', capability: 'measure_signal_strength.wmbus' },
};

module.exports = class WimbibDevice extends Homey.Device {

  address = null;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('WimbibDevice has been initialized');

    const settings = this.getSettings();
    this.log('wimbib address:', settings.wimbib_address);
    this.address = settings.wimbib_address;

    this.failedPolls = 0;
    this.updating = false;

    await this.migrateCapabilities().catch(this.error);

    await this.update();

    this.pollTimeout = this.homey.setInterval(async () => {
      await this.update();
    }, POLL_INTERVAL);
  }

  /**
   * Removes capabilities from older app versions and refreshes title/units
   * on existing ones so changed units and translations are applied.
   */
  async migrateCapabilities() {
    for (const legacyCapability of Object.keys(LEGACY_CAPABILITIES)) {
      if (this.hasCapability(legacyCapability)) {
        this.log('removing legacy capability', legacyCapability);
        await this.removeCapability(legacyCapability);
      }
    }

    for (const metricInfo of Object.values(METRICS)) {
      if (this.hasCapability(metricInfo.capability)) {
        await this.setCapabilityOptions(metricInfo.capability, this.getCapabilityOptionsFor(metricInfo));
      }
    }
  }

  async update() {
    // A slow response can outlast the poll interval, don't stack requests
    if (this.updating) {
      return;
    }
    this.updating = true;

    try {
      await this.poll();
    } catch (error) {
      this.error('Error while updating capabilities', error);
    } finally {
      this.updating = false;
    }
  }

  async poll() {
    const url = `http://${this.address}/meterData`;

    let meterData;
    try {
      const response = await got(url, { timeout: REQUEST_TIMEOUT, retry: 0 });
      meterData = JSON.parse(response.body);
    } catch (error) {
      this.failedPolls++;
      this.error(`Failed to get meterData from ${url} (${this.failedPolls} in a row):`, error.message);

      // The wimbib often sits on weak Wi-Fi, only go unavailable when it stays unreachable
      if (this.failedPolls >= MAX_FAILED_POLLS) {
        await this.setUnavailable(this.homey.__('error.unreachable')).catch(this.error);
        this.emitWidgetUpdate();
      }
      return;
    }

    this.failedPolls = 0;

    if (meterData == null) {
      this.error('meterData response was empty');
      return;
    }

    await this.setAvailable().catch(this.error);
    await this.applyMetrics(meterData.meter);
    await this.applyMetrics(meterData.info);

    this.lastUpdate = Date.now();
    await this.recordHistory().catch(this.error);
    this.emitWidgetUpdate();
  }

  /**
   * Keeps the meter reading at the start of each hour (last 24 h) and at local midnight,
   * so the widget can show hourly use and today's use without Insights access.
   */
  async recordHistory() {
    const total = this.getCapabilityValueOrNull('meter_water');
    if (typeof total !== 'number') {
      return;
    }

    const now = new Date();
    const hourStart = new Date(now);
    hourStart.setUTCMinutes(0, 0, 0);

    const hourly = this.getStoreValue('hourly') || [];
    const lastEntry = hourly[hourly.length - 1];
    if (!lastEntry || lastEntry.t !== hourStart.toISOString()) {
      hourly.push({ t: hourStart.toISOString(), v: total });
      await this.setStoreValue('hourly', hourly.slice(-HISTORY_HOURS));
    }

    // Local calendar periods, e.g. "2026-10-05" and "2026-10"
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.homey.clock.getTimezone() }).format(now);
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const lastMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);

    await this.rollPeriod('day', today, yesterday.toISOString().slice(0, 10), total);
    await this.rollPeriod('month', today.slice(0, 7), lastMonth.toISOString().slice(0, 7), total);
  }

  /**
   * Stores the meter reading at the start of a day or month. When a new period starts,
   * the use of the one that just ended is kept as "previous". A period is partial when
   * its start wasn't seen, e.g. right after install or when Homey was off at midnight.
   */
  async rollPeriod(name, current, previous, total) {
    const start = this.getStoreValue(`${name}Start`);
    if (start && start.period === current) {
      return;
    }

    const continuous = start != null && start.period === previous;
    const ended = continuous
      ? { period: previous, litres: toLitres(start.v, total), partial: !!start.partial }
      : null;

    await this.setStoreValue(`${name}Previous`, ended);
    await this.setStoreValue(`${name}Start`, { period: current, v: total, partial: !continuous });
  }

  getWidgetData() {
    const total = this.getCapabilityValueOrNull('meter_water');
    const hourly = this.getStoreValue('hourly') || [];
    const sinceStart = (name) => {
      const start = this.getStoreValue(`${name}Start`);
      return typeof total === 'number' && start && start.v != null
        ? { period: start.period, litres: toLitres(start.v, total), partial: !!start.partial }
        : null;
    };

    return {
      id: this.getData().id,
      name: this.getName(),
      available: this.getAvailable(),
      lastUpdate: this.lastUpdate || null,
      total,
      today: sinceStart('day'),
      yesterday: this.getStoreValue('dayPrevious'),
      month: sinceStart('month'),
      lastMonth: this.getStoreValue('monthPrevious'),
      flow: this.getCapabilityValueOrNull('measure_water'),
      maxFlowDay: this.getCapabilityValueOrNull('measure_water.max_flow_day'),
      wifiRssi: this.getCapabilityValueOrNull('measure_signal_strength.wifi'),
      alarms: {
        leak: this.getCapabilityValueOrNull('alarm_water'),
        burst: this.getCapabilityValueOrNull('alarm_water.burst'),
        dry: this.getCapabilityValueOrNull('alarm_water.dry'),
        reverse: this.getCapabilityValueOrNull('alarm_water.reverse'),
      },
      // Use per hour; the current hour runs up to the latest reading
      hourly: typeof total === 'number'
        ? hourly.map((entry, i) => ({ t: entry.t, litres: toLitres(entry.v, i + 1 < hourly.length ? hourly[i + 1].v : total) }))
        : [],
    };
  }

  emitWidgetUpdate() {
    Promise.resolve(this.homey.api.realtime('wimbib:update', this.getWidgetData())).catch(this.error);
  }

  getCapabilityValueOrNull(capability) {
    return this.hasCapability(capability) ? this.getCapabilityValue(capability) : null;
  }

  async applyMetrics(metrics) {
    if (metrics == null) {
      return;
    }

    for (const metricKey in metrics) {
      const metricInfo = this.getMetricInfo(metricKey);
      if (metricInfo == null) {
        continue;
      }

      const { capability } = metricInfo;
      const value = metricInfo.scale ? metrics[metricKey] * metricInfo.scale : metrics[metricKey];

      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
        await this.setCapabilityOptions(capability, this.getCapabilityOptionsFor(metricInfo));
      }

      const previousValue = this.getCapabilityValue(capability);
      await this.setCapabilityValue(capability, value);

      if (metricInfo.triggerOnTrue && value === true && previousValue !== true) {
        await this.homey.flow.getTriggerCard(metricInfo.triggerOnTrue)
          .trigger({}, { device: this })
          .catch(this.error);
      }

      if (metricInfo.triggerOnChange && previousValue != null && value !== previousValue) {
        await this.homey.flow.getTriggerCard(metricInfo.triggerOnChange)
          .trigger({ [capability]: value }, { device: this })
          .catch(this.error);
      }
    }
  }

  getMetricInfo(metricKey) {
    return METRICS[metricKey] || null;
  }

  getCapabilityOptionsFor(metricInfo) {
    return {
      title: this.homey.__(`desc.${metricInfo.desc}`),
      units: metricInfo.unit,
    };
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('WimbibDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('WimbibDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('WimbibDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('WimbibDevice has been deleted');
    this.homey.clearInterval(this.pollTimeout);
  }

  /**
   * onUninit is called when the app is stopped or restarted.
   */
  async onUninit() {
    this.homey.clearInterval(this.pollTimeout);
  }

  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    const address = `${discoveryResult.address}:${discoveryResult.port}`;
    this.log('WimbibDevice discovery address changed to:', address);
    this.address = address;
    await this.setSettings({ wimbib_address: address }).catch(this.error);
  }

};
