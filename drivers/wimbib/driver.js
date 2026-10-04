'use strict';

const Homey = require('homey');
const got = require('got');


module.exports = class WimbibDriver extends Homey.Driver {

  address = null;

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('WimbibDriver has been initialized');
    const discoveryStrategy = this.getDiscoveryStrategy();
    this.log('strategy:', discoveryStrategy);

    const initialDiscoveryResults = discoveryStrategy.getDiscoveryResults();

    for (const discoveryResult of Object.values(initialDiscoveryResults)) {
      this.log('initial:', discoveryResult);
      this.handleDiscoveryResult(discoveryResult);
    }

    discoveryStrategy.on('result', discoveryResult => {
      this.log('got discovery result:', discoveryResult);
      this.handleDiscoveryResult(discoveryResult);
    });

    this.registerFlowTriggers();
  }

  // App-level trigger cards (.homeycompose/flow/triggers) with a device argument,
  // fired from WimbibDevice with the device in the state
  registerFlowTriggers() {
    const triggerIds = [
      'alarm_water.burst_true',
      'alarm_water.dry_true',
      'alarm_water.reverse_true',
      'meter_water.target_changed',
    ];

    for (const triggerId of triggerIds) {
      this.homey.flow.getTriggerCard(triggerId)
        .registerRunListener(async (args, state) => args.device.getData().id === state.device.getData().id);
    }
  }

  handleDiscoveryResult(discoveryResult) {
    const device = {
      name: discoveryResult.txt.name,
      data: {
        id: discoveryResult.txt.id,
      },
      settings: {
        wimbib_address: `${discoveryResult.address}:${discoveryResult.port}`,
      },
    };

    this.discoveryResult = device;

    this.log('stored discoveryresult:', this.discoveryResult);
  }

  async onPair(session) {
    this.log('onPair');

    session.setHandler('showView', async (viewId) => {
      this.log('View:', viewId);
    });

    session.setHandler('test_connection', async (data) => {
      this.log('test connection:', data.wimbibAddress);

      try {
        this.address = data.wimbibAddress;
        const deviceInfo = await this.getDeviceInfo();
        return deviceInfo;
      } catch (error) {
        this.error(error);
        return 'ERROR';
      }
    });

    // called by list_devices view template
    session.setHandler('list_devices', async (data) => {
      this.log('list_devices called');

      if (this.discoveryResult) {
        this.log('discoveryResult found', this.discoveryResult);
        return [this.discoveryResult];
      }
      this.log('no devices found - going to manual add view');
      await session.showView('manual_add_view');
      return [];
    });
  }


  async getDeviceInfo() {
    const url = `http://${this.address}/deviceInfo`;
    const response = await got(url);
    const deviceInfo = JSON.parse(response.body);
    return deviceInfo;
  }
};
