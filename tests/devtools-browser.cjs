"use strict";
// Exercise the real DevTools extension API and inspect the native Sources editor.
const { chromium } = require("playwright"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const root = path.resolve(__dirname, ".."), output = path.join(root, "test-results");
fs.mkdirSync(output, { recursive: true });
const sources = {
  "/A.controller.js": 'window.A = {\n  onOther: function (event) { return "other"; },\n  onAction: function (event) {\n    return "A";\n  },\n  first: function () {},\n  second: function () {}\n};',
  "/B.controller.js": 'window.B = {\n  onOther: function (event) { return "other"; },\n  onAction: function (event) {\n    return "B";\n  },\n  first: function () {},\n  second: function () {}\n};',
  "/Inline.controller.js": 'window.Inline={onFirst:function(e){return e+1},onAction:function(e){return e+2}};'
};
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", sources[request.url] ? "text/javascript" : "text/html");
  response.end(sources[request.url] || '<!doctype html><h1>UI5 Lens · native DevTools regression test</h1><script src="/A.controller.js"></script><script src="/B.controller.js"></script><script src="/Inline.controller.js"></script>');
});
(async () => {
  let context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5-native-tools-"));
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { channel: process.env.UI5_TEST_BROWSER || "chromium", headless: true,
      args: ["--auto-open-devtools-for-tabs", `--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    const page = context.pages()[0]; await page.goto(url);
    const cdp = await context.newCDPSession(page);
    const target = (await cdp.send("Target.getTargets")).targetInfos.find((target) => target.url.startsWith("devtools://"));
    assert.ok(target, "Native DevTools frontend is running");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    let sequence = 0; const pending = new Map();
    cdp.on("Target.receivedMessageFromTarget", (event) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message), callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
    });
    const native = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
    const evaluate = async (expression) => {
      const result = await native("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const editor = () => evaluate(`(async () => {
      const S = await import("./panels/sources/sources.js");
      const frame = S.SourcesPanel.SourcesPanel.instance().sourcesView().currentSourceFrame();
      if (!frame) return null;
      const state = frame.textEditor.state, head = state.selection.main.head, line = state.doc.lineAt(head);
      return { url: frame.uiSourceCode().url(), line: line.number, column: head - line.from, text: line.text };
    })()`);
    async function request(frame, controller, method, expected, bound = false) {
      const token = await frame.evaluate(({ controller, method, bound }) => {
        const value = window[controller]; value.getMetadata = () => ({ getName: () => controller });
        window.sap = { ui: { require: Object.assign(() => null, { toUrl: (path) => new URL(path, location.href).href }) } };
        const entry = window.__UI5_TECH_LENS_EVENTS__.inspect({ getMetadata: () => ({ getAllEvents: () => ({ press: {} }) }), mEventRegistry: { press: [{ fFunction: bound ? value[method].bind(value) : value[method], oListener: bound ? undefined : value }] } },
          { controller: value, controllers: [{ name: controller, path: `${controller}.controller.js` }] })[0].handlers[0];
        window.__sourceResults = [];
        if (!window.__watchSource) { window.__watchSource = true; window.addEventListener("message", (event) => { if (event.source === window && event.data?.channel === "ui5-lens:source-result") window.__sourceResults.push(event.data); }); }
        window.postMessage({ channel: "ui5-lens:source-request", token: entry.token }, "*"); return entry.token;
      }, { controller, method, bound });
      await frame.waitForFunction((token) => window.__sourceResults.some((result) => result.token === token && result.status.includes("Ubicación enviada")), token, { timeout: 15000 });
      let actual;
      const selected = (value) => value?.url === `${url}/${controller}.controller.js` &&
        ((value.line === expected.line && value.column === expected.column) ||
          (expected.formatted && value.text.includes(`${method}:`) && value.column === value.text.indexOf("function")));
      for (let attempt = 0; attempt < 60; attempt++) {
        actual = await editor();
        if (selected(actual)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(selected(actual), JSON.stringify({ actual, expected }));
      console.log(`Native Sources: ${controller}.${method} → ${actual.url}:${actual.line}:${actual.column + 1}`);
    }
    await request(page, "A", "onAction", { line: 3, column: 12 });
    await request(page, "A", "onAction", { line: 3, column: 12 }, true);
    await request(page, "B", "onAction", { line: 3, column: 12 });
    await request(page, "B", "second", { line: 7, column: 10 });
    await request(page, "Inline", "onAction", { line: 1, column: sources["/Inline.controller.js"].indexOf("function(e){return e+2}"), formatted: true });
    await page.evaluate(() => { (0, eval)('window.Virtual={\n onAction: function (event) { return "virtual"; }\n};\n//# sourceURL=' + new URL("/Virtual.controller.js", location.href).href); });
    await request(page, "Virtual", "onAction", { line: 2, column: 11 });
    await page.evaluate(() => { const frame = document.createElement("iframe"); frame.src = location.href; document.body.append(frame); const other = frame.cloneNode(); document.body.append(other); });
    await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2 && [...document.querySelectorAll("iframe")].every((frame) => frame.contentWindow.B));
    await request(page.frames().at(-1), "B", "onAction", { line: 3, column: 12 });
    await request(page, "A", "onAction", { line: 3, column: 12 });
    const screenshot = await native("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, "devtools-function-location.png"), Buffer.from(screenshot.data, "base64"));
    fs.writeFileSync(path.join(output, "devtools-function-location.json"), JSON.stringify(await editor(), null, 2));
    console.log("PASS: real DevTools API, correct file and cursor, same method names, identical bodies, minified columns and identical-URL iframes.");
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (profile.startsWith(path.join(os.tmpdir(), "ui5-native-tools-"))) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
