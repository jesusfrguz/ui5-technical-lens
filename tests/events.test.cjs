"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto"), path = require("node:path");
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
test("bound UI5 listeners recover the unique effective method in the view controller without firing it", () => {
  const E = inspector(); let calls = 0;
  const controller = { onValueHelp(oEvent) { calls++; }, getMetadata: () => ({ getName: () => "app.Main" }) };
  const bound = controller.onValueHelp.bind(controller);
  const control = { getMetadata: () => ({ getAllEvents: () => ({ valueHelpRequest: {} }) }), mEventRegistry: { valueHelpRequest: [{ fFunction: bound }] } };
  const context = { controller, controllers: [{ name: "app.Main", path: "app/Main.controller.js" }] };
  const handler = E.inspect(control, context)[0].handlers[0];
  assert.equal(handler.name, "onValueHelp"); assert.equal(handler.controller, "app.Main");
  assert.equal(handler.arguments, "oEvent"); assert.equal(handler.path, "app/Main.controller.js");
  assert.equal(E.resolve(handler.token), controller.onValueHelp); assert.equal(calls, 0);
  assert.ok(handler.resolution.includes("por nombre"));
  const extension = { onValueHelp(oEvent) {} }; controller._sapui_Extensions = { ext: { extension } };
  const ambiguous = E.inspect(control, context)[0].handlers[0];
  assert.equal(E.resolve(ambiguous.token), bound); assert.ok(ambiguous.resolution.includes("varios métodos"));
  assert.equal(E.describe(ambiguous.token).source.includes("[native code]"), true);
});
test("DevTools opens only the matched resource with explicit zero-based line and column", async () => {
  let listener, reply, opened;
  const context = { __UI5_TECH_LENS_SOURCES__: require("../source-locator.js"), setTimeout, clearTimeout,
    chrome: { runtime: { id: "test-extension", connect: () => ({ postMessage: (message) => { reply = message; }, onDisconnect: { addListener: () => {} }, onMessage: { addListener: (callback) => { listener = callback; } } }) },
    devtools: { inspectedWindow: { tabId: 7, getResources: (callback) => callback([{ url: "https://example.com/Main.js", getContent: (callback) => callback("// heading\nconst fn = function run() {};", "") }]) },
      panels: { openResource: (url, line, column, callback) => { opened = { url, line, column }; callback(); } } } } };
  vm.runInNewContext(fs.readFileSync(require("node:path").join(__dirname, "../devtools.js"), "utf8"), context);
  assert.equal(reply.tabId, 7);
  await listener({ action: "openHandler", token: "');alert(1)//" }); assert.equal(opened, undefined);
  const token = `h${"a".repeat(32)}_1`;
  await listener({ action: "openHandler", token, requestId: token, descriptor: { source: "function run() {}", url: "https://example.com/Main.js" } });
  assert.deepEqual(opened, { url: "https://example.com/Main.js", line: 1, column: 11 });
  assert.ok(reply.status.includes("línea 2, columna 12"));
  opened = undefined;
  await listener({ action: "openHandler", token, requestId: token, descriptor: { source: "function missing() {}" } });
  assert.equal(opened, undefined); assert.ok(reply.status.includes("No se encontró"));
});
test("DevTools stops reconnecting when its extension context is invalidated", () => {
  let valid = true, disconnect, scheduled = 0, connections = 0;
  const context = { setTimeout: () => { scheduled++; }, chrome: { runtime: { get id() { if (!valid) throw new Error("Extension context invalidated."); return "test-extension"; },
    connect: () => { connections++; return { postMessage() {}, onDisconnect: { addListener: (callback) => { disconnect = callback; } }, onMessage: { addListener() {} } }; } }, devtools: { inspectedWindow: { tabId: 1 } } } };
  const script = fs.readFileSync(path.join(__dirname, "../devtools.js"), "utf8");
  vm.runInNewContext(script, context); assert.equal(connections, 1);
  valid = false; assert.doesNotThrow(() => disconnect()); assert.equal(scheduled, 0);
  vm.runInNewContext(script, { chrome: context.chrome }); assert.equal(connections, 1);
});
