"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../data-inspector.js"), "utf8");
function apps({ declared, base, loader, href = "https://demo.example/flp/", broken = false } = {}) {
  const component = (id) => ({ getMetadata: () => ({ getComponentName: () => id }),
    getManifestEntry: (key) => key === "sap.app" ? { id, type: "application", title: id } : key === "sap.platform.abap" ? { uri: declared } : {},
    getManifestObject: () => { if (broken) throw new Error("Old UI5"); return { resolveUri: () => base }; } });
  const C = { registry: { all: () => ({ app: component("tmb.infAlta"), shell: component("sap.ushell") }) } };
  const require = (name) => name === "sap/ui/core/Component" ? C : null;
  require.toUrl = () => loader;
  const scope = { URL, location: { href }, sap: { ui: { require } } }; scope.window = scope;
  vm.runInNewContext(source, scope);
  return scope.__UI5_TECH_LENS_DATA__.applications([], () => false);
}
test("BSP service comes from ABAP manifest independently of the UI5 app ID", () => {
  const app = apps({ declared: "/sap/bc/ui5_ui5/sap/zinfbusalta/", base: "/sap/bc/ui5_ui5/sap/other/" })[0];
  assert.equal(app.id, "tmb.infAlta");
  assert.equal(app.bsp.name, "ZINFBUSALTA");
  assert.equal(app.bsp.path, "/sap/bc/ui5_ui5/sap/zinfbusalta");
  assert.equal(app.bsp.source, "sap.platform.abap/uri");
});
test("component URLs identify the deployed app behind a Fiori shell and cachebuster", () => {
  for (const prefix of ["ui5_ui5", "bsp"]) {
    const app = apps({ base: `https://user:secret@demo.example/sap/bc/${prefix}/sap/zinfbusalta/~123~/webapp/?token=secret#value` })[0];
    assert.equal(app.bsp.name, "ZINFBUSALTA");
    assert.equal(app.bsp.path, `/sap/bc/${prefix}/sap/zinfbusalta`);
    assert.ok(!JSON.stringify(app).includes("secret"));
  }
});
test("loader fallback works without manifest APIs and preserves custom ABAP namespaces", () => {
  const app = apps({ broken: true, loader: "/sap/bc/ui5_ui5/acme/alta/Component.js" })[0];
  assert.equal(app.bsp.name, "/ACME/ALTA");
  assert.equal(app.bsp.source, "Cargador UI5");
});
test("missing, invalid and OData URLs do not invent a BSP from the namespace or shell URL", () => {
  for (const declared of [null, {}, "javascript:/sap/bc/ui5_ui5/sap/evil", "/sap/opu/odata/sap/ZALTA_SRV/", "/?next=/sap/bc/ui5_ui5/sap/fake", "/sap/bc/ui5_ui5/sap/%2Ffake/"]) {
    assert.equal(apps({ declared, href: "https://demo.example/sap/bc/ui5_ui5/sap/shell/" })[0].bsp, null);
  }
});
test("Web IDE project is separate from an unconfirmed BSP and belongs only to the matching app", () => {
  const href = "https://demo.example/test-resources/sap/ushell/shells/sandbox/fioriSandbox.html?hc_orionpath=%2FDI_workspace%2Fzinfbusalta%2Fwebapp&sap-ushell-test-url-additionalInformation=SAPUI5.Component%3Dtmb.infAlta";
  const result = apps({ href });
  assert.equal(result[0].bsp, null);
  assert.equal(result[0].project, "zinfbusalta");
  assert.equal(result[1].project, "");
  assert.equal(apps({ href: href.replace("tmb.infAlta", "other.app") })[0].project, "");
});
