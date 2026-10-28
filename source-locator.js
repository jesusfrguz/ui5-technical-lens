/* Match complete runtime functions against code already loaded in DevTools. */
(() => {
  "use strict";
  const parser = typeof module !== "undefined" && module.exports ? require("acorn") : globalThis.acorn;
  const normalize = (value) => value.replace(/\r\n?/g, "\n");
  function functionRanges(content) {
    let ast;
    try { ast = parser.parse(content, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
    catch { try { ast = parser.parse(content, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true }); } catch { return null; } }
    const ranges = new Map(), pending = [ast];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== "object") continue;
      if (["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(node.type)) {
        const key = `${node.start}:${node.end}`;
        if (!ranges.has(key)) ranges.set(key, node.id?.name || "");
      }
      if (["Property", "MethodDefinition"].includes(node.type) && /FunctionExpression|ArrowFunctionExpression/.test(node.value?.type || "")) {
        const name = !node.computed ? node.key.name || node.key.value || "" : typeof node.key.value === "string" ? node.key.value : "";
        ranges.set(`${node.value.start}:${node.value.end}`, name);
        if (node.method || node.type === "MethodDefinition" || node.kind === "get" || node.kind === "set") {
          ranges.set(`${node.start}:${node.end}`, name); ranges.set(`${node.key.start}:${node.end}`, name);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const item of value) pending.push(item); }
        else if (value && typeof value === "object" && typeof value.type === "string") pending.push(value);
      }
    }
    return ranges;
  }
  function sameResource(url, hint) {
    if (!hint) return false;
    try {
      const left = new URL(url), right = new URL(hint);
      return left.origin === right.origin && left.pathname.replace(/-dbg\.js$/, ".js") === right.pathname.replace(/-dbg\.js$/, ".js");
    } catch { return url === hint; }
  }
  function matches(resource, descriptor) {
    if (typeof resource.content !== "string" || typeof descriptor.source !== "string" || !descriptor.source || descriptor.source.includes("[native code]")) return [];
    const content = normalize(resource.content), source = normalize(descriptor.source), found = [];
    if (!content.includes(source)) return found;
    const ranges = functionRanges(content);
    if (!ranges) return found;
    let start = 0, index;
    while ((index = content.indexOf(source, start)) !== -1) {
      const key = `${index}:${index + source.length}`;
      if (ranges.has(key)) {
        const before = content.slice(0, index), line = before.split("\n").length - 1;
        found.push({ url: resource.url, line, column: index - (before.lastIndexOf("\n") + 1), named: Boolean(descriptor.name) && ranges.get(key) === descriptor.name });
      }
      start = index + source.length;
    }
    return found.some((item) => item.named) ? found.filter((item) => item.named) : found;
  }
  function locate(resources, descriptor) {
    let found = resources.flatMap((resource) => matches(resource, descriptor));
    const preferred = found.filter((item) => sameResource(item.url, descriptor.url));
    if (preferred.length) found = preferred;
    const unique = [...new Map(found.map((item) => [`${item.url}:${item.line}:${item.column}`, item])).values()];
    if (unique.length !== 1) return { error: unique.length ? "La función coincide en varias ubicaciones. No se ha abierto un fichero para evitar seleccionar otro método." : "No se encontró una ubicación única de esta función en los scripts cargados. Puede ser un wrapper, código nativo o un recurso no disponible en DevTools." };
    const { url, line, column } = unique[0];
    return { url, line, column };
  }
  const api = Object.freeze({ locate, sameResource });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.defineProperty(globalThis, "__UI5_TECH_LENS_SOURCES__", { value: api });
})();
