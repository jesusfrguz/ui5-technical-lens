/* Static XML source inspection. Never instantiate controls or evaluate handlers. */
(() => {
  "use strict";
  const isXML = (url) => /\.(?:view|fragment)\.xml(?:[?#]|$)/i.test(url);
  function inspect(content) {
    const tokens = [], controllers = [], fragments = [];
    // Quoted '>' characters, multiline attributes, comments and CDATA retain
    // their source offsets. No DOM insertion or external entity expansion.
    const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;
    for (const tag of content.matchAll(tags)) {
      if (/^<[!?]/.test(tag[0])) { tokens.push({ start: tag.index, end: tag.index + tag[0].length, style: "comment" }); continue; }
      const attrs = /([^\s=<>"']+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      for (const attr of tag[0].matchAll(attrs)) {
        const name = attr[1], value = attr[3] ?? attr[4], start = tag.index + attr.index + attr[0].indexOf(attr[2]) + 1;
        if (name === "controllerName") { controllers.push(value); continue; }
        if (name === "fragmentName") { fragments.push(value); continue; }
        if (name.includes(":") || /^(?:id|text|title|class|type|name|binding|value|controllerName|fragmentName)$/.test(name)) continue;
        const handler = /^\s*(\.?[A-Za-z_$][\w$]*)\s*(?:\([\s\S]*\))?\s*$/.exec(value);
        if (!handler || /^(?:true|false|null|undefined)$/.test(handler[1])) continue;
        const offset = start + value.indexOf(handler[1]);
        tokens.push({ start: offset, end: offset + handler[1].length, style: "identifier xml-handler", method: handler[1].replace(/^\./, ""), event: name });
      }
    }
    return { tokens, controllers: [...new Set(controllers)], fragments };
  }
  function controllerNames(resource, resources, context, seen = new Set()) {
    if (Array.isArray(context)) return [...new Set(context)];
    if (seen.has(resource.url)) return [];
    seen = new Set(seen).add(resource.url);
    const own = inspect(resource.content).controllers;
    if (own.length) return own;
    const names = [];
    for (const parent of resources.filter((r) => isXML(r.url) && typeof r.content === "string")) {
      if (inspect(parent.content).fragments.some((name) => {
        const path = name.replace(/\./g, "/") + ".fragment.xml";
        return resource.path === path || new URL(resource.url).pathname.endsWith("/" + path);
      })) names.push(...controllerNames(parent, resources, undefined, seen));
    }
    return [...new Set(names)];
  }
  function preloads(content, acorn) {
    const found = [];
    try {
      const ast = acorn.parse(content, { ecmaVersion: "latest", sourceType: "script" });
      function walk(node) {
        if (!node?.type) return;
        if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
          && node.callee.property.name === "preload" && node.callee.object.type === "MemberExpression"
          && node.callee.object.property.name === "require" && node.callee.object.object.type === "MemberExpression"
          && node.callee.object.object.property.name === "ui" && node.callee.object.object.object.name === "sap") {
          for (const p of node.arguments[0]?.properties || []) {
            const path = p.key.value;
            if (typeof path === "string" && isXML(path) && typeof p.value?.value === "string") found.push({ path, content: p.value.value.replace(/\r\n?/g, "\n") });
          }
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(walk); else if (value?.type) walk(value);
        }
      }
      walk(ast);
    } catch { /* Non-literal or malformed preloads cannot supply XML source. */ }
    return found;
  }
  const api = { isXML, inspect, controllerNames, preloads };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.UI5CodeXML = api;
})();
