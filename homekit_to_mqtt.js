
const debugModule = require('debug');
debugModule.enable('*');
const debug = debugModule('homekit_to_mqtt');

const _ = require('lodash');
const mqtt = require('mqtt');
const config = require('config');

// Apparently this is a dep of hap-nodejs? Not sure what it needs to store.
debug('Initing node-persist...');
var storage = require('node-persist');
storage.initSync();
debug('Done initing node-persist');
const {Service, Characteristic, Accessory, Bridge, uuid} = require('hap-nodejs');

const mqttConfig = config.get('mqtt');
const homekitConfig = config.get('homekit');
const deviceConfig = config.get('devices');

function defaultStateForDeviceType(deviceType) {
  switch (deviceType) {
    case 'switch':
      return {on: false};
    case 'colored_light':
      return {on: false, hue: 0, saturation: 1.0, brightness: 50};
    default:
      throw new Error('invalid device type');
  }
}

function isDeviceTypeSupported(deviceType) {
  switch (deviceType) {
    case 'switch':
      return true;
    default:
      return false;
  }
}

const state = _
  .chain(deviceConfig)
  .filter(device => {
    const supported = isDeviceTypeSupported(device.type);
    if (!supported) {
      debug('Ignoring device %s of unsupported type %s', device.displayName, device.type);
    }

    return supported;
  })
  .keyBy('id')
  .mapValues(val => ({
    ...val,
    state: defaultStateForDeviceType(val.type),
    service: null,
    accessory: null,
  }))
  .value();

function onMqttMessage(topic, message) {
  if (topic in mqttTopics) {
    const fn = mqttTopics[topic];
    fn(message);
  } else {
    debug('received message on unknown mqtt topic', topic);
  }
}

async function mqttSubscribe(topic, fn) {
  return new Promise((resolve, reject) => {
    mqttTopics[topic] = fn;

    mqttClient.subscribe(topic, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function getHomekitValue(device, key) {
  debug('HomeKit asked for property %s of device %s', key, device.displayName);
  return false;
}

async function setHomekitValue(device, key, val) {
  debug('HomeKit set property device %s: %s=%s', device.displayName, key, val);
}

async function main() {
  debug("Connecting to MQTT...");
  mqttClient = mqtt.connect(mqttConfig.brokerAddress, {clientId: mqttConfig.clientId});
  mqttClient.on('message', onMqttMessage);

  debug("Setting up Homekit devices");
  const bridgeUuid = uuid.generate(`homekit_to_mqtt:bridge`);
  const bridge = new Bridge(homekitConfig.bridgeDisplayName, bridgeUuid);
  _.forEach(state, device => {
    const deviceUuid = uuid.generate(`homekit_to_mqtt:device:${device.id}`);
    const accessory = new Accessory(device.displayName, deviceUuid);
    device.accessory = accessory;

    switch (device.type) {
      case 'switch':
        const service = accessory.addService(Service.Switch, device.displayName);
        device.service = service;
        const on = service.getCharacteristic(Characteristic.On);
        on.on('get', async cb => {
          const val = await getHomekitValue(device, 'on');

          // TODO: Should this wait for a device response and error if it times out?
          cb(null /* error */, val);
        });
        on.on('set', async (val, cb) => {
          await setHomekitValue(device, 'on', val);
          cb();
        });
        break;

      default:
        throw new Error('unsupported device type');
    }

    bridge.addBridgedAccessory(accessory);

    debug('Registered HomeKit device %s (type=%s)', device.displayName, device.type);
  });

  debug('Publishing HomeKit bridge. PIN is %s', homekitConfig.pincode);
  bridge.publish({
    ..._.pick(homekitConfig, [
      'username',
      'port',
      'pincode',
    ]),
    category: Accessory.Categories.BRIDGE
  });

  debug('Setting up unpublish hook');
  var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
  Object.keys(signals).forEach(function (signal) {
    process.on(signal, function () {
      bridge.unpublish();
      setTimeout(function (){
          process.exit(128 + signals[signal]);
      }, 1000);
    });
  });

  // debug("Setting up MQTT listeners...");
}

main();