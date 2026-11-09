"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

const excluded = [
  "chrome-extension://own-extension/bridge.js",
  "chrome-extension://another-extension/content.js?version=1",
  "CHROME-EXTENSION://another-extension/script",
  "blob:chrome-extension://another-extension/object-id",
  "filesystem:chrome-extension://another-extension/temporary/script.js"
];
const allowed = ["https://app.test/Main.controller.js", "https://app.test/chrome-extension/helper.js", "blob:https://app.test/script-id"];
function harness(file, customList) {
  const reads = [], timers = new Map(), elements = new Map();
  let added, navigated, enumerations = 0, timerId = 0;
  const list = customList || [...excluded, ...allowed].map((url) => ({ url, type: "script", getContent(done) { reads.push(url); done("function appCode() {}", ""); } }));
  const sandbox = {
    console, URL,
    setTimeout(fn, delay) { if (delay === 0) return setTimeout(fn, 0); timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, { value: "", children: [], disabled: true, addEventListener() {}, replaceChildren() {} }); return elements.get(id); },
      addEventListener() {}, querySelectorAll() { return []; }
    },
    window: { addEventListener() {} },
    UI5CodeNavigation: { create(docs) { return { urls: docs.map((doc) => doc.url) }; } },
    __UI5_TECH_LENS_SOURCES__: { sameResource: (a, b) => a === b, locate: (docs) => ({ urls: docs.map((doc) => doc.url) }) },
    chrome: { runtime: {}, devtools: {
      inspectedWindow: { getResources(done) { enumerations++; done(list); }, onResourceAdded: { addListener(fn) { added = fn; } } },
      network: { onNavigated: { addListener(fn) { navigated = fn; } } }
    } }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  return { context, reads, timers, elements, added: (resource) => added(resource), enumerations: () => enumerations,
    navigated: () => navigated(), run: (code) => vm.runInContext(code, context) };
}

test("UI5 Code excludes extension content before reading and indexing resources", async () => {
  const h = harness("code-panel.js");
  // Stub rendering only; execute the real asynchronous resource collection.
  h.run("files = () => {}; show = (location) => { current = location; }; syncSearch = () => {};");
  await h.run("refresh()");
  assert.deepEqual([...new Set(h.reads)].sort(), [...allowed].sort());
  assert.deepEqual(JSON.parse(h.run("JSON.stringify(resources.map(r => r.url))")).sort(), [...allowed].sort());
  assert.deepEqual(JSON.parse(h.run("JSON.stringify(UI5CodeNavigation.create(resources.filter(r => typeof r.content === 'string')).urls)")).sort(), [...allowed].sort());
  for (const url of excluded) {
    h.added({ url, type: "script" });
    await h.run(`window.openLocation(${JSON.stringify({ url, line: 0 })})`);
  }
  assert.equal(h.timers.size, 0, "Extension additions do not schedule refreshes");
  assert.equal(h.enumerations(), 2, "Opening excluded locations does not enumerate resources again");
  assert.equal(h.elements.get("last").disabled, true, "Excluded locations do not enable last-function navigation");
  h.added({ url: "debugger:///VM123", type: "script" });
  assert.equal(h.timers.size, 0, "Runtime inventory queries cannot trigger an endless resource-refresh loop");
  assert.ok(allowed.includes(h.run("current.url")));
  h.added({ url: allowed[0], type: "script" });
  assert.equal(h.timers.size, 1, "Application scripts still schedule refreshes");
});

test("handler location never reads extension scripts, even with an exact URL match", async () => {
  const h = harness("devtools.js");
  const result = await h.run(`locate(${JSON.stringify({ url: excluded[0], source: "function appCode() {}" })})`);
  assert.deepEqual(h.reads, allowed.slice(0, 2));
  assert.deepEqual(Array.from(result.urls), allowed.slice(0, 2));
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
test("runtime XML inventory appears without a DevTools resource and reads only the selected source", async () => {
  const h = harness("code-panel.js", [{ url: "https://app.test/Component.js?eval", type: "script", getContent(done) { done("function component() {}", ""); } }]);
  const descriptor = { url: "https://app.test/view/Main.view.xml", path: "demo/view/Main.view.xml", key: "view:main", frameId: 7, controllers: ["demo.controller.Main"] };
  const calls = [];
  h.context.testSend = async (message) => { calls.push(message); return message.action === "getXMLResources" ? { resources: [descriptor] } : { content: '<View controllerName="demo.controller.Main"><Button press=".onSave"/></View>' }; };
  h.run('chrome.runtime.sendMessage = testSend; files = () => {}; render = () => {}; markCurrentFile = () => {}; syncSearch = () => {};');
  await h.run("refresh()");
  assert.ok(h.run("resources.some(r => r.url.endsWith('Main.view.xml'))"), "The runtime adds XML omitted by DevTools");
  assert.equal(calls.filter((m) => m.action === "readXML").length, 0, "Discovery does not download XML source");
  await h.run(`window.openLocation(${JSON.stringify({ ...descriptor, xmlContext: descriptor.controllers })})`);
  assert.equal(h.run("current.url"), descriptor.url, "The requested XML replaces Component.js?eval");
  assert.equal(calls.filter((m) => m.action === "readXML")[0].frameId, 7, "The source is read from its actual frame");
  assert.deepEqual(JSON.parse(h.run("JSON.stringify(current.xmlContext)")), descriptor.controllers);
  await h.run(`show(${JSON.stringify({ url: descriptor.url })})`);
  assert.equal(calls.filter((m) => m.action === "readXML").length, 1, "Repeat selections reuse the XML content");
});

test("an XML request during initial loading survives the component selection and missing resources never open another script", async () => {
  let complete;
  const h = harness("code-panel.js", [{ url: "https://app.test/Component.js?eval", type: "script", getContent(done) { if (complete) done("function component() {}", ""); else complete = done; } }]);
  const descriptor = { url: "https://app.test/view/Main.view.xml", key: "view:main", frameId: 0, controllers: [] };
  h.context.testSend = async (m) => m.action === "getXMLResources" ? { resources: [descriptor] } : { content: '<View><Button press=".onSave"/></View>' };
  h.run('files = () => {}; render = () => {}; markCurrentFile = () => {}; syncSearch = () => {};');
  await tick();
  h.run('chrome.runtime.sendMessage = testSend;');
  const opening = h.run(`window.openLocation(${JSON.stringify(descriptor)})`);
  await tick();
  complete("function component() {}", "");
  await opening;
  assert.equal(h.run("current.url"), descriptor.url);
  h.context.testSend = async () => ({ resources: [] });
  await h.run('window.openLocation({url:"https://app.test/missing.view.xml"})');
  assert.equal(h.run("current"), null, "Missing XML cannot silently open Component.js?eval");
  assert.match(h.elements.get("status").textContent, /recurso no está/);
});

test("requested file is shown while unrelated resource reads are still pending", async () => {
  const callbacks = new Map(), reads = [];
  const urls = ["https://app.test/A.js", "https://app.test/B.js", "https://app.test/Target.js"];
  const h = harness("code-panel.js", urls.map((url) => ({ url, type: "script", getContent(done) { reads.push(url); callbacks.set(url, done); } })));
  h.run('files = () => {}; render = () => {}; markCurrentFile = () => {}; syncSearch = () => {};');
  await tick();
  const opening = h.run(`window.openLocation(${JSON.stringify({ url: urls[2], line: 12, column: 3 })})`);
  await tick();
  assert.deepEqual(reads, [urls[0], urls[2]], "The target bypasses the pending initial read");
  callbacks.get(urls[2])("function target() {}", "");
  await opening;
  assert.equal(h.run("current.url"), urls[2]);
  assert.equal(h.run("current.line"), 12);
  callbacks.get(urls[0])("function first() {}", "");
  await tick();
  assert.equal(h.run("current.url"), urls[2], "The initial read cannot replace the requested file");
  assert.equal(reads.filter(url => url === urls[2]).length, 1, "The background load reuses the target content");
  callbacks.get(urls[1])("function other() {}", "");
  await tick();
  assert.match(h.elements.get("load-status").textContent, /3 archivos disponibles/);
});

test("a newer selection and page navigation discard pending reads", async () => {
  const callbacks = new Map();
  const urls = ["https://app.test/A.js", "https://app.test/B.js"];
  const h = harness("code-panel.js", urls.map((url) => ({ url, type: "script", getContent(done) { callbacks.set(url, done); } })));
  h.run('files = () => {}; render = () => {}; markCurrentFile = () => {}; syncSearch = () => {};');
  // Fail if a stale read reaches rendering.
  h.run('render = () => { throw new Error("Stale selection reached render"); };');
  await tick();
  const opening = h.run(`window.openLocation(${JSON.stringify({ url: urls[1], line: 1 })})`);
  await tick();
  h.run('selection++; loading++; resources = []; current = null;');
  callbacks.get(urls[1])("function stale() {}", "");
  callbacks.get(urls[0])("function initial() {}", "");
  await opening;
  await tick();
  assert.equal(h.run("current"), null);
  assert.equal(h.run("resources.length"), 0);
});
