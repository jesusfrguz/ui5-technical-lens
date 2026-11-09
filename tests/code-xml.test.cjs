"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const XML = require("../code-xml.js"), Navigation = require("../code-navigation.js"), acorn = require("acorn");
const root = "https://app.test/";
const doc = (path, content) => ({ url: root + path, content });

test("XML handlers retain exact offsets, including parameters, multiline tags and quoted >", () => {
  const content = `<mvc:View controllerName="demo.controller.Main" xmlns:mvc="sap.ui.core.mvc">
    <!-- <Button press=".ignored"/> -->
    <![CDATA[<Button press=".alsoIgnored"/>]]>
    <Button text="A > B" press=".onSave('A &amp; B', \${model>/id})" />
    <Input\n change='onChange' visible="true" value="{name}" />
    <Button press="onOther($event)" />
  </mvc:View>`;
  const result = XML.inspect(content), handlers = result.tokens.filter((t) => t.method);
  assert.deepEqual(result.controllers, ["demo.controller.Main"]);
  assert.deepEqual(handlers.map((t) => [t.method, t.event]), [["onSave", "press"], ["onChange", "change"], ["onOther", "press"]]);
  for (const t of handlers) assert.equal(content.slice(t.start, t.end).replace(/^\./, ""), t.method);
  assert.deepEqual(XML.inspect('<Button press="Helper.save()" change="cmd:save" value="{= ${x} }"/>').tokens, []);
});

test("declarative nested fragments inherit controller context and shared fragments retain ambiguity", () => {
  const main = doc("demo/view/Main.view.xml", '<View controllerName="demo.controller.Main"><Fragment fragmentName="demo.fragment.Outer"/></View>');
  const other = doc("demo/view/Other.view.xml", '<View controllerName="demo.controller.Other"><Fragment fragmentName="demo.fragment.Inner"/></View>');
  const outer = doc("demo/fragment/Outer.fragment.xml", '<FragmentDefinition><Fragment fragmentName="demo.fragment.Inner"/></FragmentDefinition>');
  const inner = doc("demo/fragment/Inner.fragment.xml", '<Button press=".onSave"/>');
  const docs = [main, other, outer, inner];
  assert.deepEqual(XML.controllerNames(inner, docs).sort(), ["demo.controller.Main", "demo.controller.Other"]);
  assert.deepEqual(XML.controllerNames(inner, docs, ["demo.controller.Actual"]), ["demo.controller.Actual"]);
  assert.deepEqual(XML.controllerNames(inner, docs, []), [], "Anonymous runtime handlers cannot fall back to another controller");
  assert.deepEqual(XML.controllerNames(doc("unknown.fragment.xml", "<Button/>"), docs), []);
});

test("XML method destinations use controller identity, inheritance and precise preload positions", () => {
  const base = doc("demo/controller/Base.js", 'sap.ui.define([], function() { return Controller.extend("demo.controller.Base", { onSave: function() { throw new Error("Do not execute"); } }); });');
  const main = doc("demo/controller/Main.controller.js", 'sap.ui.define(["./Base"], function(Base) { return Base.extend("demo.controller.Main", { onChange() {} }); });');
  const wrong = doc("demo/controller/Other.controller.js", 'sap.ui.define([], function() { return Controller.extend("demo.controller.Other", { onSave() {} }); });');
  const nav = Navigation.create([base, main, wrong]);
  assert.equal(nav.controllerMethod("demo.controller.Main", "onSave")[0].url, base.url);
  assert.equal(nav.controllerMethod("demo.controller.Main", "onChange")[0].offset, main.content.indexOf("onChange"));
  assert.deepEqual(nav.controllerMethod("demo.controller.Main", "missing"), []);
  const bundle = doc("Component-preload.js", 'sap.ui.require.preload({"demo/controller/Main.controller.js": function() { sap.ui.define([], function() { return Controller.extend("demo.controller.Main", { onSave() {} }); }); }});');
  const result = Navigation.create([bundle]).controllerMethod("demo.controller.Main", "onSave");
  assert.equal(result[0].url, bundle.url);
  assert.equal(result[0].offset, bundle.content.indexOf("onSave"));
});

test("literal XML preloads are extracted without executing code or accepting arbitrary objects", () => {
  const xml = '<View controllerName="demo.Main">\r\n<Button press=".onSave"/></View>';
  const source = `sap.ui.require.preload({"demo/view/Main.view.xml": ${JSON.stringify(xml)}, "demo/Dynamic.fragment.xml": makeXML(), "other.js": function() {} });`;
  assert.deepEqual(XML.preloads(source, acorn), [{ path: "demo/view/Main.view.xml", content: xml.replace(/\r\n/g, "\n") }]);
  assert.deepEqual(XML.preloads(`other.preload({"demo/view/Main.view.xml": ${JSON.stringify(xml)}})`, acorn), []);
  assert.deepEqual(XML.preloads("bad syntax {", acorn), []);
});

test("controller methods obey loader mappings and offer duplicate definitions", () => {
  const source = 'sap.ui.define([], function() { return Controller.extend("demo.Main", { onSave() {} }); });';
  const a = doc("a/Main.controller.js", source), b = doc("b/Main.controller.js", source);
  const moduleUrls = { "demo/Main.controller": a.url };
  assert.equal(Navigation.create([a, b], { moduleUrls }).controllerMethod("demo.Main", "onSave")[0].url, a.url);
  const duplicate = [doc("one/demo/Main.controller.js", source), doc("two/demo/Main.controller.js", source)];
  assert.equal(Navigation.create(duplicate).controllerMethod("demo.Main", "onSave").length, 2);
});
