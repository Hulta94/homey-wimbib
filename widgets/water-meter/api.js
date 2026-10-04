'use strict';

module.exports = {
  async getData({ homey }) {
    const devices = homey.drivers.getDriver('wimbib').getDevices();

    return {
      language: homey.i18n.getLanguage(),
      devices: devices.map((device) => device.getWidgetData()),
    };
  },
};
