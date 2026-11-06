"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), N = require("../code-navigation.js");
const url = "https://app.test/controller/Main.controller.js";
function resolve(content, marker, extras = []) { return N.create([{ url, content }, ...extras]).resolve(url, content.indexOf(marker)); }

test("generated module registries follow IIFE exports and distinguish original methods from wrappers", () => {
  const content = 'sap.ui.define(["tmb/infAlta/lib/AutoSearchHelp"], function (AutoSearchHelp) { var oHelp = AutoSearchHelp.createValueHelp(this, oEvent, args); });';
  const library = { url: 'https://app.test/tmb/infAlta/lib/AutoSearchHelp.js', content: `sap.ui.define([], function () {
    var modules = Object.create(null);
    modules["Other"] = (function () { return { createValueHelp: function () {} }; })();
    modules["AutoSearchHelp"] = (function (Other) {
      var oSHMain = { createValueHelp: async function (that, oEvent, args) {}, suggest: function () {} };
      ["createValueHelp", "suggest"].forEach(function (name) {
        var initialize = oSHMain[name];
        oSHMain[name] = function (that, event, options) { return initialize.call(this, that, event, options); };
      });
      return oSHMain;
    })(modules["Other"]);
    return modules.AutoSearchHelp;
  });` };
  const result = resolve(content, 'createValueHelp(', [library]);
  assert.equal(result.locations?.length, 2, JSON.stringify(result));
  const original = result.locations.find((l) => l.label === 'Método original');
  const wrapper = result.locations.find((l) => l.label === 'Wrapper asignado');
  assert.equal(original.offset, library.content.indexOf('createValueHelp: async'));
  assert.equal(wrapper.offset, library.content.indexOf('function (that, event, options)'));
  assert.equal(original.url, library.url);
  assert.equal(wrapper.url, library.url);
});

test("inline factory arguments resolve without evaluating arbitrary or conditional factories", () => {
  const content = 'const api = (function (source) { return source; })({ work() {} }); api.work();';
  assert.equal(resolve(content, 'work();').locations?.[0].offset, content.indexOf('work() {}'));
  for (const source of [
    'const api = build(); api.work();',
    'const api = (function () { if (condition) return { work() {} }; return other; })(); api.work();',
    'const api = (async function () { return { work() {} }; })(); api.work();',
    'const api = (function (Object) { return Object.create(null); })(custom); api.work();'
  ]) assert.ok(resolve(source, 'work();').error, source);
});
test("AutoSearchHelp async methods resolve with the UI5 resource root instead of the logical namespace", () => {
  const content = 'sap.ui.define(["tmb/infAlta/lib/AutoSearchHelp"], function (AutoSearchHelp) { AutoSearchHelp.createValueHelp(); });';
  const library = { url: 'https://app.test/sap/bc/ui5_ui5/sap/zalta/~cache~/lib/AutoSearchHelp-dbg.js', content: 'sap.ui.define([], function () { return { createValueHelp: async function (that, oEvent, args) {} }; });' };
  const nav = N.create([{ url, content }, library], { moduleUrls: { 'tmb/infAlta/lib/AutoSearchHelp': library.url.replace('-dbg.js', '.js') } });
  assert.deepEqual(nav.moduleNames(url), ['tmb/infAlta/lib/AutoSearchHelp']);
  for (const marker of ['AutoSearchHelp.createValueHelp', 'createValueHelp();', 'tmb/infAlta/lib/AutoSearchHelp']) {
    const result = nav.resolve(url, content.indexOf(marker));
    assert.equal(result.locations?.[0].url, library.url, JSON.stringify(result));
  }
  assert.equal(nav.resolve(url, content.indexOf('createValueHelp();')).locations[0].offset, library.content.indexOf('createValueHelp:'));
  const unrelated = { url: 'https://other.test/lib/AutoSearchHelp.js', content: library.content };
  assert.ok(N.create([{ url, content }, unrelated], { moduleUrls: { 'tmb/infAlta/lib/AutoSearchHelp': library.url } }).resolve(url, content.indexOf('createValueHelp();')).error);
});

test("assigning an imported async method result still selects the method's exact position", () => {
  const content = `sap.ui.define(["tmb/infAlta/lib/AutoSearchHelp"], function (AutoSearchHelp) {
    var oHelp = AutoSearchHelp.createValueHelp(
      this, oEvent, args
    );
  });`;
  const libraryUrl = 'https://app.test/sap/bc/ui5_ui5/sap/zalta/lib/AutoSearchHelp.js';
  for (const exported of [
    'return { createValueHelp: async function (that, oEvent, args) {} };',
    'var AutoSearchHelp = { createValueHelp: async function (that, oEvent, args) {} }; return AutoSearchHelp;',
    'return BaseObject.extend("tmb.infAlta.lib.AutoSearchHelp", { createValueHelp: async function (that, oEvent, args) {} });'
  ]) {
    const library = { url: libraryUrl, content: 'sap.ui.define([], function () {\n' + exported + '\n});' };
    const nav = N.create([{ url, content }, library], { moduleUrls: { 'tmb/infAlta/lib/AutoSearchHelp': libraryUrl } });
    const result = nav.resolve(url, content.indexOf('createValueHelp('));
    assert.equal(result.locations?.length, 1, JSON.stringify(result));
    assert.equal(result.locations[0].offset, library.content.indexOf('createValueHelp:'));
    assert.equal(result.locations[0].line, 1);
    assert.equal(result.locations[0].column, exported.indexOf('createValueHelp:'));
  }
});

test("anonymous UI5 modules inside require.preload retain their module IDs and relative dependencies", () => {
  const content = 'sap.ui.define(["tmb/infAlta/lib/AutoSearchHelp"], function (AutoSearchHelp) { AutoSearchHelp.createValueHelp(); });';
  const bundle = { url: 'https://app.test/Component-preload.js', content: `sap.ui.require.preload({
    "tmb/infAlta/lib/AutoSearchHelp.js": function () { sap.ui.define(["./Helper"], function (Helper) { return { createValueHelp: async function (that, oEvent, args) { Helper.run(); } }; }); },
    "tmb/infAlta/lib/Helper.js": function () { sap.ui.define([], function () { return { run: function () {} }; }); },
    "other/AutoSearchHelp.js": function () { sap.ui.define([], function () { return { createValueHelp: function () {} }; }); }
  });` };
  const result = resolve(content, 'createValueHelp();', [bundle]);
  assert.equal(result.locations?.length, 1, JSON.stringify(result));
  assert.equal(result.locations[0].offset, bundle.content.indexOf('createValueHelp:'));
  const nav = N.create([bundle]);
  assert.equal(nav.resolve(bundle.url, bundle.content.indexOf('run();')).locations?.[0].offset, bundle.content.indexOf('run:'));
});
test("UI5 library aliases, assigned static APIs and prototype methods navigate across CDN modules", () => {
  const library = { url: "https://cdn.test/resources/sap/m/MessageBox-dbg.js", content: `sap.ui.define([], function () {
    var MessageBox = {}; MessageBox.alert = function (text) {}; return MessageBox;
  });` };
  const control = { url: "https://cdn.test/resources/sap/m/Input.js", content: `sap.ui.define([], function () {
    function Input() {} Input.prototype.setValue = function (value) {}; return Input;
  });` };
  const content = `sap.ui.define(["sap/m/MessageBox", "sap/m/Input"], function (Box, Input) {
    Box.alert("Hello"); const field = new Input(); field.setValue("value"); Input.prototype.setValue.call(field);
  });`;
  assert.equal(resolve(content, 'Box.alert', [library]).locations?.[0].offset, library.content.indexOf('MessageBox ='));
  assert.equal(resolve(content, 'alert("Hello")', [library]).locations?.[0].offset, library.content.indexOf('alert ='));
  for (const marker of ['setValue("value")', 'setValue.call']) {
    const result = resolve(content, marker, [control]);
    assert.equal(result.locations?.[0].url, control.url, JSON.stringify(result));
    assert.equal(result.locations[0].offset, control.content.indexOf('setValue ='));
  }
});

test("UI5 require callbacks resolve imported libraries without being indexed as exports", () => {
  const library = { url: "https://cdn.test/resources/sap/m/MessageToast.js", content: 'sap.ui.define([], () => ({ show() {} }));' };
  const content = 'sap.ui.require(["sap/m/MessageToast"], function (Toast) { Toast.show("Hello"); });';
  assert.equal(resolve(content, 'show("Hello")', [library]).locations?.[0].url, library.url);
  assert.equal(resolve(content, 'Toast.show', [library]).locations?.[0].url, library.url);
});

test("module path links open ES modules and the correct factory inside a preload", () => {
  const content = 'sap.ui.define(["app/lib/Tools"], function (Tools) { Tools.work(); });';
  const bundle = { url: "https://cdn.test/Component-preload.js", content: 'sap.ui.predefine("other", [], function () {}); sap.ui.predefine("app/lib/Tools", [], function () { const Tools = {}; return Tools; });' };
  const nav = N.create([{ url, content }, bundle]);
  assert.deepEqual(nav.moduleOffsets(url), [content.indexOf('"app/lib/Tools"')]);
  const target = nav.resolve(url, content.indexOf('app/lib/Tools'));
  assert.equal(target.locations?.[0].url, bundle.url);
  assert.equal(target.locations[0].offset, bundle.content.lastIndexOf('function ()'));
  const es = { url: 'https://cdn.test/lib.js', content: 'export function work() {}' };
  for (const statement of ['import { work } from "https://cdn.test/lib.js"; work();', 'export * from "https://cdn.test/lib.js";']) {
    assert.equal(resolve(statement, 'https://cdn.test/lib.js', [es]).locations?.[0].offset, 0);
    if (statement.startsWith('import')) assert.equal(resolve(statement, 'work();', [es]).locations?.[0].url, es.url);
  }
  assert.ok(resolve('const text = "app/lib/Tools";', 'app/lib/Tools', [bundle]).error);
  assert.ok(resolve(content, 'app/lib/Tools').error);
});

test("variables and constants navigate to declarations independently of their values", () => {
  const content = `const LIMIT = 10; let count; var result = fetchValue();
    count = 2; count++; function run(input) { return [LIMIT, count, result, input]; }`;
  for (const name of ["LIMIT", "count", "result", "input"]) {
    const location = N.create([{ url, content }]).resolve(url, content.lastIndexOf(name)).locations?.[0];
    assert.equal(location?.offset, content.indexOf(name), name);
  }
});

test("shadowed bindings, loop scopes, catch parameters and destructuring keep their own declarations", () => {
  const content = `let value = 1;
    { const value = 2; consume(value); } consume(value);
    for (let value of items) { use(value); } after(value);
    try {} catch ({ message: detail }) { log(detail); }
    const { nested: { item }, ...rest } = source; const [first, , ...remaining] = list;
    consume(item, rest, first, remaining);`;
  for (const [marker, declaration] of [
    ["value); }", "value = 2"], ["value);\n", "value = 1"],
    ["value); } after", "value of"], ["value);\n    try", "value = 1"],
    ["detail);", "detail }"], ["item, rest", "item }"], ["rest, first", "rest }"],
    ["first, remaining", "first,"], ["remaining);", "remaining]"]
  ]) assert.equal(resolve(content, marker).locations?.[0].offset, content.indexOf(declaration), marker);
});

test("constant properties and class fields navigate to their keys", () => {
  const content = `const options = { LIMIT: 10, empty: null }; options.LIMIT; options.empty;
    class Config { limit = 10; run() { return this.limit; } }`;
  for (const [marker, declaration] of [["LIMIT;", "LIMIT:"], ["empty;", "empty:"], ["limit;", "limit ="]])
    assert.equal(resolve(content, marker).locations?.[0].offset, content.indexOf(declaration));
});

test("imported constants resolve declarations through reexports and namespaces", () => {
  const constants = { url: "https://app.test/util/constants.js", content: "export const LIMIT = 10; export let count; export const { status } = source;" };
  const barrel = { url: "https://app.test/util/index.js", content: 'export { LIMIT as MAX } from "./constants.js"; export * from "./constants.js";' };
  const content = 'import { MAX, count, status } from "../util/index.js"; import * as C from "../util/index.js"; consume(MAX, count, status, C.LIMIT);';
  for (const [name, original] of [["MAX", "LIMIT"], ["count", "count"], ["status", "status"], ["LIMIT", "LIMIT"]]) {
    const result = N.create([{ url, content }, constants, barrel]).resolve(url, content.lastIndexOf(name));
    assert.equal(result.locations?.[0].url, constants.url, JSON.stringify(result));
    assert.equal(result.locations[0].offset, constants.content.indexOf(original));
  }
});
test("UI5 this methods, arrow callbacks and aliases resolve to the same object", () => {
  const content = `sap.ui.define([], function () { return Controller.extend("Main", {
    onPress() { this.helper(); const that = this; that.helper(); return () => this.helper(); },
    helper() { return 1; }
  }); });`;
  const nav = N.create([{ url, content }]);
  for (const match of content.matchAll(/helper\(\)/g)) {
    if (match.index === content.lastIndexOf("helper()")) continue;
    const result = nav.resolve(url, match.index);
    assert.equal(result.locations?.length, 1, JSON.stringify(result));
    assert.equal(result.locations[0].offset, content.lastIndexOf("helper()"));
  }
});
test("lexical scope, hoisting, parameters and nested regular this are respected", () => {
  const content = `function helper() {} const c = { helper() {}, run(helper) {
    helper(); function inner() { this.helper(); } this.helper();
  } }; function run() { local(); function local() {} }`;
  assert.equal(resolve(content, "helper();").locations[0].offset, content.indexOf("helper)"), "parameter shadows outer function");
  assert.ok(resolve(content, "helper(); } this").error, "regular nested function has unknown this");
  assert.equal(resolve(content, "local();").locations[0].offset, content.indexOf("local() {}"));
  assert.equal(resolve(content, "helper();\n").locations[0].offset, content.indexOf("helper() {},"));
});
test("comments, strings, unknown receivers and dynamic properties never guess by name", () => {
  const content = `function helper() {} // helper()
    const text = "helper()"; unknown.helper(); const c = { helper() {}, run(name) { this[name](); } };`;
  for (const marker of ["helper()\n", "helper()\"", "helper();"]) assert.ok(resolve(content, marker).error, marker);
  assert.equal(resolve(content, "name]();").locations[0].offset, content.indexOf("name)"));
});
test("UI5 dependencies navigate to loaded default exports, including inheritance", () => {
  const content = `sap.ui.define(["./Base", "../util/Helper"], function (Base, Helper) { return Base.extend("Main", {
    run() { Helper.work(); this.inherited(); }
  }); });`;
  const extras = [{ url: "https://app.test/util/Helper-dbg.js?v=1", content: `sap.ui.define([], function () { return { work() {} }; });` },
    { url: "https://app.test/controller/Base.js", content: `sap.ui.define([], function () { return Controller.extend("Base", { inherited() {} }); });` }];
  assert.equal(resolve(content, "work();", extras).locations[0].url, extras[0].url);
  assert.equal(resolve(content, "inherited();", extras).locations[0].url, extras[1].url);
});
test("ES imports, class inheritance and object functions", () => {
  const content = `import { work } from "../util/Helper.js"; class Base { helper() {} } class Main extends Base { run() { this.helper(); work(); } } const obj = { next: function () {} }; obj.next();`;
  assert.equal(resolve(content, "helper();").locations[0].offset, content.indexOf("helper() {}"));
  assert.equal(resolve(content, "next();").locations[0].offset, content.indexOf("next: function") );
  const extras = [{ url: "https://app.test/util/Helper.js", content: "export function work() {}" }];
  assert.equal(resolve(content, "work();", extras).locations[0].url, extras[0].url);
});
test("duplicate modules yield candidates; missing or invalid scripts report a reason", () => {
  const content = `sap.ui.define(["util/Helper"], function (Helper) { Helper.work(); });`;
  const extras = ["a", "b"].map((folder) => ({ url: `https://app.test/${folder}/util/Helper.js`, content: `sap.ui.define([], function () { return { work() {} }; });` }));
  assert.equal(resolve(content, "work();", extras).locations.length, 2);
  assert.ok(resolve(content, "work();").error);
  assert.ok(N.create([{ url, content: "function (" }]).resolve(url, 0).error);
});
test("bundled named UI5 modules and minified source positions", () => {
  const content = `sap.ui.define(["util/Helper"],function(H){H.work()});`;
  const bundled = { url: "https://app.test/Component-preload.js", content: `sap.ui.predefine("util/Helper",[],function(){return {work(){return 1}}});` };
  const result = resolve(content, "work()", [bundled]).locations[0];
  assert.equal(result.column, bundled.content.indexOf("work()")); assert.equal(result.line, 0);
});
test("namespace imports resolve functions and dynamic overrides do not choose old targets", () => {
  const content = `import * as Helper from "../util/Helper.js"; Helper.work();`;
  assert.equal(resolve(content, "work();", [{ url: "https://app.test/util/Helper.js", content: "export function work() {}" }]).locations.length, 1);
  assert.equal(resolve(`let fn = () => 1; fn = other; fn();`, "fn();").locations[0].offset, 4);
  assert.ok(resolve(`const c = { work() {}, ...other, run() { this.work(); } };`, "work();").error);
});
test("absolute UI5 module IDs also match scripts loaded from a CDN", () => {
  const content = `sap.ui.define(["util/Helper"], function (Helper) { Helper.work(); });`;
  const extra = { url: "https://cdn.test/resources/util/Helper-dbg.js", content: "sap.ui.define([], function () { return { work() {} }; });" };
  assert.equal(resolve(content, "work();", [extra]).locations[0].url, extra.url);
});

test("imported object and namespace identifiers navigate to their module", () => {
  const extra = { url: "https://app.test/util/Helper.js", content: "export default { work() {} };" };
  assert.equal(resolve('import Helper from "../util/Helper.js"; Helper.work();', "Helper.work", [extra]).locations[0].url, extra.url);
  assert.equal(resolve('import * as Helper from "../util/Helper.js"; Helper.default.work();', "Helper.default", [extra]).locations[0].offset, 0);
});

test("reexports, namespace reexports and export stars resolve through loaded modules", () => {
  const helper = { url: "https://app.test/util/Helper.js", content: "export function work() {} export default class Base { inherited() {} }" };
  const barrel = { url: "https://app.test/util/index.js", content: 'export { default as Base, work as renamed } from "./Helper.js"; export * from "./Helper.js"; export * as Helper from "./Helper.js";' };
  const content = 'import { Base, renamed, work, Helper } from "../util/index.js"; class Main extends Base { run() { this.inherited(); renamed(); work(); Helper.work(); } }';
  for (const marker of ["inherited();", "renamed();", "work();", "work(); }"]) {
    const result = resolve(content, marker, [helper, barrel]);
    assert.equal(result.locations?.[0].url, helper.url, JSON.stringify(result));
  }
  assert.equal(resolve('import * as H from "../util/index.js"; H.renamed();', "renamed();", [helper, barrel]).locations[0].url, helper.url);
});

test("cyclic reexports and inheritance terminate without guessing", () => {
  const extras = [
    { url: "https://app.test/util/A.js", content: 'export * from "./B.js"; export { missing as renamed } from "./B.js";' },
    { url: "https://app.test/util/B.js", content: 'export * from "./A.js"; export { renamed as missing } from "./A.js";' }
  ];
  assert.ok(resolve('import { missing } from "../util/A.js"; missing();', "missing();", extras).error);
  assert.ok(resolve('import { renamed } from "../util/A.js"; renamed();', "renamed();", extras).error);
  assert.ok(resolve('class A extends B {} class B extends A { run() { this.missing(); } }', "missing();").error);
});

test("imported class instances and super calls find the inherited implementation", () => {
  const extra = { url: "https://app.test/controller/Base.js", content: "export default class Base { inherited() {} }" };
  const content = 'import Base from "./Base.js"; class Main extends Base { inherited() {} run() { this.inherited(); super.inherited(); return () => super.inherited(); } } const instance = new Main(); instance.inherited(); new Base().inherited();';
  const nav = N.create([{ url, content }, extra]);
  for (const match of content.matchAll(/inherited\(\)/g)) {
    if (match.index === content.indexOf("inherited()")) continue;
    const result = nav.resolve(url, match.index);
    const base = content.slice(0, match.index).endsWith("super.") || content.slice(0, match.index).endsWith("new Base().");
    assert.equal(result.locations?.[0].url, base ? extra.url : url, JSON.stringify(result));
    assert.equal(result.locations[0].offset, base ? extra.content.indexOf("inherited()") : content.indexOf("inherited()"));
  }
});

test("relative dependencies in preloads use the named module ID across inheritance levels", () => {
  const content = 'sap.ui.define(["app/controller/Main"], function (Main) { Main.prototypeUnknown(); });';
  const bundled = { url: "https://cdn.test/resources/Component-preload.js", content: `
    sap.ui.predefine("app/base/Root", [], function () { return Controller.extend("Root", { inherited() {}, overridden() {} }); });
    sap.ui.predefine("app/controller/Base", ["../base/Root"], function (Root) { return Root.extend("Base", {}); });
    sap.ui.predefine("app/controller/Main", ["./Base"], function (Base) { return Base.extend("Main", {
      overridden() {}, run() { this.inherited(); this.overridden(); }
    }); });` };
  const nav = N.create([{ url, content }, bundled]);
  const inherited = nav.resolve(bundled.url, bundled.content.indexOf("inherited();"));
  assert.equal(inherited.locations?.[0].offset, bundled.content.indexOf("inherited() {}"));
  assert.equal(nav.resolve(bundled.url, bundled.content.indexOf("overridden();")).locations[0].offset, bundled.content.lastIndexOf("overridden() {}"));
  assert.equal(resolve(content.replace("Main.prototypeUnknown()", "Main.inherited()"), "inherited()", [bundled]).locations[0].url, bundled.url);
});
