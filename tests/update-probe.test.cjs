"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const script = fs.readFileSync(path.join(__dirname, "../update-probe.js"), "utf8");
const base = "/sap/bc/ui5_ui5/sap/zapp";
function setup() {
  const calls = [], events = {}, timers = [], posted = [];
  const state = { entries: [{ name: `https://sap.test${base}/~old~5/Component-preload.js`, transferSize: 0 }],
    body: { "demo.app": { url: base + "/~new~5/" } }, ok: true,
    apps: [{ id: "demo.app", component: "demo.app", title: "Pedidos", bsp: { path: base }, score: 140 }] };
  const context = { URL, AbortSignal, Map, location: { origin: "https://sap.test", pathname: "/sap/bc/ui2/flp", hash: "#App-open", href: "https://sap.test/sap/bc/ui2/flp?sap-client=100#App-open" },
    __UI5_TECH_LENS_DATA__: { applications: () => state.apps }, performance: { getEntriesByType: () => state.entries },
    PerformanceObserver: class { constructor(fn) { state.observed = fn; } observe() {} },
    MutationObserver: class { constructor(fn) { state.mutated = fn; } observe() {} }, document: {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    addEventListener: (name, fn) => { events[name] = fn; }, postMessage: (data) => posted.push(data),
    fetch: async (url, options) => { calls.push({ url, options }); if (state.fail) throw new Error("offline"); return { ok: state.ok, status: 403, text: async () => typeof state.body === "string" ? state.body : JSON.stringify(state.body) }; } };
  context.window = context; vm.runInNewContext(script, context);
  return { state, calls, events, posted, context, runTimer: () => timers.shift()?.(), check: (force) => context.__UI5_LENS_UPDATES__.check(force) };
}
test("a stale cached app is detected on the FIRST check, using actual aggregate tokens", async () => {
  const h = setup(), result = (await h.check())[0];
  assert.equal(result.state, "changed"); assert.equal(result.loadedToken, "~old~5"); assert.equal(result.currentToken, "~new~5");
  assert.equal(h.calls[0].url, "https://sap.test/sap/bc/ui2/app_index/ui5_app_info_json?sap-client=100&id=demo.app");
  assert.equal(h.calls[0].options.cache, "no-store"); assert.equal(h.calls[0].options.credentials, "same-origin");
  await h.check(); await h.check(); assert.equal(h.calls.length, 1, "Repeated local discovery does not poll ABAP");
  vm.runInNewContext(script, h.context); await h.check(); assert.equal(h.calls.length, 1, "Popup reinjection is idempotent");
  h.state.body["demo.app"].url = base + "/~old~5/";
  assert.equal((await h.check(true))[0].state, "current", "Manual check makes one fresh request");
  assert.equal(h.calls.length, 2);
});
test("navigation rechecks once per app entry; inner routes and additional same-token resources do not poll", async () => {
  const h = setup(); await h.check();
  h.context.location.hash = "#App-open&/detail/1"; await h.check(); assert.equal(h.calls.length, 1);
  h.state.entries.push({ name: `https://sap.test${base}/~old~5/view/Main.view.xml` });
  await h.check(); assert.equal(h.calls.length, 1);
  h.context.location.hash = "#Shell-home"; await h.check();
  h.context.location.hash = "#App-open"; await h.check(); assert.equal(h.calls.length, 3);
  h.runTimer(); const messages = h.posted.length;
  h.state.mutated(); h.runTimer(); assert.equal(h.posted.length, messages, "Unchanged DOM discoveries do not emit more checks");
  assert.ok(!script.includes("setInterval"), "There is no periodic network timer");
  assert.ok(!fs.readFileSync(path.join(__dirname, "../update-notice.js"), "utf8").includes("setInterval"));
});

test("rapid home-to-app navigation still invalidates the previous entry result", async () => {
  const h = setup(); await h.check();
  h.events.hashchange({ newURL: "https://sap.test/sap/bc/ui2/flp#Shell-home" });
  h.events.hashchange({ newURL: "https://sap.test/sap/bc/ui2/flp#App-open" });
  await h.check(); assert.equal(h.calls.length, 2);
});
test("per-file tokens are compared with the same file, not with aggregate tokens", async () => {
  const h = setup();
  h.state.entries = [{ name: `https://sap.test${base}/~20260101~/Component-preload.js` }];
  h.state.body = { "Component-preload.js": "20261109" };
  assert.equal((await h.check())[0].state, "changed");
  assert.ok(h.calls[0].url.includes("/sap-ui-cachebuster-info.json"));
  h.state.body = { "Component-preload.js": "20260101" };
  assert.equal((await h.check(true))[0].state, "current");
  h.state.body = { "manifest.json": "20260101" };
  assert.equal((await h.check(true))[0].state, "unavailable", "Missing comparison data cannot prove the version");
});
test("missing/ambiguous tokens, auth failures and login HTML never imply an update or a current version", async () => {
  const h = setup();
  for (const body of ["<html>Login</html>", {}, [], { error: "Unauthorized" }, { "demo.app": { url: base } },
    { "Component-preload.js": "new" }, { "demo.app": { url: base + "/~new~5/", asyncHints: { components: [{ name: "demo.app", url: base + "/~other~5/" }] } } }]) {
    h.state.body = body; assert.equal((await h.check(true))[0].state, "unavailable");
  }
  h.state.ok = false; assert.equal((await h.check(true))[0].state, "unavailable");
  h.state.ok = true; h.state.fail = true; assert.equal((await h.check(true))[0].state, "unavailable");
});
test("predicted module paths and cross-origin timings are not evidence of loaded app code", async () => {
  const h = setup(); h.state.entries = [{ name: `https://other.test${base}/~old~5/Component.js` }];
  assert.equal((await h.check())[0].state, "unavailable"); assert.equal(h.calls.length, 0);
  h.state.entries = [{ name: `https://sap.test${base}/Component.js` }];
  assert.equal((await h.check())[0].state, "unavailable"); assert.equal(h.calls.length, 0);
});
test("async component hints are matched by component AND exact BSP, never by an unrelated dependency", async () => {
  const h = setup(); h.state.body = { "demo.app": { asyncHints: { components: [
    { name: "unrelated.lib", url: base + "/~new~5/" }, { name: "demo.app", url: { url: base + "/~old~5/" } }
  ] } } };
  assert.equal((await h.check())[0].state, "current");
  h.state.body["demo.app"].asyncHints.components[1].url.url = "/sap/bc/ui5_ui5/sap/another/~new~5/";
  assert.equal((await h.check(true))[0].state, "unavailable");
});
test("reload requires an extension request for its own tab and always bypasses cache", async () => {
  let listener; const reloads = [];
  const context = { chrome: { runtime: { getURL: (p) => "chrome-extension://test/" + p,
    onConnect: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { reload: async (...args) => reloads.push(args), onRemoved: { addListener() {} } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const request = { channel: "ui5-lens", action: "reloadLaunchpad", tabId: 999 };
  const result = await new Promise((resolve) => listener(request, { tab: { id: 12 }, frameId: 0, url: "https://sap.test/flp" }, resolve));
  assert.equal(result.ok, true); assert.equal(reloads[0][0], 12); assert.equal(reloads[0][1].bypassCache, true);
  listener(request, { tab: { id: 12 }, frameId: 3, url: "https://sap.test/frame" }, () => {});
  assert.equal(reloads.length, 1);
});

test("only manual extension checks can force a request, and late navigation results cannot replace newer notices", async () => {
  let listener; const pending = [], broadcasts = [], args = [];
  const context = { chrome: {
    runtime: { getURL: (p) => "chrome-extension://test/" + p, sendMessage: async () => {},
      onConnect: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    scripting: { executeScript: (request) => { args.push(request.args); return new Promise((resolve) => pending.push(resolve)); } },
    tabs: { sendMessage: async (...values) => broadcasts.push(values), onRemoved: { addListener() {} } }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const message = { channel: "ui5-lens", action: "checkAppUpdates", force: true, tabId: 12 };
  const earlier = new Promise((resolve) => listener(message, { url: "https://sap.test/frame", tab: { id: 12 }, frameId: 3 }, resolve));
  const latest = new Promise((resolve) => listener(message, { url: "chrome-extension://test/popup.html" }, resolve));
  assert.equal(args[0][0], false); assert.equal(args[1][0], true);
  pending[1]([{ result: [{ app: "new.app", state: "current" }] }]); await latest;
  pending[0]([{ result: [{ app: "old.app", state: "changed" }] }]); await earlier;
  assert.equal(broadcasts.length, 1); assert.equal(broadcasts[0][1].updates[0].app, "new.app");
});
