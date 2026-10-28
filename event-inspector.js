/* Read registered UI5 listeners without firing events or evaluating handler expressions. */
(() => {
  "use strict";
  if (window.__UI5_TECH_LENS_EVENTS__) return;
  const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const ids = new WeakMap(), functions = new Map(), descriptions = new Map();
  const prefix = `h${crypto.randomUUID().replace(/-/g, "")}_`;
  let sequence = 0;
  // Use descriptors throughout: application getters must not run during name lookup.
  function property(object, key) {
    const seen = new Set();
    while (object && !seen.has(object)) {
      seen.add(object);
      const descriptor = safe(() => Object.getOwnPropertyDescriptor(object, key));
      if (descriptor) return descriptor.value;
      object = safe(() => Object.getPrototypeOf(object));
    }
  }
  function resolvePath(object, path) {
    for (const part of path.split(".")) {
      if (!/^[\w$]+$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part)) return;
      object = property(object, part);
      if (object == null) return;
    }
    return object;
  }
  function methodName(object, fn) {
    const seen = new Set();
    while (object && !seen.has(object) && object !== Object.prototype) {
      seen.add(object);
      const descriptors = safe(() => Object.getOwnPropertyDescriptors(object), {});
      for (const [key, descriptor] of Object.entries(descriptors)) if (key !== "constructor" && descriptor.value === fn) return key;
      object = safe(() => Object.getPrototypeOf(object));
    }
    return "";
  }
  function token(fn, description) {
    if (!ids.has(fn)) {
      const id = `${prefix}${++sequence}`;
      ids.set(fn, id); functions.set(id, new WeakRef(fn));
      if (sequence % 100 === 0) for (const [key, ref] of functions) if (!ref.deref()) { functions.delete(key); descriptions.delete(key); }
    }
    descriptions.set(ids.get(fn), description);
    return ids.get(fn);
  }
  function signature(fn) {
    const source = safe(() => Function.prototype.toString.call(fn), "");
    const match = source.match(/^(?:async\s+)?(?:function\s*[^ (]*\s*)?\(([^)]*)\)/) || source.match(/^(?:async\s+)?[\w$]+\s*\(([^)]*)\)/) || source.match(/^(?:async\s+)?([\w$]+)\s*=>/);
    if (!match) return "no recuperables";
    const args = match[1].trim();
    // Never expose defaults, destructured values, function bodies or data literals.
    return args ? args.split(",").map((arg) => /^\s*(?:\.\.\.)?([\w$]+)\s*(?:=|$)/.exec(arg)?.[1] || "…").join(", ") : "sin argumentos";
  }
  function inspect(control, context = {}) {
    const metadata = safe(() => control.getMetadata().getAllEvents(), {});
    const registry = property(control, "mEventRegistry") || {};
    const controller = context.controller;
    const receivers = [controller, ...Object.values(property(controller, "_sapui_Extensions") || {}).map((item) => property(item, "extension"))].filter(Boolean);
    const events = [];
    for (const [name, definition] of Object.entries(metadata)) {
      const listeners = property(registry, name);
      if (!Array.isArray(listeners) || !listeners.length) continue;
      const handlers = [];
      for (const listener of listeners) {
        const registered = property(listener, "fFunction");
        if (typeof registered !== "function") continue;
        const receiver = property(listener, "oListener");
        const declared = property(registered, "_sapui_handlerName");
        // UI5 wraps XML handlers with arguments. Resolve only simple method paths,
        // never parse/evaluate their argument expression or invoke the wrapper.
        const reference = typeof declared === "string" ? declared.split("(")[0].trim() : "";
        let fn = registered, resolution = "función registrada";
        if (reference && !reference.startsWith("cmd:")) {
          const local = reference.startsWith(".") || !reference.includes(".");
          const resolved = local ? resolvePath(receiver || controller, reference.replace(/^\./, "")) : resolvePath(window, reference);
          if (typeof resolved === "function" && reference !== declared) { fn = resolved; resolution = "método XML resuelto en el receptor actual"; }
        }
        let owner, method = "";
        for (const candidate of [...new Set([receiver, ...receivers].filter(Boolean))]) {
          method = methodName(candidate, fn);
          if (method) { owner = candidate; break; }
        }
        let ownerName = safe(() => owner.getMetadata().getName(), "");
        if (method && !safe(() => Object.getOwnPropertyDescriptor(owner, method)?.value === fn, false)) {
          let meta = safe(() => owner.getMetadata());
          const seen = new Set();
          while (meta && !seen.has(meta)) {
            seen.add(meta);
            if (safe(() => Object.getOwnPropertyDescriptor(meta.getClass().prototype, method)?.value === fn, false)) { ownerName = safe(() => meta.getName(), ownerName); break; }
            meta = safe(() => meta.getParent());
          }
        }
        const ownerInfo = context.controllers?.find((item) => item.name === ownerName);
        const name = method || reference || property(fn, "name") || "función anónima";
        const path = ownerInfo?.path || "";
        const url = path ? safe(() => new URL(window.sap.ui.require.toUrl(path), location.href).href, "") : "";
        handlers.push({ token: token(fn, { name, path, url }), name,
          controller: ownerName || (owner ? "Objeto de eventos" : "Receptor no identificado"),
          path, arguments: signature(fn), resolution,
          // The reference and argument count suffice; do not copy XML literal values.
          declaration: reference ? `${reference}${typeof declared === "string" && declared.includes("(") ? "(…)" : ""}` : "" });
      }
      if (handlers.length) events.push({ name, parameters: Object.entries(definition.parameters || definition.appData?.parameters || {}).map(([name, info]) => ({ name, type: typeof info.type === "string" ? info.type : "any" })), handlers });
    }
    return events;
  }
  function describe(id) {
    const fn = functions.get(id)?.deref();
    if (!fn) return null;
    return { ...descriptions.get(id), source: safe(() => Function.prototype.toString.call(fn), "") };
  }
  Object.defineProperty(window, "__UI5_TECH_LENS_EVENTS__", { value: Object.freeze({ inspect, describe, resolve: (id) => functions.get(id)?.deref() }), configurable: true });
})();
