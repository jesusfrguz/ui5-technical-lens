/* Shared, dependency-free helpers. No UI5 modules are loaded here. */
(() => {
  "use strict";
  const defaults = Object.freeze({ enabled: false, views: true, fragments: true, models: false, odatas: false, controllers: false, compact: false });
  function options(input = {}) {
    input = input || {};
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
      [key, typeof input[key] === "boolean" ? input[key] : value]));
  }
  function path(name, kind, type = "XML") {
    if (!name || typeof name !== "string") return "Origen sin nombre";
    // module: syntax is already a resource path; JS typed views/fragments use .js.
    if (name.startsWith("module:")) {
      const resource = name.slice(7);
      return /\.(js|xml|html|json)$/i.test(resource) ? resource : `${resource}.js`;
    }
    const extension = String(type).toLowerCase();
    const suffix = `.${kind === "view" ? "view" : "fragment"}.${extension}`;
    const base = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    return `${base.replace(/\./g, "/")}${suffix}`;
  }
  function intersect(a, b) {
    const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  }
  function controllerPath(name) {
    if (!name || typeof name !== "string") return "";
    if (name.startsWith("module:")) return /\.js$/.test(name) ? name.slice(7) : `${name.slice(7)}.js`;
    const base = name.replace(/\.controller\.js$/, "");
    return `${base.replace(/\./g, "/")}.controller.js`;
  }
  // Disjoint visible regions: overlapping popup holes must never cancel out.
  function uncoveredRects(rect, blockers) {
    let regions = [rect];
    for (const blocker of blockers) {
      regions = regions.flatMap((area) => {
        const shared = intersect(area, blocker);
        if (!shared) return [area];
        return [
          { left: area.left, top: area.top, right: area.right, bottom: shared.top },
          { left: area.left, top: shared.bottom, right: area.right, bottom: area.bottom },
          { left: area.left, top: shared.top, right: shared.left, bottom: shared.bottom },
          { left: shared.right, top: shared.top, right: area.right, bottom: shared.bottom }
        ].filter((piece) => piece.right > piece.left && piece.bottom > piece.top);
      });
    }
    return regions;
  }
  // Resolve by path, never by value: several properties may contain identical values.
  function jsonLines(text, targetPath = null) {
    let root;
    try { root = JSON.parse(text); } catch { return { lines: [String(text)], targetLine: null, nodes: [] }; }
    const lines = [], nodes = [];
    let targetLine = null;
    function visit(value, segments, indent, prefix = "", comma = "") {
      if (Array.isArray(targetPath) && segments.length === targetPath.length && segments.every((part, index) => part === targetPath[index])) targetLine = lines.length + 1;
      const space = "  ".repeat(indent);
      if (value === null || typeof value !== "object") { lines.push(`${space}${prefix}${JSON.stringify(value)}${comma}`); return; }
      const array = Array.isArray(value), entries = Object.entries(value);
      if (!entries.length) { lines.push(`${space}${prefix}${array ? "[]" : "{}"}${comma}`); return; }
      const node = { startLine: lines.length + 1, endLine: null, path: segments, size: entries.length, array };
      nodes.push(node);
      lines.push(`${space}${prefix}${array ? "[" : "{"}`);
      entries.forEach(([key, child], index) => visit(child, [...segments, key], indent + 1, array ? "" : `${JSON.stringify(key)}: `, index < entries.length - 1 ? "," : ""));
      lines.push(`${space}${array ? "]" : "}"}${comma}`);
      node.endLine = lines.length;
    }
    visit(root, [], 0);
    return { lines, targetLine, nodes };
  }
  const api = Object.freeze({ defaults, options, path, controllerPath, intersect, jsonLines, uncoveredRects });
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (!window.__UI5_TECH_LENS_CORE__) Object.defineProperty(window, "__UI5_TECH_LENS_CORE__", { value: api, configurable: true });
})();
