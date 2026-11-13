"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../inspector.js"), "utf8"), H = require("../core.js");

function setup(count, hidden = 0) {
  const frames = new Map(), registry = {}, boxes = [], outlines = [];
  const calls = { layout: 0, roots: 0 };
  let sequence = 0;
  function element() {
    return { style: {}, dataset: {}, isConnected: true, parentElement: null,
      append(...nodes) { this.children.push(...nodes); }, children: [],
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute() {}, attachShadow() { return element(); },
      set className(value) {
        this.kind = value;
        if (value.startsWith("box ")) boxes.push(this);
        if (value === "discovery-outline model") outlines.push(this);
      },
      getClientRects() { calls.layout++; return this.hidden ? [] : [{}]; },
      getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 50, width: 100, height: 40 }; }
    };
  }
  const document = { documentElement: element(), createElement: element, createDocumentFragment: element,
    addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
  for (let i = 0; i < count; i++) {
    const node = element(); node.hidden = i < hidden;
    registry[i] = { getId: () => `view-${i}`, isA: () => true, getViewName: () => `demo.View${i}`,
      getMetadata: () => ({ getName: () => "sap.ui.core.mvc.XMLView" }),
      getDomRef: () => { calls.roots++; return node; } };
  }
  function Fragment() {}
  Fragment.load = () => Promise.resolve(registry[0]);
  const context = { document, WeakRef, location: { href: "https://app.test/" }, innerWidth: 1280, innerHeight: 900,
    performance: { now: () => 1000 },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", position: "static", transform: "none", perspective: "none", filter: "none", contain: "none" }),
    addEventListener() {}, removeEventListener() {}, postMessage() {},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { observe() {} disconnect() {} },
    __UI5_TECH_LENS_CORE__: H, __UI5_TECH_LENS_DATA__: { applications: () => [],
      inspect: () => ({ models: [{ name: "", label: "Default", type: "sap.ui.model.json.JSONModel" }], bindings: [] }) },
    sap: { ui: { require: (name) => name === "sap/ui/core/Fragment" ? Fragment : name === "sap/ui/core/Element" ? { registry: { all: () => registry } } : null } }
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { api: context.__UI5_TECH_LENS__, Fragment, registry, frames, calls, boxes, outlines,
    draw() { const [id, fn] = frames.entries().next().value; frames.delete(id); calls.layout = calls.roots = 0; fn(); } };
}

test("drawing stops layout and root traversal at 300 visible regions while inventory remains complete", () => {
  const h = setup(1000);
  h.api.setOptions({ enabled: true }); h.draw();
  assert.equal(h.boxes.length, 300);
  assert.equal(h.calls.layout, 300);
  // At most the next entry is resolved before the drawing budget is checked.
  assert.ok(h.calls.roots <= 301);
  assert.equal(h.api.snapshot().entries.length, 1000);
});

test("invisible controls do not consume the visible-region budget", () => {
  const h = setup(1000, 200);
  h.api.setOptions({ enabled: true }); h.draw();
  assert.equal(h.boxes.length, 300);
  assert.equal(h.calls.layout, 500);
  assert.equal(h.boxes[0].children[0].textContent, "V · demo/View200.view.xml");
});

test("Ctrl discovery stops visibility checks after 300 visible data targets", () => {
  const h = setup(1000);
  h.api.setOptions({ enabled: true, views: false, fragments: false, models: true });
  h.api.highlightTargets(true); h.draw();
  assert.equal(h.outlines.length, 300);
  assert.equal(h.calls.layout, 300);
});

test("collecting declarative fragments does not queue a redundant frame but live capture still does", async () => {
  const h = setup(1);
  h.registry[0]._sapui_declarativeSourceInfo = { fragmentName: "demo.Fragment" };
  h.api.setOptions({ enabled: true }); h.draw();
  assert.equal(h.frames.size, 0, "A scan must not schedule its own follow-up draw");
  assert.ok(h.api.snapshot().entries.some((entry) => entry.name === "demo.Fragment"));
  assert.equal(h.frames.size, 0, "Reading inventory must not trigger rendering");
  await h.Fragment.load({ name: "demo.NewFragment" });
  assert.equal(h.frames.size, 1, "A fragment created outside the scan still schedules rendering");
});
