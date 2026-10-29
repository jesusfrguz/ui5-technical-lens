"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const script = fs.readFileSync(path.join(__dirname, "../bridge.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup() {
  const pageListeners = new Set(), runtimeListeners = new Set(), posted = [], requests = [];
  const state = { valid: true, send: async () => ({ enabled: true, controllers: true }) };
  const runtime = { get id() { return state.valid ? "test-extension" : undefined; },
    sendMessage: (message) => { requests.push(message); return state.send(message); },
    onMessage: { addListener: (callback) => runtimeListeners.add(callback), removeListener: (callback) => runtimeListeners.delete(callback) } };
  const context = { chrome: { runtime }, postMessage: (message) => posted.push(message),
    addEventListener: (name, callback) => pageListeners.add(callback), removeEventListener: (name, callback) => pageListeners.delete(callback) };
  context.window = context;
  vm.createContext(context); vm.runInContext(script, context);
  const dispatch = (data) => { context.testMessage = data; vm.runInContext("window.testDispatch(window.testMessage)", context); };
  context.testDispatch = (data) => { for (const callback of [...pageListeners]) callback({ source: vm.runInContext("window", context), data }); };
  return { context, state, posted, requests, pageListeners, runtimeListeners, dispatch };
}
test("synchronous sendMessage failure after reload is caught and detaches the old bridge", async () => {
  const fixture = setup(); await flush();
  fixture.state.send = () => { throw new Error("Extension context invalidated."); };
  assert.doesNotThrow(() => fixture.dispatch({ channel: "ui5-lens:hover-request", command: "toggle" })); await flush();
  assert.equal(fixture.pageListeners.size, 0);
  const sent = fixture.requests.length, posted = fixture.posted.length;
  fixture.dispatch({ channel: "ui5-lens:ready" }); fixture.dispatch({ channel: "ui5-lens:hover-request", command: "toggle" });
  await flush(); assert.equal(fixture.requests.length, sent); assert.equal(fixture.posted.length, posted, "No stale preferences are replayed");
  for (const callback of fixture.runtimeListeners) callback({ channel: "ui5-lens", options: { enabled: true } });
  assert.equal(fixture.posted.length, posted, "Pending runtime callbacks stay inert after invalidation");
});
test("a source click receives reload guidance for both synchronous and asynchronous invalidation", async () => {
  for (const asyncFailure of [false, true]) {
    const fixture = setup(); await flush();
    fixture.state.send = () => { const error = new Error("Extension context invalidated."); if (asyncFailure) return Promise.reject(error); throw error; };
    const token = `h${"a".repeat(32)}_1`;
    fixture.dispatch({ channel: "ui5-lens:source-request", token }); await flush();
    const result = fixture.posted.find((message) => message.channel === "ui5-lens:source-result");
    assert.equal(result.token, token); assert.ok(result.status.includes("Recarga esta pestaña")); assert.equal(fixture.pageListeners.size, 0);
  }
});
test("a missing runtime is handled at startup and before sending cached preferences", async () => {
  const fixture = setup(); await flush(); fixture.state.valid = false;
  const posted = fixture.posted.length;
  fixture.dispatch({ channel: "ui5-lens:ready" }); await flush();
  assert.equal(fixture.posted.length, posted); assert.equal(fixture.pageListeners.size, 0);
  const context = { chrome: { get runtime() { throw new Error("Extension context invalidated."); } }, addEventListener() {}, removeEventListener() {} }; context.window = context;
  assert.doesNotThrow(() => vm.runInNewContext(script, context));
});
test("a transient connection failure does not kill a live bridge; reinjection and source validation remain safe", async () => {
  const fixture = setup(); await flush(); fixture.state.send = () => Promise.reject(new Error("Receiving end does not exist"));
  fixture.dispatch({ channel: "ui5-lens:hover-request", command: "toggle" }); await flush(); assert.equal(fixture.pageListeners.size, 1);
  fixture.state.send = async () => ({ status: "connected" });
  const sent = fixture.requests.length;
  fixture.dispatch({ channel: "ui5-lens:source-request", token: "');execute()" }); await flush(); assert.equal(fixture.requests.length, sent);
  vm.runInContext(script, fixture.context); assert.equal(fixture.pageListeners.size, 1);
  const token = `h${"b".repeat(32)}_7`; fixture.dispatch({ channel: "ui5-lens:source-request", token }); await flush();
  assert.equal(fixture.posted.at(-1).status, "connected");
});

test("Ctrl highlight messages validate temporary state and survive extension invalidation", async () => {
  const fixture = setup(); await flush();
  const sent = fixture.requests.length;
  fixture.dispatch({ channel: "ui5-lens:highlight-request", active: "true" }); await flush();
  assert.equal(fixture.requests.length, sent, "Only boolean highlight state crosses the bridge");
  fixture.dispatch({ channel: "ui5-lens:highlight-request", active: true });
  fixture.dispatch({ channel: "ui5-lens:highlight-request", active: false }); await flush();
  assert.deepEqual(fixture.requests.slice(sent).map((request) => [request.action, request.active]), [["highlightTargets", true], ["highlightTargets", false]]);
  fixture.state.send = () => { throw new Error("Extension context invalidated."); };
  assert.doesNotThrow(() => fixture.dispatch({ channel: "ui5-lens:highlight-request", active: true })); await flush();
  assert.equal(fixture.pageListeners.size, 0);
});

test("invalidation cleanup never touches chrome.runtime again, including listener removal", async () => {
  const fixture = setup(); await flush();
  let accesses = 0;
  fixture.state.send = () => {
    Object.defineProperty(fixture.context.chrome, "runtime", { get() { accesses++; throw new Error("Extension context invalidated."); } });
    throw new Error("Extension context invalidated.");
  };
  const token = `h${"c".repeat(32)}_9`;
  fixture.dispatch({ channel: "ui5-lens:source-request", token }); await flush();
  assert.equal(accesses, 0, "Neither the invalidation handler nor cleanup reads the dead API");
  assert.equal(fixture.pageListeners.size, 0);
  assert.ok(fixture.posted.at(-1).status.includes("Recarga esta pestaña"));
  for (const callback of fixture.runtimeListeners) callback({ channel: "ui5-lens", options: { enabled: true } });
  assert.equal(accesses, 0, "In-flight runtime callbacks short-circuit before touching the API");
});
