"use strict";
// Exercise the real DevTools extension API and inspect the native Sources editor.
const { launchExtension } = require("./browser-context.cjs"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const root = path.resolve(__dirname, ".."), output = path.join(root, "test-results");
fs.mkdirSync(output, { recursive: true });
const sources = {
  "/lazy/view/Runtime.view.xml": '<mvc:View xmlns:mvc="sap.ui.core.mvc" controllerName="demo.controller.Main"><Button press=".onSave"/></mvc:View>',
  "/lazy/fragment/Runtime.fragment.xml": '<FragmentDefinition><Button press=".onSave"/></FragmentDefinition>',
  "/demo/view/Main.view.xml": '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" controllerName="demo.controller.Main">\n  <Button text="&lt;img src=x onerror=alert(1)&gt;" press=".onSave($event, &quot;sample&quot;)"/>\n</mvc:View>',
  "/demo/fragment/Dialog.fragment.xml": '<FragmentDefinition xmlns="sap.ui.core" xmlns:m="sap.m">\n  <m:Button press="onSave"/>\n</FragmentDefinition>',
  "/demo/controller/Main.controller.js": 'sap.ui.define([], function() {\n  return Controller.extend("demo.controller.Main", {\n    onSave: function() { throw new Error("Never execute a handler"); }\n  });\n});',
  "/demo/Component-preload.js": 'sap.ui.require.preload({"demo/fragment/Bundled.fragment.xml": "<FragmentDefinition><Button press=\\\".onSave\\\"/></FragmentDefinition>"});',
  "/A.controller.js": 'window.A = {\n  onOther: function (event) { return "other"; },\n  onAction: function (event) {\n    return "A";\n  },\n  first: function () { return this.second(); },\n  second: function () {}\n};',
  "/B.controller.js": 'window.B = {\n  onOther: function (event) { return "other"; },\n  onAction: function (event) {\n    return "B";\n  },\n  first: function () {},\n  second: function () {}\n};',
  "/Inline.controller.js": 'window.Inline={onFirst:function(e){return e+1},onAction:function(e){return e+2}};',
  "/modules/Nav.js": 'import { work } from "./Helper.js";\nwindow.nav = () => work();\nimport Child from "./Child.js";\nwindow.child = new Child();\nconst LIMIT = 10;\nlet count;\nwindow.values = () => [LIMIT, count];\nimport Library from "./Library.js";\nwindow.library = () => { Library.open(); const instance = new Library(); instance.run(); };',
  "/modules/Library.js": 'function Library() {}\nLibrary.open = function () {};\nLibrary.prototype.run = function () {};\nexport default Library;',
  "/UI5Nav.js": 'sap.ui.define(["tmb/infAlta/lib/AutoSearchHelp"], function (AutoSearchHelp) {\n  var oHelp = AutoSearchHelp.createValueHelp(\n    this, oEvent, args\n  );\n});',
  "/sap/bc/ui5_ui5/sap/zalta/lib/AutoSearchHelp.js": `sap.ui.define([], function () {
    var modules = Object.create(null);
    modules["AutoSearchHelp"] = (function () {
      var oSHMain = { createValueHelp: async function (that, oEvent, args) { throw new Error("Must never execute"); } };
      ["createValueHelp", "suggest", "validate"].forEach(function (name) {
        var initialize = oSHMain[name];
        oSHMain[name] = function (that, event, options) { return initialize.call(this, that, event, options); };
      });
      return oSHMain;
    })();
    return modules.AutoSearchHelp;
  });`,
  "/modules/Base.js": 'export default class Base {\n  inherited() {}\n  shared() {}\n}',
  "/modules/Child.js": 'import Base from "./Base.js";\nexport default class Child extends Base {\n  run() { this.inherited(); this.shared(); }\n  inherited() { super.inherited(); }\n}',
  "/modules/Helper.js": 'export function work() { return "<img src=x onerror=alert(1)>"; }',
  "/SearchMany.js": "/*\n" + Array.from({ length: 205 }, (_, i) => `lens-many-hit ${i}`).join("\n") + "\n*/"
};
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", sources[request.url] ? "text/javascript" : "text/html");
  response.end(sources[request.url] || '<!doctype html><h1>UI5 Lens · native DevTools regression test</h1><script>window.sap = { ui: { define() {}, require: { toUrl(id) { return "/sap/bc/ui5_ui5/sap/zalta/" + id.replace("tmb/infAlta/", ""); } } } };</script><script src="/UI5Nav.js"></script><script src="/sap/bc/ui5_ui5/sap/zalta/lib/AutoSearchHelp.js"></script><script src="/A.controller.js"></script><script src="/B.controller.js"></script><script src="/Inline.controller.js"></script><script src="/SearchMany.js"></script><script type="module" src="/modules/Nav.js"></script>');
});
(async () => {
  let context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5-native-tools-"));
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    context = await launchExtension(profile, { args: ["--auto-open-devtools-for-tabs"] });
    const page = await context.newPage();
    for (const other of context.pages().filter((other) => other !== page)) await other.close();
    await page.goto(url);
    await page.waitForFunction(() => window.__UI5_TECH_LENS_EVENTS__);
    const cdp = await context.newCDPSession(page);
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    const target = targets.filter((target) => target.url.startsWith("devtools://")).at(-1);
    assert.ok(target, "Native DevTools frontend is running");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    let sequence = 0; const pending = new Map();
    cdp.on("Target.receivedMessageFromTarget", (event) => {
      const message = JSON.parse(event.message), callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
    });
    const native = (method, params = {}, targetSession = sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      cdp.send("Target.sendMessageToTarget", { sessionId: targetSession, message: JSON.stringify({ id, method, params }) }).catch(reject);
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
    await native("Runtime.enable");
    // Select the real extension tab through the DevTools frontend, not a mock page.
    await evaluate(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      const manager = UI.ViewManager.ViewManager.instance();
      const view = [...manager.views.values()].find(view => view.title() === 'UI5 Code');
      if (!view) throw new Error('UI5 Code tab is missing');
      await manager.showView(view.viewId());
    })()`);
    let panelContext, panelSession;
    for (let attempt = 0; attempt < 100; attempt++) {
      const panelTarget = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.endsWith("/code-panel.html"));
      if (panelTarget) {
        if (!panelSession) panelSession = (await cdp.send("Target.attachToTarget", { targetId: panelTarget.targetId, flatten: false })).sessionId;
        const r = await native("Runtime.evaluate", { expression: 'typeof window.openLocation === "function" && document.querySelectorAll(".line").length > 0 && Boolean(document.querySelector(".file[aria-current=page]")) && document.getElementById("load-status").textContent.includes("archivos disponibles")', returnByValue: true }, panelSession);
        if (r.result.value) { panelContext = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(panelContext, "Real UI5 Code extension panel loaded");
    const panelEval = async (expression) => {
      const r = await native("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, panelSession);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    assert.match(await panelEval('document.getElementById("status").textContent'), /A\.controller\.js/, "Last inspected handler is mirrored in UI5 Code");
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/A.controller.js", "The tree marks the inspected file");
    assert.equal(await panelEval('document.querySelectorAll("select").length'), 0, "The tree replaces the header selector");
    await panelEval(`(() => {
      const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'second' && el.closest('.line').dataset.line === '5');
      if (!token) throw new Error('Method call token missing');
      token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: false }));
    })()`);
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "2", "Ordinary click does not navigate");
    await panelEval(`(() => {
      const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'second' && el.closest('.line').dataset.line === '5');
      token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    })()`);
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "6", "Ctrl+click navigates to the method definition");
    assert.equal(await panelEval('document.querySelector(".destination").textContent'), "second");
    await panelEval('document.getElementById("back").click()');
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "2", "Back restores the handler");
    await panelEval(`(() => {
      const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'second' && el.closest('.line').dataset.line === '5');
      token.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' }));
    })()`);
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "6", "Keyboard navigation reaches the same definition");
    const panelScreenshot = await native("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, "devtools-ui5-code.png"), Buffer.from(panelScreenshot.data, "base64"));
    await panelEval('document.getElementById("viewport").focus()');
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'second' && el.closest('.line').dataset.line === '5'); const range = document.createRange(); range.selectNodeContents(token); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    await native("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", modifiers: 2, windowsVirtualKeyCode: 70 });
    await native("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", modifiers: 2, windowsVirtualKeyCode: 70 });
    assert.equal(await panelEval('document.activeElement.id'), "find", "Ctrl+F focuses the custom code search");
    assert.ok(await panelEval('!document.getElementById("findbar").hidden'), "Ctrl+F opens all custom search options");
    assert.equal(await evaluate(`(() => { function visible(root) { for (const el of root.querySelectorAll('*')) { if (el.matches('input.search-replace.search') && el.getBoundingClientRect().width) return true; if (el.shadowRoot && visible(el.shadowRoot)) return true; } return false; } return visible(document); })()`), false, "Ctrl+F does not open the standard DevTools search bar");
    const count = () => panelEval('document.getElementById("find-count").textContent');
    const activeMatch = () => panelEval('[...CSS.highlights.get("ui5-find-active")].map(range => range.toString()).join("")');
    const settle = async () => { await new Promise(resolve => setTimeout(resolve, 250)); };
    const find = async (query) => {
      await panelEval('document.getElementById("find").focus(); document.getElementById("find").select()');
      await native("Input.insertText", { text: query });
      await settle();
    };
    const nextResult = async () => { await panelEval('document.getElementById("find-next").click()'); await settle(); };
    const previousResult = async () => { await panelEval('document.getElementById("find-prev").click()'); await settle(); };
    assert.equal(await panelEval('document.querySelectorAll("#editor #find").length'), 1, "The custom search has one query field");
    assert.equal(await panelEval('document.getElementById("find").value'), "second", "Ctrl+F uses the text selected in the code viewer");
    assert.equal(await count(), "1 de 2", "Searching the selected text starts immediately");
    await find("second");
    assert.equal(await count(), "1 de 2", "Code search counts occurrences in the current file");
    assert.equal(await panelEval('CSS.highlights.get("ui5-find").size'), 2, "All current-file occurrences are highlighted");
    assert.equal(await activeMatch(), "second");
    await native("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await native("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await settle();
    assert.equal(await count(), "2 de 2", "Enter in the custom search bar moves to the next result");
    await native("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 });
    await native("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 }); await settle();
    assert.equal(await count(), "1 de 2", "Shift+Enter in the custom search bar moves to the previous result");
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "5", "Search reveals the first occurrence");
    await nextResult();
    assert.equal(await count(), "2 de 2");
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "6", "Next moves to the second occurrence");
    await nextResult();
    assert.equal(await count(), "1 de 2", "Next wraps to the first result");
    await previousResult();
    assert.equal(await count(), "2 de 2", "Previous wraps to the last result");
    await find("SECOND");
    assert.equal(await count(), "1 de 2", "Search ignores case by default");
    await panelEval('document.getElementById("find-case").click()');
    assert.equal(await count(), "0 resultados", "Match-case mode respects letter case");
    await nextResult();
    assert.equal(await count(), "0 resultados", "Native next action is harmless without results");
    assert.equal(await panelEval('CSS.highlights.get("ui5-find-active").size'), 0, "No stale active highlight remains without results");
    await panelEval('document.getElementById("find-case").click()');
    await find("return this.second()");
    assert.equal(await count(), "1 de 1");
    assert.equal(await activeMatch(), "return this.second()", "Literal search spans syntax tokens and escapes regex punctuation");
    await panelEval('document.getElementById("find-all").click()');
    await find('return "other"');
    assert.equal(await count(), "1 de 2", "Global search finds matches across loaded files");
    assert.equal(await panelEval('document.querySelectorAll(".search-result").length'), 2, "Global search lists every match");
    assert.ok(await panelEval('[...document.querySelectorAll(".result-location")].every(el => el.textContent.startsWith("Línea 2 · Columna "))'), "Each result names its source line and column");
    assert.deepEqual(await panelEval('[...document.querySelectorAll(".result-file")].map(el => el.textContent)'), [url + "/A.controller.js", url + "/B.controller.js"], "Each result identifies its file");
    await nextResult();
    assert.equal(await count(), "2 de 2");
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/B.controller.js", "Next global result opens and marks its file");
    assert.equal(await activeMatch(), 'return "other"');
    assert.equal(await panelEval('document.querySelector(".search-result[aria-current=true]").dataset.index'), "1", "Next-result navigation also marks the active list row");
    await panelEval('document.querySelectorAll(".search-result")[0].click()');
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/A.controller.js", "Clicking a result opens its file");
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "1", "Clicking a result navigates to the exact line");
    assert.equal(await count(), "1 de 2");
    assert.equal(await activeMatch(), 'return "other"');
    await panelEval('document.querySelectorAll(".search-result")[1].click()');
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/B.controller.js", "Clicking another result navigates across files");
    const searchScreenshot = await native("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, "devtools-code-search.png"), Buffer.from(searchScreenshot.data, "base64"));
    await previousResult();
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/A.controller.js", "Previous global result returns to the first file");
    await find("lens-many-hit");
    assert.equal(await count(), "1 de 205");
    assert.equal(await panelEval('document.querySelectorAll(".search-result").length'), 200, "Large result lists render in manageable batches");
    await panelEval('document.getElementById("search-more").click()');
    assert.equal(await panelEval('document.querySelectorAll(".search-result").length'), 205, "Show more exposes every remaining match");
    await panelEval('document.querySelectorAll(".search-result")[204].click()');
    assert.equal(await count(), "205 de 205");
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "205", "The last listed result navigates to its exact source line");
    await nextResult();
    assert.equal(await count(), "1 de 205", "Result-list navigation wraps consistently with the search controls");
    await find("no-such-ui5-code-match");
    assert.equal(await panelEval('document.querySelectorAll(".search-result").length'), 0, "Changing to a missing query removes stale results");
    assert.ok(await panelEval('!document.getElementById("search-results").hidden'), "Global search reports an empty list for zero matches");
    await panelEval(`document.querySelector('.file[data-url=${JSON.stringify(url + "/A.controller.js")}]').click()`);
    await panelEval('document.getElementById("viewport").focus()');
    await panelEval(`(() => { const rows = document.querySelectorAll('#code .line'); const range = document.createRange(); range.setStartAfter(rows[5].querySelector('.number')); range.setEnd(rows[6], rows[6].childNodes.length); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    await native("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", modifiers: 2, windowsVirtualKeyCode: 70 });
    await native("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", modifiers: 2, windowsVirtualKeyCode: 70 }); await settle();
    assert.equal(await panelEval('document.getElementById("find").value'), sources["/A.controller.js"].split("\n").slice(5, 7).join("\n"), "Ctrl+F preserves multi-line selections and excludes line-number labels");
    assert.equal(await count(), "1 de 1", "A multi-line selected passage is searched as literal code");
    await panelEval('document.getElementById("find").focus()');
    await native("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await native("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await settle();
    assert.ok(await panelEval('document.getElementById("findbar").hidden'), "Escape closes the custom search");
    assert.ok(await panelEval('document.getElementById("search-results").hidden'), "Closing search hides the global result list");
    assert.equal(await panelEval('CSS.highlights.get("ui5-find").size'), 0, "Closing search clears highlights");
    await panelEval('document.getElementById("find-all").click()');
    await panelEval(`(() => { const folder = [...document.querySelectorAll('#files details')].find(el => el.querySelector('summary').textContent === 'modules'); folder.querySelector('summary').click(); })()`);
    assert.ok(await panelEval(`document.querySelector('.file[data-url=${JSON.stringify(url + "/modules/Nav.js")}]').closest('details').open`), "Folder expands from its disclosure");
    await panelEval(`document.querySelector('.file[data-url=${JSON.stringify(url + "/modules/Nav.js")}]').click()`);
    assert.equal(await panelEval('document.getElementById("filename").textContent'), "Nav.js", "Clicking a tree file opens its code");
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'work' && el.closest('.line').dataset.line === '1'); token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Helper.js", "Ctrl+click highlights the imported function's file in the tree");
    assert.ok(await panelEval('document.querySelector(".file[aria-current=page]").closest("details").open'), "The destination folder is expanded");
    await panelEval('document.getElementById("back").click()');
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Nav.js", "History updates the marked file");
    // The same resolver is used by mouse and keyboard, across imported bases.
    for (const [name, line, keyboard] of [["LIMIT", "4", false], ["count", "5", true]]) {
      await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === '${name}' && el.closest('.line').dataset.line === '6'); token.focus(); token.dispatchEvent(${keyboard ? "new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' })" : "new MouseEvent('click', { bubbles: true, ctrlKey: true })"}); })()`);
      assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), line, `${name} navigates to its declaration`);
      await panelEval('document.getElementById("back").click()');
      assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Nav.js");
    }
    await panelEval(`(() => { const token = [...document.querySelectorAll('.module-reference')].find(el => el.textContent.includes('./Helper.js')); token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Helper.js", "Ctrl+click on an import path opens the library code");
    await panelEval('document.getElementById("back").click()');
    for (const [name, line, keyboard] of [["Library", "0", false], ["open", "1", false], ["run", "2", true]]) {
      await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === '${name}' && el.closest('.line').dataset.line === '8'); token.focus(); token.dispatchEvent(${keyboard ? "new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' })" : "new MouseEvent('click', { bubbles: true, ctrlKey: true })"}); })()`);
      assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Library.js", `${name} opens the imported library`);
      assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), line, `${name} selects the library definition`);
      await panelEval('document.getElementById("back").click()');
    }
    await panelEval(`document.querySelector('.file[data-url=${JSON.stringify(url + "/modules/Child.js")}]').click()`);
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'inherited' && el.closest('.line').dataset.line === '2'); token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "3", "An overriding method takes precedence over the imported base");
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'inherited' && Number(el.dataset.offset) > ${sources["/modules/Child.js"].indexOf("super.")}); token.focus(); token.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' })); })()`);
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Base.js", "Ctrl+Enter on super reaches the imported base module");
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "1", "The inherited method is selected at its original line");
    await panelEval('document.getElementById("back").click()');
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Child.js", "Cross-module inheritance navigation preserves history");
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'shared' && el.closest('.line').dataset.line === '2'); token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/modules/Base.js", "Ctrl+click on this follows inherited methods across imported modules");
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "2", "The inherited implementation is selected");
    await page.evaluate(() => { window.sap.ui.require.toUrl = (id) => "/sap/bc/ui5_ui5/sap/zalta/" + id.replace("tmb/infAlta/", ""); });
    await panelEval(`document.querySelector('.file[data-url=${JSON.stringify(url + "/UI5Nav.js")}]').click()`);
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'createValueHelp'); token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await panelEval('document.querySelectorAll("#candidates button").length === 2')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await panelEval('document.querySelectorAll("#candidates button").length'), 2, "Generated libraries offer the original method and its wrapper");
    await panelEval(`(() => { const button = [...document.querySelectorAll('#candidates button')].find(el => el.textContent.startsWith('Método original')); button.click(); })()`);
    assert.equal(await panelEval('document.querySelector(".file[aria-current=page]").dataset.url'), url + "/sap/bc/ui5_ui5/sap/zalta/lib/AutoSearchHelp.js", "UI5 loader routes logical namespaces to the deployed ABAP resource");
    assert.equal(await panelEval('document.querySelector(".destination").textContent'), "createValueHelp", "Ctrl+click selects the async method without invoking it");
    await panelEval('document.getElementById("back").click()');
    await panelEval(`(() => { const token = [...document.querySelectorAll('.identifier')].find(el => el.textContent === 'createValueHelp'); token.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); })()`);
    await panelEval(`(() => { const button = [...document.querySelectorAll('#candidates button')].find(el => el.textContent.startsWith('Wrapper asignado')); button.click(); })()`);
    assert.equal(await panelEval('document.querySelector(".selected").dataset.line'), "6", "The wrapper candidate selects its exact function line");
    // Read XML over the network and from a literal preload without executing it.
    await page.evaluate(async (paths) => { for (const path of paths) await fetch(path).then((r) => r.text()); }, ["/demo/view/Main.view.xml", "/demo/fragment/Dialog.fragment.xml", "/demo/controller/Main.controller.js", "/demo/Component-preload.js"]);
    await panelEval('document.getElementById("refresh").click()');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await panelEval('[...document.querySelectorAll(".file")].some(el => el.textContent === "Bundled.fragment.xml")')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(await panelEval('[...document.querySelectorAll(".file")].some(el => el.textContent === "Bundled.fragment.xml")'), "Preloaded XML appears in the tree");
    await panelEval(`window.openLocation({url: ${JSON.stringify(url + "/demo/view/Main.view.xml")}, line: 0})`);
    assert.equal(await panelEval('document.querySelector(".xml-handler").textContent'), ".onSave", "Parameterized handler links preserve the original XML text");
    assert.equal(await panelEval('document.querySelectorAll("#code img").length'), 0, "XML markup remains inert text");
    await panelEval('document.querySelector(".xml-handler").dispatchEvent(new MouseEvent("click", {bubbles:true, ctrlKey:true}))');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await panelEval('document.getElementById("filename").textContent === "Main.controller.js"')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await panelEval('document.querySelector(".destination").textContent'), "onSave", "XML event navigates to the controller method");
    await panelEval('document.getElementById("back").click()');
    assert.equal(await panelEval('document.getElementById("filename").textContent'), "Main.view.xml", "Back restores XML and its source location");
    for (const name of ["Dialog", "Bundled"]) {
      await panelEval(`window.openLocation({url: ${JSON.stringify(url + "/demo/fragment/")} + ${JSON.stringify(name + ".fragment.xml")}, path: ${JSON.stringify("demo/fragment/" + name + ".fragment.xml")}, xmlContext: ["demo.controller.Main"], moduleUrls: {"demo/controller/Main.controller": ${JSON.stringify(url + "/demo/controller/Main.controller.js")}}})`);
      assert.equal(await panelEval('document.getElementById("filename").textContent'), name + ".fragment.xml");
      await panelEval('document.querySelector(".xml-handler").focus(); document.querySelector(".xml-handler").dispatchEvent(new KeyboardEvent("keydown", {bubbles:true, ctrlKey:true, key:"Enter"}))');
      assert.equal(await panelEval('document.querySelector(".destination").textContent'), "onSave", "Fragment event uses its explicit controller context");
      await panelEval('document.getElementById("back").click()');
      assert.equal(await panelEval('document.getElementById("filename").textContent'), name + ".fragment.xml");
    }
    // Register runtime controls whose XML has never appeared in DevTools' list.
    const lazyRequests = [];
    page.on("request", (request) => { if (request.url().includes("/lazy/")) lazyRequests.push(request.url()); });
    await page.evaluate(() => {
      const old = sap.ui.require, toUrl = old.toUrl;
      const controller = { getMetadata: () => ({ getName: () => "demo.controller.Main" }) };
      const view = { getId: () => "lazy-view", getViewName: () => "lazy.view.Runtime", getController: () => controller,
        isA: (type) => type === "sap.ui.core.mvc.View", getMetadata: () => ({ getName: () => "sap.ui.core.mvc.XMLView" }) };
      const fragment = { getId: () => "lazy-fragment", isA: () => false, getParent: () => view, _sapui_declarativeSourceInfo: { fragmentName: "lazy.fragment.Runtime" } };
      sap.ui.require = Object.assign((name, ...args) => name === "sap/ui/core/Element" ? { registry: { all: () => ({ view, fragment }) } } : old(name, ...args), old);
      sap.ui.require.toUrl = (path) => /^(?:lazy\/|demo\/controller\/)/.test(path) ? new URL("/" + path, location.href).href : toUrl(path);
    });
    await panelEval('document.getElementById("refresh").click()');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await panelEval('document.querySelectorAll(".file.xml-file").length >= 5')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(await panelEval('[...document.querySelectorAll(".file")].some(el => el.textContent === "Runtime.view.xml")'), "Runtime view appears without a DevTools XML resource");
    assert.ok(await panelEval('[...document.querySelectorAll(".file")].some(el => el.textContent === "Runtime.fragment.xml")'), "Runtime fragment appears without a DevTools XML resource");
    assert.deepEqual(lazyRequests, [], "Listing runtime XML does not fetch source");
    for (const kind of ["view", "fragment"]) {
      const path = `lazy/${kind}/Runtime.${kind}.xml`;
      await panelEval(`document.querySelector('.file[data-url=${JSON.stringify(url + "/" + path)}]').click()`);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await panelEval(`document.getElementById("filename").textContent === ${JSON.stringify("Runtime." + kind + ".xml")} && Boolean(document.querySelector(".xml-handler"))`)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await panelEval('document.getElementById("filename").textContent'), `Runtime.${kind}.xml`);
      await panelEval('document.querySelector(".xml-handler").dispatchEvent(new MouseEvent("click", {bubbles:true, ctrlKey:true}))');
      assert.equal(await panelEval('document.querySelector(".destination").textContent'), "onSave", "Runtime XML navigates using its real associated controller");
      await panelEval('document.getElementById("back").click()');
      assert.equal(await panelEval('document.getElementById("filename").textContent'), `Runtime.${kind}.xml`);
    }
    assert.equal(lazyRequests.length, 2, "Only selected XML sources are requested");
    await panelEval(`(() => { const input = document.getElementById('filter'); input.value = 'Helper.js'; input.dispatchEvent(new Event('input')); })()`);
    assert.equal(await panelEval('document.querySelectorAll(".file").length'), 1, "Filtering retains only matching leaves and their folder hierarchy");
    await panelEval('document.querySelector(".file").click()');
    assert.equal(await panelEval('document.querySelectorAll(".file[aria-current=page]").length'), 1, "Exactly one file is marked");
    assert.equal(await panelEval('document.querySelectorAll("#code img").length'), 0, "Source strings render as text, never as HTML");
    await panelEval('document.getElementById("sources").click()');
    for (let attempt = 0; attempt < 50; attempt++) { if ((await editor())?.url === url + "/modules/Helper.js") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.equal((await editor()).url, url + "/modules/Helper.js", "Open in Sources navigates to the selected resource");
    await page.reload();
    let reset = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      reset = await panelEval('document.getElementById("last").disabled && document.getElementById("back").disabled && document.querySelectorAll(".file").length >= 5 && document.querySelectorAll(".line").length > 0');
      if (reset) break; await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(reset, "Inspected-page reload clears stale handlers/history and refreshes the loaded scripts");
    console.log("PASS: real UI5 Code panel, tree, Ctrl+click, history, local/global text search, highlights, counters, wraparound, case sensitivity, keyboard shortcuts and custom Ctrl+F without the standard bar.");
    console.log("PASS: real DevTools API, correct file and cursor, same method names, identical bodies, minified columns and identical-URL iframes.");
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (profile.startsWith(path.join(os.tmpdir(), "ui5-native-tools-"))) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
