"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../data-inspector.js"), "utf8");
const { jsonLines } = require("../core.js");
function setup(type = "sap.ui.model.json.JSONModel", name = "") {
  const scope = { URL, location: { href: "https://demo.example/" } }; scope.window = scope;
  vm.runInNewContext(source, scope);
  const model = { getMetadata: () => ({ getName: () => type }), resolve: (path, context) => path.startsWith("/") ? path : context ? `${context.getPath()}/${path}` : undefined };
  const binding = { getModel: () => model, getPath: () => "/value", getContext: () => null };
  const control = { getMetadata: () => ({ getAllProperties: () => ({ value: {} }) }),
    getBindingInfo: () => ({ path: "/value", model: name }), getBinding: () => binding, getModel: () => model };
  const D = scope.__UI5_TECH_LENS_DATA__;
  return { D, model, binding, control, descriptor: () => D.inspect(control).bindings[0] };
}
test("hover metadata never reads values; explicit clicks serialize false/null and the JSON model", () => {
  const f = setup(); let reads = 0;
  f.model.getProperty = () => { reads++; return false; };
  f.model.getData = () => { reads++; return { value: false, empty: null }; };
  const descriptor = f.descriptor();
  assert.equal(reads, 0);
  const result = f.D.readBinding(f.control, descriptor);
  assert.equal(result.value, "false");
  assert.equal(JSON.stringify(result.focusPath), '["value"]');
  assert.deepEqual(JSON.parse(result.data), { value: false, empty: null });
  assert.equal(reads, 2);
});
test("V2 reads only cached properties; V4 reads the existing context and value", () => {
  for (const version of ["v2", "v4"]) {
    const f = setup(`sap.ui.model.odata.${version}.ODataModel`, "sales");
    const context = { getPath: () => "/Orders('1')", getObject: () => ({ Name: "Cached" }) };
    f.binding.getPath = () => "Name"; f.binding.getContext = () => context;
    f.control.getBindingInfo = () => ({ path: "Name", model: "sales" });
    f.model.getProperty = (path) => {
      assert.equal(version, "v2", "V4 never calls unsupported Model.getProperty");
      return path === "/" ? { Orders: { Name: "Cached" } } : "Cached";
    };
    f.binding.getValue = () => "Cached";
    for (const method of ["read", "refresh", "requestObject", "requestProperty", "bindContext", "bindProperty"]) {
      f.model[method] = context[method] = () => assert.fail(`${method} must not run`);
    }
    const result = f.D.readBinding(f.control, f.descriptor());
    assert.equal(JSON.parse(result.value), "Cached");
    assert.ok(result.data.includes("Cached"));
    assert.equal(JSON.stringify(result.focusPath), version === "v4" ? '["Name"]' : '["Orders(\'1\')","Name"]');
  }
});
test("composite parts use their own model, including the default model", () => {
  const f = setup(), named = setup("sap.ui.model.json.JSONModel", "ui");
  f.model.getProperty = () => "Default"; f.model.getData = () => ({ value: "Default" });
  named.model.getProperty = () => true; named.model.getData = () => ({ editable: true });
  const parts = [f.binding, named.binding];
  f.control.getBindingInfo = () => ({ parts: [{ path: "/value" }, { path: "/value", model: "ui" }] });
  f.control.getBinding = () => ({ getBindings: () => parts });
  const descriptors = f.D.inspect(f.control).bindings;
  assert.equal(JSON.parse(f.D.readBinding(f.control, descriptors[0]).value), "Default");
  assert.equal(JSON.parse(f.D.readBinding(f.control, descriptors[1]).value), true);
});
test("stale, destroyed and unresolved bindings don't read an unrelated value", () => {
  const f = setup();
  f.model.getProperty = f.model.getData = () => assert.fail("Must not read stale data");
  const descriptor = f.descriptor();
  f.control.getBindingInfo = () => null;
  assert.match(f.D.readBinding(f.control, descriptor).status, /ha cambiado/);
  f.control.isDestroyed = () => true;
  assert.match(f.D.readBinding(f.control, descriptor).status, /ha cambiado/);
  const unresolved = setup();
  unresolved.control.getBindingInfo = () => ({ path: "value" }); unresolved.binding.getPath = () => "value";
  unresolved.model.getProperty = () => assert.fail("No context means no property lookup");
  unresolved.model.getData = () => ({});
  assert.match(unresolved.D.readBinding(unresolved.control, unresolved.descriptor()).value, /No disponible/);
  assert.equal(unresolved.D.readBinding(unresolved.control, unresolved.descriptor()).focusPath, null);
});
test("snapshots bound huge/circular data and never invoke business getters or toJSON", () => {
  const f = setup(), data = { text: "x".repeat(200000), items: Array(10000).fill("item") };
  data.self = data;
  Object.defineProperty(data, "getter", { enumerable: true, get: () => assert.fail("Getter executed") });
  data.toJSON = () => assert.fail("toJSON executed");
  f.model.getProperty = () => undefined; f.model.getData = () => data;
  const result = f.D.readBinding(f.control, f.descriptor());
  assert.match(result.value, /No disponible/);
  assert.match(result.data, /Texto recortado/);
  assert.match(result.data, /Límite de tamaño/);
  assert.match(result.data, /Referencia circular/);
  assert.match(result.data, /Accessor no leído/);
  assert.ok(result.data.length < 100000);
});
test("dates preserve their value without calling custom serialization", () => {
  const f = setup(), date = new Date("2026-11-03T10:00:00Z");
  date.toJSON = () => assert.fail("Custom date serializer executed");
  f.model.getProperty = () => date; f.model.getData = () => ({ date, zero: 0, empty: "" });
  const result = f.D.readBinding(f.control, f.descriptor());
  assert.equal(JSON.parse(result.value), "2026-11-03T10:00:00.000Z");
  assert.deepEqual(JSON.parse(result.data), { date: "2026-11-03T10:00:00.000Z", zero: 0, empty: "" });
});
test("JSON locations distinguish identical values and keys by their full path, including array indexes", () => {
  const data = { first: { value: "same" }, items: [{ value: "same" }, { value: "same" }], 'a"b': null };
  const result = jsonLines(JSON.stringify(data), ["items", "1", "value"]);
  assert.equal(result.targetLine, 10);
  assert.equal(result.lines[result.targetLine - 1].trim(), '"value": "same"');
  assert.deepEqual(JSON.parse(result.lines.join("\n")), data);
  assert.equal(jsonLines(JSON.stringify(data), ['a"b']).targetLine, 13);
  assert.equal(jsonLines(JSON.stringify(data), ["missing", "value"]).targetLine, null);
});
test("JSON roots, empty collections, missing paths and literal markup are represented without guessing", () => {
  for (const value of [false, 0, null, "", {}, []]) {
    const result = jsonLines(JSON.stringify(value), []);
    assert.equal(result.targetLine, 1);
    assert.deepEqual(JSON.parse(result.lines.join("\n")), value);
  }
  assert.equal(jsonLines('{"branch":"[Límite de tamaño]"}', ["branch", "child"]).targetLine, null);
  assert.equal(jsonLines('"[No disponible en memoria]"').targetLine, null);
  assert.equal(jsonLines("invalid json", ["value"]).targetLine, null);
  const markup = { '<img onerror="alert(1)">': "<script>alert(1)</script>" };
  assert.deepEqual(JSON.parse(jsonLines(JSON.stringify(markup)).lines.join("\n")), markup);
});
test("unloaded V4 data cannot mark the root placeholder as the requested value", () => {
  const f = setup("sap.ui.model.odata.v4.ODataModel");
  f.binding.getContext = () => ({ getPath: () => "/value", getObject: () => undefined });
  assert.equal(f.D.readBinding(f.control, f.descriptor()).focusPath, null);
});
test("fold ranges preserve nested object/array boundaries and the original target line", () => {
  const result = jsonLines(JSON.stringify({ items: [{ value: "[not a node]" }, {}], text: "{}", empty: [] }), ["items", "0", "value"]);
  assert.equal(result.targetLine, 4);
  assert.deepEqual(result.nodes, [
    { startLine: 1, endLine: 10, path: [], size: 3, array: false },
    { startLine: 2, endLine: 7, path: ["items"], size: 2, array: true },
    { startLine: 3, endLine: 5, path: ["items", "0"], size: 1, array: false }
  ]);
  assert.deepEqual(jsonLines("null").nodes, []);
  assert.deepEqual(jsonLines("{}").nodes, []);
  assert.deepEqual(jsonLines("invalid").nodes, []);
});
