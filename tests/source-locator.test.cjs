"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const S = require("../source-locator.js");
test("matches complete function text, not comments or another method with the same name", () => {
  const source = "function (event) {\n  return event;\n}";
  const url = "https://example.com/controller/Main.controller.js";
  const result = S.locate([{ url, content: `// onPress: not the definition\r\nconst controller = {\r\n  onPress: ${source.replace(/\n/g, "\r\n")}\r\n};` },
    { url: "https://example.com/Other.js", content: "const onPress = function (event) { return 9; };" }], { name: "onPress", source, url });
  assert.deepEqual(result, { url, line: 2, column: 11 });
});
test("method names disambiguate identical bodies and module URLs disambiguate identical scripts", () => {
  const source = "function () {}", url = "https://example.com/Main.controller.js";
  const content = `({ onOther: ${source}, onPress: ${source} })`;
  assert.deepEqual(S.locate([{ url, content }, { url: "https://example.com/Other.js", content }], { name: "onPress", source, url }), { url, line: 0, column: content.lastIndexOf(source) });
});
test("supports debug resources, bundles and columns in minified scripts", () => {
  const source = "function a(e){return e.x}", url = "https://example.com/Component-preload.js";
  const content = `sap.ui.predefine('app/Main',[],function(){return {onRun:${source}}});`;
  assert.deepEqual(S.locate([{ url, content }], { name: "onRun", source, url: "https://example.com/Main.controller.js" }), { url, line: 0, column: content.indexOf(source) });
  assert.equal(S.sameResource("https://example.com/Main.controller-dbg.js?version=1", "https://example.com/Main.controller.js"), true);
});
test("ambiguity, native functions and missing sources cannot select a wrong file", () => {
  const source = "function run() {}";
  for (const result of [S.locate([{ url: "a.js", content: source }, { url: "b.js", content: source }], { source }), S.locate([], { source }),
    S.locate([{ url: "a.js", content: "function () { [native code] }" }], { source: "function () { [native code] }" })]) {
    assert.ok(result.error); assert.equal(result.url, undefined);
  }
});
test("function text inside comments, strings, templates and regexps is not executable source", () => {
  const source = "function run() {}", url = "https://example.com/Main.js";
  const decoys = '// ' + source + '\n/* ' + source + ' */\nconst text = "' + source + '"; const template = `' + source + '`; const regex = /function run\\(\\) {}/;';
  assert.ok(S.locate([{ url, content: decoys }], { source }).error);
  const content = decoys + "\n" + source;
  assert.deepEqual(S.locate([{ url, content }], { source }), { url, line: 3, column: 0 });
});
test("object and class method shorthand retain their exact source positions", () => {
  const source = "onPress(event) { return event; }", url = "https://example.com/Main.js";
  for (const content of [`const a = { ${source} };`, `class Main { ${source} }`]) {
    assert.deepEqual(S.locate([{ url, content }], { source, name: "onPress" }), { url, line: 0, column: content.indexOf(source) });
  }
});
