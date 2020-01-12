
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

let bridge;
let mqttClient;
let mqttTopics = {};

function defaultStateForDeviceType(deviceType) {
  switch (deviceType) {
    case 'switch':
      return {on: false};
    case 'colored_light':
      return {on: false, hue: 0, saturation: 1.0, brightness: 50};
    case 'temp_meter':
      return {temp: 0.0, humidity: 0.0};
    default:
      throw new Error('invalid device type');
  }
}

function isDeviceTypeSupported(deviceType) {
  switch (deviceType) {
    case 'switch':
      return true;
    case 'temp_meter':
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
    ignoreSets: false,
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
  debug("Subscribing to MQTT topic %s", topic);
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

function refreshDevice(device) {
  if (device.topics.refresh) {
    debug("Asking for refresh of device %s.", device.displayName);

    const refreshTopic = device.topics.refresh;
    mqttClient.publish(refreshTopic, '{}');
  } else {
    debug("Device %s doesn't have a refresh topic.", device.displayName);
  }
}

async function getHomekitValue(device, key) {
  const value = device.state[key];
  debug('HomeKit asked for property %s of device %s. Returning %s then refreshing.', key, device.displayName, value);

  refreshDevice(device);
  return value;
}

async function setValueFromHomekit(device, key, val) {
  if (device.ignoreSets) {
    return;
  }

  debug('HomeKit set device %s\'s property: %s=%s', device.displayName, key, val);
  device.state[key] = val;

  switch (key) {
    case 'on':
      const onTopic = device.topics.set_on;
      mqttClient.publish(onTopic, JSON.stringify(val));
      break;
  }
}

async function setValueFromMQTT(device, key, val) {
  debug('Received updated property value over MQTT for device %s: %s=%s', device.displayName, key, val);
  device.state[key] = val;

  switch (key) {
    case 'on':
      const characteristic = device.service.getCharacteristic(Characteristic.On);

      // The ignoreSets flag is to avoid an infinite loop where setting in homekit causes a homekit
      // set event, that triggers an MQTT set call, that then triggers a state event that triggers
      // setting in HomeKit.
      device.ignoreSets = true;
      characteristic.setValue(val, () => device.ignoreSets = false);

      break;

    case 'temp':
      const characteristic = device.service.getCharacteristic(Characteristic.CurrentTemperature);
      characteristic.setValue(val);
      break;

    case 'humidity':
      const characteristic = device.service.getCharacteristic(Characteristic.CurrentRelativeHumidity);
      characteristic.setValue(val / 100);
      break;
  }
}

function setupMQTTLogging() {
  const events = ['connect', 'reconnect', 'close', 'disconnect', 'offline', 'error', 'end'];
  events.forEach(eventName => {
    mqttClient.on(eventName, (value) => {
      debug(`MQTT ${eventName} event: `, value);
    });
  });
}

async function connectToMQTT() {
  debug("Connecting to MQTT...");
  mqttClient = mqtt.connect(mqttConfig.brokerAddress, {clientId: mqttConfig.clientId, keepalive: 5});
  setupMQTTLogging();
  mqttClient.on('message', onMqttMessage);

  await new Promise((resolve, reject) => {
    mqttClient.on('error', reject);
    mqttClient.on('connect', () => resolve());
  });

  debug('Connected to MQTT.');
}

function getUuid(type, key) {
  const namespace = homekitConfig.uuidNamespace;
  const suffix = type + (key ? ':' + key : '');
  const prefix = 'homekit_to_mqtt:' + (namespace ? namespace + ':' : '');

  return uuid.generate(prefix + suffix);
}

async function main() {
  await connectToMQTT();

  debug("Setting up Homekit devices");
  const bridgeUuid = getUuid('bridge');
  bridge = new Bridge(homekitConfig.bridgeDisplayName, bridgeUuid);
  const mqttSubscribePromises = _.map(state, async device => {
    const deviceUuid = getUuid('device', device.id);
    const accessory = new Accessory(device.displayName, deviceUuid);
    device.accessory = accessory;

    switch (device.type) {
      case 'switch':
        // Setup HomeKit listeners
        const service = accessory.addService(Service.Switch, device.displayName);
        device.service = service;
        const on = service.getCharacteristic(Characteristic.On);
        on.on('get', async cb => {
          const val = await getHomekitValue(device, 'on');

          // TODO: Should this wait for a device response and error if it times out?
          cb(null /* error */, val);
        });
        on.on('set', async (val, cb) => {
          await setValueFromHomekit(device, 'on', val);
          cb();
        });

        // Setup MQTT listeners
        await mqttSubscribe(device.topics.on, async message => {
          let val;
          try {
            val = JSON.parse(message);
          } catch (e) {
            debug("Received invalid on value for device %s from MQTT, ignoring", device.displayName);
            return;
          }

          await setValueFromMQTT(device, 'on', val);
        });
        break;

      case 'temp_meter':
        // Setup HomeKit listeners
        const service = accessory.addService(Service.TemperatureSensor, device.displayName);
        device.service = service;
        const temp = service.getCharacteristic(Characteristic.CurrentTemperature);
        temp.on('get', async cb => {
          const val = await getHomekitValue(device, 'temp');
          cb(null /* error */, val);
        });
        const humidity = service.getCharacteristic(Characteristic.CurrentRelativeHumidity);
        humidity.on('get', async cb => {
          const val = await getHomekitValue(device, 'humidity');
          cb(null /* error */, val);
        });

        // Setup MQTT listeners
        await Promise.all(['temp', 'humidity'].map(name =>
          mqttSubscribe(device.topics[name], async message => {
            let val;
            try {
              val = JSON.parse(message);
            } catch (e) {
              debug("Received invalid %s value for device %s from MQTT, ignoring", name, device.displayName);
              return;
            }

            await setValueFromMQTT(device, name, val);
          })
        ));
        break;

      default:
        throw new Error('unsupported device type');
    }

    bridge.addBridgedAccessory(accessory);

    // Do an initial refresh request so we have correct initial state.
    refreshDevice(device);

    debug('Registered HomeKit device %s (type=%s)', device.displayName, device.type);
  });
  await Promise.all(mqttSubscribePromises);

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
}

main();