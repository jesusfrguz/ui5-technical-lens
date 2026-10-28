"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const code = fs.readFileSync(require("node:path").join(__dirname, "../event-inspector.js"), "utf8");
function inspector() {
  const context = { crypto, WeakRef }; context.window = context;
  vm.runInNewContext(code, context);
  return context.__UI5_TECH_LENS_EVENTS__;
}
test("event inspection reads schema and all listeners without running handlers, getters or business-data accessors", () => {
  const E = inspector(); let calls = 0;
  const controller = { onPress(oEvent, count = "secret") { calls++; }, getMetadata: () => ({ getName: () => "demo.Main" }) };
  Object.defineProperty(controller, "danger", { get() { throw new Error("getter executed"); } });
  const extra = function (event) { calls++; };
  const record = { fFunction: controller.onPress, oListener: controller };
  Object.defineProperty(record, "oData", { get() { throw new Error("data read"); } });
  const control = { getMetadata: () => ({ getAllEvents: () => ({ press: { parameters: { source: { type: "sap.ui.core.Control" } } }, change: {} }) }),
    mEventRegistry: { press: [record, { fFunction: extra }], hiddenInternal: [{ fFunction: extra }] } };
  const events = E.inspect(control, { controller, controllers: [{ name: "demo.Main", path: "demo/Main.controller.js" }] });
  assert.equal(events.length, 1); assert.equal(events[0].handlers.length, 2);
  assert.equal(events[0].parameters[0].type, "sap.ui.core.Control");
  const handler = events[0].handlers[0];
  assert.equal(handler.name, "onPress"); assert.equal(handler.arguments, "oEvent, count");
  assert.equal(handler.path, "demo/Main.controller.js"); assert.equal(E.resolve(handler.token), controller.onPress);
  assert.equal(E.inspect(control, { controller })[0].handlers[0].token, handler.token);
  assert.ok(!JSON.stringify(events).includes("secret")); assert.equal(calls, 0);
  control.mEventRegistry.press = []; assert.equal(E.inspect(control).length, 0);
});
test("parameterized XML handlers resolve method paths without evaluating the expression, unknown aliases retain the registered wrapper", () => {
  const E = inspector();
  const controller = { nested: { action(oEvent) { throw new Error("handler fired"); } } };
  const wrapper = () => { throw new Error("wrapper fired"); }; wrapper._sapui_handlerName = ".nested.action($event, 'secret')";
  const control = { getMetadata: () => ({ getAllEvents: () => ({ valueHelpRequest: {} }) }), mEventRegistry: { valueHelpRequest: [{ fFunction: wrapper, oListener: controller }] } };
  let handler = E.inspect(control, { controller })[0].handlers[0];
  assert.equal(E.resolve(handler.token), controller.nested.action); assert.equal(handler.declaration, ".nested.action(…)");
  assert.equal(handler.arguments, "oEvent"); assert.ok(!JSON.stringify(handler).includes("secret"));
  wrapper._sapui_handlerName = "UnknownAlias.action($event)";
  handler = E.inspect(control, { controller })[0].handlers[0];
  assert.equal(E.resolve(handler.token), wrapper); assert.equal(handler.resolution, "función registrada");
});
test("inherited handlers identify their declaring controller and resource", () => {
  const E = inspector();
  class Base { onPress(oEvent) {} }
  class Main extends Base {}
  const baseMeta = { getName: () => "demo.Base", getClass: () => Base };
  const mainMeta = { getName: () => "demo.Main", getClass: () => Main, getParent: () => baseMeta };
  const controller = new Main(); controller.getMetadata = () => mainMeta;
  const control = { getMetadata: () => ({ getAllEvents: () => ({ press: { appData: { parameters: { flag: { type: "boolean" } } } } }) }), mEventRegistry: { press: [{ fFunction: controller.onPress, oListener: controller }] } };
  const event = E.inspect(control, { controller, controllers: [{ name: "demo.Main", path: "demo/Main.controller.js" }, { name: "demo.Base", path: "demo/Base.js" }] })[0];
  assert.equal(event.handlers[0].controller, "demo.Base"); assert.equal(event.handlers[0].path, "demo/Base.js");
  assert.equal(event.parameters[0].name, "flag");
});
test("DevTools navigation uses a validated token and the frame URL, never invokes the inspected handler", () => {
  let listener, expression, options, reply, inspected, calls = 0;
  const fn = () => { calls++; };
  const context = { chrome: { runtime: { connect: () => ({ postMessage: (message) => { reply = message; }, onDisconnect: { addListener: () => {} }, onMessage: { addListener: (callback) => { listener = callback; } } }) },
    devtools: { inspectedWindow: { tabId: 7, eval: (source, settings, callback) => {
      expression = source; options = settings;
      callback(vm.runInNewContext(source, { window: { __UI5_TECH_LENS_EVENTS__: { resolve: () => fn } }, inspect: (value) => { inspected = value; } }), null);
    } } } } };
  vm.runInNewContext(fs.readFileSync(require("node:path").join(__dirname, "../devtools.js"), "utf8"), context);
  assert.equal(reply.tabId, 7);
  listener({ action: "openHandler", token: "');alert(1)//" }); assert.equal(expression, undefined);
  listener({ action: "openHandler", token: `h${"a".repeat(32)}_1`, requestId: `h${"a".repeat(32)}_1`, frameURL: "https://example.com/frame" });
  assert.equal(options.frameURL, "https://example.com/frame"); assert.equal(inspected, fn); assert.equal(calls, 0);
  assert.ok(reply.status.includes("línea real"));
});
