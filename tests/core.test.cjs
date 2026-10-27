"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const H = require("../core.js");
const vm = require("node:vm");
function dataInspector(Component) {
  const context = { URL, location: { href: "https://demo.example/app/" }, sap: { ui: { require: (name) => name === "sap/ui/core/Component" ? Component : null } } };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../data-inspector.js"), "utf8"), context);
  return context.__UI5_TECH_LENS_DATA__;
}
test("app title is found without views, resolves i18n and ranks above Fiori shell", () => {
  const resourceModel = { getMetadata: () => ({ getName: () => "sap.ui.model.resource.ResourceModel" }), getResourceBundle: () => ({ getText: () => "Gestión de pedidos" }) };
  const component = { getMetadata: () => ({ getComponentName: () => "my.orders" }), oModels: { i18n: resourceModel }, getModel: () => resourceModel,
    getManifestEntry: (key) => key === "sap.app" ? { id: "my.orders", type: "application", title: "{{appTitle}}" } : {} };
  const shell = { getMetadata: () => ({ getComponentName: () => "sap.ushell" }), getManifestEntry: () => ({ id: "sap.ushell", type: "application", title: "Launchpad" }) };
  const D = dataInspector({ registry: { all: () => ({ shell, component }) } });
  const apps = D.applications([], () => false);
  assert.equal(apps[0].id, "my.orders");
  assert.equal(apps[0].title, "Gestión de pedidos");
  assert.equal(apps[0].titleResolved, true);
});
test("OData runtime inspection strips URL credentials/query and excludes uninstantiated models", () => {
  const model = { getMetadata: () => ({ getName: () => "sap.ui.model.odata.v4.ODataModel" }),
    getServiceUrl: () => "https://user:secret@demo.example/odata/?token=secret#debug", resolve: () => undefined };
  const component = { getManifestEntry: (key) => key === "/sap.ui5/models" ? { sales: {}, ghost: {} } : {} };
  const field = { oModels: { sales: model }, owner: component, getModel: (name) => name === "sales" ? model : null,
    getMetadata: () => ({ getAllProperties: () => ({ value: {} }), getAllAggregations: () => ({}) }),
    getBindingInfo: () => ({ path: "Name", model: "sales" }), getBinding: () => null, getBindingContext: () => null };
  const D = dataInspector({ getOwnerComponentFor: (control) => control.owner });
  const result = D.inspect(field, true);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].service, "https://demo.example/odata/");
  assert.equal(result.models[0].version, "V4");
  assert.equal(result.bindings[0].path, "Name");
  assert.equal(result.bindings[0].resolved, "");
});
test("technical resource names: XML, JS modules, explicit suffix, namespaces", () => {
  assert.equal(H.path("my.app.view.Main", "view"), "my/app/view/Main.view.xml");
  assert.equal(H.path("my.app.Dialog", "fragment"), "my/app/Dialog.fragment.xml");
  assert.equal(H.path("my.app.Dialog.fragment.xml", "fragment"), "my/app/Dialog.fragment.xml");
  assert.equal(H.path("module:my/app/MyFragment", "fragment", "JS"), "my/app/MyFragment.js");
  assert.equal(H.path("module:my/app/View.js", "view", "JS"), "my/app/View.js");
  assert.equal(H.path("my.app.Legacy", "view", "JSON"), "my/app/Legacy.view.json");
  assert.equal(H.path(null, "view"), "Origen sin nombre");
});
test("only boolean, known options cross the page bridge", () => {
  assert.deepEqual(H.options({ enabled: true, views: "false", fragments: false, extra: true }), { enabled: true, views: true, fragments: false, models: false, odatas: false, compact: false });
  assert.deepEqual(H.options(), H.defaults);
});
test("viewport and overflow clipping exclude offscreen boxes", () => {
  const viewport = { left: 0, top: 0, right: 100, bottom: 80 };
  assert.deepEqual(H.intersect({ left: -20, top: 10, right: 50, bottom: 120 }, viewport), { left: 0, top: 10, right: 50, bottom: 80, width: 50, height: 70 });
  assert.equal(H.intersect({ left: 100, top: 0, right: 120, bottom: 20 }, viewport), null);
});
test("extension manifest references packaged scripts and icon assets", () => {
  const root = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  assert.equal(manifest.manifest_version, 3);
  const resources = [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((s) => s.js)];
  for (const file of resources) assert.ok(fs.existsSync(path.join(root, file)), file);
  assert.ok(manifest.content_scripts.some((script) => script.world === "MAIN" && script.run_at === "document_start" && script.all_frames));
});
