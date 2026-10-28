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
  const api = Object.freeze({ defaults, options, path, controllerPath, intersect });
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (!window.__UI5_TECH_LENS_CORE__) Object.defineProperty(window, "__UI5_TECH_LENS_CORE__", { value: api, configurable: true });
})();
