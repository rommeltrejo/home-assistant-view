/** MQTT is supported but disabled by default; enabling is an explicit opt-in. */
const test = require("node:test");
const assert = require("node:assert/strict");

global.ARGS = {};
const integration = require("../js/integration");
const { meaningful, validate } = require("./startup-settings");

test("MQTT stays off by default, even with a broker URL configured", async () => {
  global.ARGS = { mqtt_url: "mqtt://broker.test:1883" };
  assert.equal(integration.mqttEnabled(), false);
  assert.equal(await integration.init(), false);
  assert.equal(global.INTEGRATION.initialized, false);
});

test("MQTT stays off when the opt-in is explicitly false", async () => {
  global.ARGS = { mqtt_enable: "false", mqtt_url: "mqtt://broker.test:1883" };
  assert.equal(integration.mqttEnabled(), false);
  assert.equal(await integration.init(), false);
});

test("opt-in without a broker URL still does not connect", async () => {
  global.ARGS = { mqtt_enable: null };
  assert.equal(integration.mqttEnabled(), true);
  assert.equal(await integration.init(), false);
  global.ARGS = { mqtt_enable: "true" };
  assert.equal(integration.mqttEnabled(), true);
  assert.equal(await integration.init(), false);
});

test("mqtt_enable persists as a presence-flag setting and validates", () => {
  assert.deepEqual(meaningful({ mqtt_enable: null, mqtt_url: "mqtt://broker.test:1883" }),
    { mqtt_enable: null, mqtt_url: "mqtt://broker.test:1883" });
  assert.doesNotThrow(() => validate({ web_url: "https://ha.test", mqtt_enable: "true", mqtt_url: "mqtt://broker.test:1883" }));
  assert.throws(() => validate({ web_url: "https://ha.test", mqtt_enable: "yes" }), /Invalid mqtt_enable/);
});
