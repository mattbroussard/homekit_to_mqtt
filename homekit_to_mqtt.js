
const debugModule = require('debug');
debugModule.enable('*');
const debug = debugModule('homekit_to_mqtt');

const _ = require('lodash');
const mqtt = require('mqtt');
const config = require('config');

const mqttConfig = config.get('mqtt');

const state = {};

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

async function main() {
  debug("Connecting to MQTT...");
  mqttClient = mqtt.connect(mqttConfig.brokerAddress, {clientId: mqttConfig.clientId});
  mqttClient.on('message', onMqttMessage);

  // ...
}

main();