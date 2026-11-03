"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../inspector.js"), "utf8"), H = require("../core.js");
function setup({ delayed = false, fragmentLoaded = true, initialized = true } = {}) {
  const timeouts = new Map(), listeners = new Map(), registry = {}, calls = { requests: 0, core: 0, now: 0, fragmentLoaded, initialized };
  let sequence = 0, nextResult;
  function Fragment() {}
  Fragment.prototype._initCompositeSupport = function (settings) { this._aContent = settings.content; return "original result"; };
  const load = Fragment.load = () => nextResult;
  const context = { WeakRef, performance: { now: () => calls.now }, location: { href: "https://example.test/" },
    document: { title: "Test", documentElement: null, activeElement: null, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type), querySelectorAll: () => [] },
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    setTimeout: (fn, delay) => { const id = ++sequence; timeouts.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timeouts.delete(id),
    setInterval: () => ++sequence, clearInterval() {}, requestAnimationFrame: () => ++sequence, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} }, __UI5_TECH_LENS_CORE__: H,
    __UI5_TECH_LENS_DATA__: { applications: () => [] } };
  context.window = context;
  function runtime() { context.sap = { ui: { getCore: () => { calls.core++; return { isInitialized: () => calls.initialized }; }, require: (name) => {
    if (Array.isArray(name)) { calls.requests++; return; }
    return name === "sap/ui/core/Fragment" && calls.fragmentLoaded ? Fragment : name === "sap/ui/core/Element" ? { registry: { all: () => registry } } : null;
  } } }; }
  if (!delayed) runtime();
  vm.runInNewContext(source, context);
  return { context, api: context.__UI5_TECH_LENS__, Fragment, load, calls, timeouts, listeners, runtime,
    next: (value) => { nextResult = value; }, step: () => { const [id, task] = timeouts.entries().next().value; timeouts.delete(id); task.fn(); } };
}
const root = (id) => ({ getId: () => id, destroyed: false, isDestroyed() { return this.destroyed; } });
test("captures fragments before first activation without loading UI5, scanning models or creating an overlay", async () => {
  const f = setup(), dialog = root("already-open"), original = Promise.resolve(dialog);
  f.next(original);
  assert.notEqual(f.Fragment.load, f.load, "Passive capture is installed at document start");
  assert.equal(f.Fragment.load({ name: "demo.AlreadyOpen", controller: {} }), original, "Preserves the original promise");
  await original; await Promise.resolve();
  f.api.setOptions({ enabled: false }); // The bridge can replay disabled preferences.
  const entry = f.api.snapshot().entries.find((item) => item.path === "demo/AlreadyOpen.fragment.xml");
  assert.deepEqual(Array.from(entry.ids), ["already-open"]);
  assert.equal(f.api.snapshot().options.enabled, false);
  assert.equal(f.calls.requests, 0); assert.equal(f.calls.core, 0);
});
test("disabled preferences keep the watcher alive for a late bootstrap, including after 20 seconds", () => {
  const f = setup({ delayed: true });
  f.api.setOptions({ enabled: false });
  assert.equal(f.timeouts.size, 1);
  f.calls.now = 30000; f.step();
  assert.equal([...f.timeouts.values()][0].delay, 250);
  f.runtime(); f.step();
  assert.notEqual(f.Fragment.load, f.load);
  assert.equal(f.timeouts.size, 0, "Stops polling after hooks are installed");
  assert.equal(f.listeners.has("load"), false);
  assert.equal(f.calls.requests, 0); assert.equal(f.calls.core, 0);
});
test("early capture waits for Core initialization before requesting Fragment, even with labels off", () => {
  const f = setup({ fragmentLoaded: false, initialized: false });
  f.step(); assert.equal(f.calls.requests, 0, "Never races library preloads during Core bootstrap");
  f.calls.initialized = true; f.step();
  assert.equal(f.calls.requests, 1, "Starts capture before the user activates the overlay");
  f.step(); assert.equal(f.calls.requests, 1, "Does not issue duplicate pending requests");
  f.calls.fragmentLoaded = true; f.step();
  assert.notEqual(f.Fragment.load, f.load);
  assert.equal(f.timeouts.size, 0);
});
test("captures legacy/declarative and multi-root fragments while disabled, preserving factory results and errors", () => {
  const f = setup(), first = root("first"), second = root("second"), instance = {};
  assert.equal(f.Fragment.prototype._initCompositeSupport.call(instance, { fragmentName: "demo.Multi", content: [first, second] }), "original result");
  const entry = f.api.snapshot().entries.find((item) => item.name === "demo.Multi");
  assert.deepEqual(Array.from(entry.ids), ["first", "second"]);
  first.destroyed = second.destroyed = true;
  assert.ok(!f.api.snapshot().entries.some((item) => item.name === "demo.Multi"), "Destroyed roots are removed");
  const failure = new Error("Original factory failure");
  f.Fragment.load = () => { throw failure; };
  f.api.snapshot(); // Reinstalls capture around a replaced factory.
  assert.throws(() => f.Fragment.load({ name: "demo.Bad" }), (error) => error === failure);
});
test("failed or inline fragment creation doesn't invent an origin", async () => {
  const f = setup(), element = root("no-origin");
  f.next(Promise.resolve(element)); await f.Fragment.load({ definition: "inline", name: "not.a.resource" });
  f.next(Promise.reject(new Error("Cannot load")));
  await assert.rejects(f.Fragment.load({ name: "demo.Missing" }), /Cannot load/);
  assert.equal(f.api.snapshot().entries.length, 0);
});
