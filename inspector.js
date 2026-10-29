(() => {
  "use strict";
  if (window.__UI5_TECH_LENS__) return;
  const H = window.__UI5_TECH_LENS_CORE__;
  const D = window.__UI5_TECH_LENS_DATA__;
  const C = window.__UI5_TECH_LENS_CONTROLLERS__;
  const E = window.__UI5_TECH_LENS_EVENTS__;
  let preferences = H.options(), host, layer, discoveryLayer, hoverLayer, observer, timer, runtimeTimer, frameRequest, hoverRequest, lastScan = 0;
  let pointer = null, dismissedNode = null, activeHoverNode = null;
  let pinned = null, handledAlt = false, handledEscape = false;
  let discoveryActive = false;
  let dataTargets = new Map();
  let entries = [], controls = [], hooksInstalled = false, loadingModules = false, selected = "";
  const kindOption = { view: "views", fragment: "fragments", model: "models", odata: "odatas", controller: "controllers", event: "controllers" };
  const kindLetter = { view: "V", fragment: "F", model: "M", odata: "O", controller: "C", event: "E" };
  const inspectionEnabled = () => preferences.models || preferences.odatas || preferences.controllers;
  const inspectionOptions = () => `${preferences.models}:${preferences.odatas}:${preferences.controllers}`;
  const fragments = new Map(), wrappers = new WeakSet();
  const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const moduleValue = (name) => safe(() => window.sap?.ui?.require?.(name));
  const isView = (control) => safe(() => control.isA("sap.ui.core.mvc.View"), false);
  const controlId = (control) => safe(() => control.getId(), "");

  function remember(content, name, type, source = "capturado", context = {}) {
    if (typeof name !== "string" || !name) return;
    const roots = (Array.isArray(content) ? content : [content]).filter((c) => c && typeof c.getId === "function");
    if (!roots.length) return;
    const key = `${name}|${roots.map(controlId).sort().join("|")}`;
    const previous = fragments.get(key);
    fragments.set(key, { ...previous, key, name, type: type || "XML", roots, source,
      controllerKnown: context.controllerKnown || previous?.controllerKnown || false,
      controller: context.controllerKnown ? context.controller : previous?.controller,
      containingView: context.containingView || previous?.containingView });
    schedule(true);
  }

  function wrap(target, key, after, before) {
    const original = target?.[key];
    if (typeof original !== "function" || wrappers.has(original)) return false;
    function instrumented(...args) {
      const context = safe(() => before?.call(this, args));
      const result = Reflect.apply(original, this, args);
      // Instrumentation must preserve the original return value, promise and exceptions.
      safe(() => after.call(this, args, result, context));
      return result;
    }
    wrappers.add(instrumented);
    target[key] = instrumented;
    return true;
  }

  function installHooks() {
    const Fragment = moduleValue("sap/ui/core/Fragment") || window.sap?.ui?.core?.Fragment;
    if (!Fragment) return;
    // This guarded internal hook also covers declarative XML fragments and legacy factories.
    // Public Fragment.load alone misses fragments instantiated by XMLTemplateProcessor.
    const internal = wrap(Fragment.prototype, "_initCompositeSupport", function ([settings]) {
      // The async factory supplies both fragmentName and its resolved XML content.
      const name = settings?.fragmentName;
      if (!name) return;
      const controller = safe(() => this.getController()) || this.oController || settings.oController;
      const context = { controller, controllerKnown: Boolean(controller) || settings.oController === null, containingView: settings.containingView };
      if (this._pContentPromise?.then) {
        this._pContentPromise.then((content) => safe(() => remember(content, name, settings.type, "capturado", context)), () => {});
      } else remember(this._aContent, name, settings.type, "capturado", context);
    });
    const publicHook = wrap(Fragment, "load", function ([settings], result, context) {
      if (context?.name && result?.then) result.then((content) => safe(() => remember(content, context.name, context.type, "capturado", context)), () => {});
    }, function ([settings]) {
      return { name: settings?.definition ? null : settings?.name || settings?.fragmentName, type: settings?.type,
        controller: settings?.controller ?? settings?.oController,
        controllerKnown: settings?.controller !== undefined || settings?.oController !== undefined };
    });
    hooksInstalled = hooksInstalled || internal || publicHook;
  }

  function ensureRuntime() {
    if (!window.sap?.ui?.require) return;
    installHooks();
    // Wait for Core initialization and its library preloads. Requesting Fragment
    // during the bootstrap can race the preload and break optimized deployments
    // where only Fragment-dbg.js and the bundle are served individually.
    const initialized = safe(() => sap.ui.getCore().isInitialized(), false);
    if (!hooksInstalled && !loadingModules && initialized) {
      loadingModules = true;
      // Async only; never use requireSync or change UI5 configuration.
      safe(() => sap.ui.require(["sap/ui/core/Fragment", "sap/ui/core/Element"], () => {
        loadingModules = false; installHooks(); schedule(true);
      }, () => { loadingModules = false; }));
    }
  }

  function allControls() {
    const Element = moduleValue("sap/ui/core/Element") || window.sap?.ui?.core?.Element;
    const registry = Element?.registry || moduleValue("sap/ui/core/ElementRegistry");
    const all = safe(() => registry.all());
    if (all) return Object.values(all);
    // Older UI5: resolve rendered controls, then walk parents to recover views.
    const core = safe(() => window.sap?.ui?.getCore());
    const found = new Set();
    document.querySelectorAll("[data-sap-ui]").forEach((node) => {
      let control = safe(() => Element?.getElementById?.(node.id) || core?.byId(node.id));
      while (control && !found.has(control)) { found.add(control); control = safe(() => control.getParent()); }
    });
    return [...found];
  }

  function domRoots(control) {
    const own = safe(() => control.getDomRef());
    if (own?.isConnected) return [own];
    // Semantic XMLViews may not have a wrapper DOM node of their own.
    const children = safe(() => control.getContent(), []);
    return (Array.isArray(children) ? children : [children]).flatMap((child) => child && child !== control ? domRoots(child) : []);
  }

  function visibleRect(element) {
    if (!element?.isConnected || !element.getClientRects().length) return null;
    let rect = H.intersect(element.getBoundingClientRect(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    let escapesClipping = false;
    for (let node = element; rect && node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return null;
      // Fixed popups escape static overflow ancestors (notably #sap-ui-static,
      // whose UI5 box is 0×0). A transformed containing block restores clipping.
      if (node !== element && (style.transform !== "none" || style.perspective !== "none" || style.filter !== "none" || /paint|layout|strict|content/.test(style.contain))) escapesClipping = false;
      if (!escapesClipping && node !== element && /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const box = node.getBoundingClientRect();
        rect = H.intersect(rect, {
          left: /(auto|scroll|hidden|clip)/.test(style.overflowX) ? box.left : -Infinity,
          right: /(auto|scroll|hidden|clip)/.test(style.overflowX) ? box.right : Infinity,
          top: /(auto|scroll|hidden|clip)/.test(style.overflowY) ? box.top : -Infinity,
          bottom: /(auto|scroll|hidden|clip)/.test(style.overflowY) ? box.bottom : Infinity
        });
      }
      if (style.position === "fixed") escapesClipping = true;
    }
    return rect;
  }

  function collect() {
    ensureRuntime();
    controls = allControls();
    const next = [];
    for (const control of controls) {
      if (isView(control)) {
        const name = safe(() => control.getViewName());
        if (!name) continue;
        const metadata = safe(() => control.getMetadata().getName(), "");
        const type = /JSView/.test(metadata) ? "JS" : /JSONView/.test(metadata) ? "JSON" : /HTMLView/.test(metadata) ? "HTML" : "XML";
        next.push({ key: `view:${controlId(control)}`, kind: "view", name, path: H.path(name, "view", type), roots: [control], source: "runtime" });
      }
      const info = control._sapui_declarativeSourceInfo;
      // Only real source metadata qualifies; never guess fragments from ID prefixes.
      if (info?.fragmentName) remember(control, info.fragmentName, "XML", "origen UI5");
    }
    for (const [key, record] of fragments) {
      const roots = record.roots.filter((control) => !safe(() => control.isDestroyed(), control.bIsDestroyed || control._bIsBeingDestroyed || false));
      if (!roots.length) { fragments.delete(key); continue; }
      record.roots = roots;
      next.push({ ...record, key: `fragment:${key}`, kind: "fragment", path: H.path(record.name, "fragment", record.type) });
    }
    const sourceEntries = [...next];
    if (preferences.models || preferences.odatas) {
      const sources = new Map();
      for (const entry of next) for (const control of entry.roots) sources.set(control, entry.path);
      for (const control of controls) {
        const windowScope = sources.has(control) || safe(() => ["sap.m.Page", "sap.m.Dialog", "sap.m.Popover"].some((type) => control.isA(type)), false);
        const data = D.inspect(control, windowScope);
        if (!data.models.length && !data.bindings.length) continue;
        const type = safe(() => control.getMetadata().getName(), "Control");
        let scope = sources.get(control), parent = safe(() => control.getParent());
        const seen = new Set();
        while (!scope && parent && !seen.has(parent)) {
          seen.add(parent); scope = sources.get(parent); parent = safe(() => parent.getParent());
        }
        for (const kind of ["model", "odata"]) {
          if (!preferences[kindOption[kind]]) continue;
          const models = data.models.filter((model) => kind === "model" || model.odata);
          const bindings = data.bindings.filter((binding) => kind === "model" || binding.odata);
          if (!models.length && !bindings.length) continue;
          const bindingLines = bindings.map((binding) => `${binding.property} ← ${binding.model || "(por defecto)"}>${binding.resolved || binding.path}${!binding.resolved && !binding.path.startsWith("/") ? " [sin contexto]" : ""}`);
          const modelLines = models.filter((model) => !bindings.some((binding) => binding.model === model.name))
            .map((model) => `${model.label} · ${model.type.split(".").pop()}${model.context ? ` · ${model.context}` : ""} (disponible)`);
          const services = kind === "odata" ? [...new Set(models.map((model) => model.service).filter(Boolean))] : [];
          const lines = [...bindingLines, ...modelLines, ...services];
          next.push({ key: `${kind}:${controlId(control)}`, kind, name: type, controlType: type, scope: scope || "",
            path: lines.join("\n"), label: lines.slice(0, 2).join("\n") + (lines.length > 2 ? `\n+${lines.length - 2} · ver panel` : ""),
            roots: [control], source: bindings.length ? "binding de control" : "modelos disponibles", models, bindings });
        }
      }
    }
    if (preferences.controllers) for (const source of sourceEntries) {
      const info = C.inspect(source);
      next.push({ key: `controller:${source.key}`, kind: "controller", name: source.name,
        path: info.controllers.map((controller) => controller.path).join("\n") || info.controllerStatus,
        source: info.association, roots: source.roots, scope: source.path, scopeKind: source.kind,
        controlType: safe(() => source.roots[0].getMetadata().getName(), "Control"), models: [], bindings: [], ...info });
    }
    if (preferences.controllers) {
      const sources = new Map(), contexts = new Map();
      for (const source of sourceEntries) for (const root of source.roots) sources.set(root, source);
      for (const control of controls) {
        let current = control, source;
        const seen = new Set();
        while (current && !seen.has(current)) {
          seen.add(current); source = sources.get(current);
          if (source) break;
          current = safe(() => current.getParent());
        }
        const fallback = source || { kind: "fragment", roots: [control] };
        if (!contexts.has(fallback)) contexts.set(fallback, { ...C.context(fallback), ...C.inspect(fallback) });
        const context = contexts.get(fallback), events = E.inspect(control, context);
        if (!events.length) continue;
        const controlType = safe(() => control.getMetadata().getName(), "Control");
        next.push({ key: `event:${controlId(control)}`, kind: "event", name: controlType, controlType,
          scope: source?.path || "", scopeKind: source?.kind, roots: [control], source: "eventos registrados",
          path: events.map((event) => `${event.name} → ${event.handlers.map((handler) => handler.name).join(", ")}`).join("\n"),
          models: [], bindings: [], events, controllers: context.controllers, association: context.association,
          controllerStatus: context.controllerStatus, ownerView: context.ownerView });
      }
    }
    entries = next;
    dataTargets = new Map();
    for (const entry of entries.filter((item) => ["model", "odata", "controller", "event"].includes(item.kind))) {
      for (const node of entry.roots.flatMap(domRoots)) {
        if (!dataTargets.has(node)) dataTargets.set(node, []);
        dataTargets.get(node).push(entry);
      }
    }
    lastScan = performance.now();
  }

  function ensureLayer() {
    if (host?.isConnected) return;
    if (!document.documentElement) return;
    host = document.createElement("div");
    host.id = "ui5-technical-lens-overlay";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important;z-index:2147483647!important;overflow:visible!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{pointer-events:none!important}.box{position:fixed;box-sizing:border-box;border:2px solid var(--color);border-radius:5px;background:var(--fill);pointer-events:none}.view{--color:#087eae;--fill:#009fe508}.fragment{--color:#a84edb;--fill:#a84edb0c;border-style:dashed}.model{--color:#11835e;--fill:#11835e08;border-style:dotted}.odata{--color:#af580d;--fill:#ed800b08;border-style:dashed}.selected{border-width:4px;background:#ffce3230;box-shadow:0 0 0 3px #ffce32}.tag{position:absolute;left:-2px;top:0;max-width:calc(100vw - 12px);box-sizing:border-box;padding:4px 8px;border-radius:0 0 5px 0;background:var(--color);color:white;font:600 11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:0 2px 6px #0002;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model .tag,.odata .tag{white-space:pre;max-width:560px}.selected .tag{background:#725600}`;
    layer = document.createElement("div");
    discoveryLayer = document.createElement("div");
    hoverLayer = document.createElement("div");
    style.textContent += `
      .hover-outline{position:fixed;box-sizing:border-box;border:2px solid #168469;border-radius:5px;background:#16846909;pointer-events:none}
      .hover-outline.odata{border-color:#af580d}
      .hover-card{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;background:#fff;color:#173247;border:1px solid #d8e5eb;border-top:3px solid #168469;border-radius:10px;box-shadow:0 8px 30px #17324735;padding:14px 16px;font:13px/1.5 Segoe UI,system-ui,sans-serif;pointer-events:none;overflow:hidden;overflow-wrap:anywhere}
      .hover-card.odata{border-top-color:#af580d}
      .hover-content{min-height:0;overflow:hidden}
      .hover-heading{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#116d50;font-weight:700}
      .hover-card.odata .hover-heading{color:#9a4b09}
      .hover-name{font-size:16px;font-weight:700;margin:4px 0 6px}
      .hover-id,.hover-scope{font:12px/1.5 Consolas,monospace;color:#526b7a}
      .hover-section{margin-top:12px;padding-top:10px;border-top:1px solid #e6edf1}
      .hover-section-title{font-weight:600;font-size:12px;margin-bottom:6px}
      .hover-row{margin:7px 0;color:#436170;font-size:12px}
      .hover-row strong{color:#173247}
      .hover-row code{display:block;font:12px/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#31566b}
      .hover-note{flex-shrink:0;margin-top:12px;padding-top:10px;border-top:1px solid #e6edf1;font-size:12px;color:#526b7a}
      .hover-card:not(.pinned) .hover-id,.hover-card:not(.pinned) .hover-scope{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .hover-card:not(.pinned) .hover-name,.hover-card:not(.pinned) .hover-row code{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
      .hover-card:not(.pinned) .hover-section{margin-top:8px;padding-top:7px}
      .hover-card:not(.pinned) .hover-row{margin:4px 0}
      .hover-card.pinned{pointer-events:auto!important;user-select:text!important;outline:none}
      .hover-card.pinned .hover-content{overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:2px 5px 2px 0}
      .hover-card.pinned .hover-content:focus-visible{outline:1px solid #c8dce5;outline-offset:-1px}
      .hover-card.pinned ::selection{background:#bfe8f4;color:#173247}
      .hover-actions{flex-shrink:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #e6edf1;font-size:12px;color:#526b7a;user-select:none}
      .hover-actions>span{margin-right:auto}
      .hover-copy,.hover-close{font:600 12px Segoe UI,system-ui,sans-serif;padding:7px 10px;border:1px solid #c8dce5;border-radius:6px;background:#edf6f9;color:#235b70;cursor:pointer}
      .hover-close{background:#fff}
      .hover-copy:focus-visible,.hover-close:focus-visible{outline:2px solid #168469;outline-offset:2px}
      .hover-source-status{font-size:12px;margin-top:4px}
    `;
    style.textContent += `.hover-card.controller{border-top-color:#5656b8}.hover-card.controller .hover-heading{color:#5656b8}.hover-outline.controller{border-color:#5656b8}`;
    style.textContent += `.controller{--color:#5656b8}.discovery-outline{position:fixed;box-sizing:border-box;border:0;border-radius:5px;outline:2px solid var(--color);background:transparent;pointer-events:none}`;
    shadow.append(style, layer, discoveryLayer, hoverLayer);
    document.documentElement.append(host);
  }

  function draw() {
    frameRequest = null;
    if (!preferences.enabled) return;
    if (performance.now() - lastScan > 650) collect();
    ensureLayer();
    if (!layer) return;
    const output = document.createDocumentFragment(), labels = [];
    // Only view/fragment file names remain persistent. Data is inspected on hover.
    const drawingEntries = entries.filter((entry) => (entry.kind === "view" || entry.kind === "fragment") && preferences[kindOption[entry.kind]]);
    let boxes = 0;
    for (const entry of drawingEntries) {
      const nodes = [...new Set(entry.roots.flatMap(domRoots))];
      for (const node of nodes) {
        const rect = visibleRect(node);
        if (!rect || boxes++ >= 300) continue;
        const box = document.createElement("div"), label = document.createElement("span");
        box.className = `box ${entry.kind}${selected === entry.key || entry.keys?.includes(selected) ? " selected" : ""}`;
        box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
        box.dataset.source = entry.path;
        label.className = "tag";
        const text = entry.label || (preferences.compact ? entry.path.split("/").pop() : entry.path);
        label.textContent = `${entry.letter || kindLetter[entry.kind]} · ${text}`;
        const height = text.split("\n").length * 16 + 8;
        const width = Math.min(560, Math.max(...text.split("\n").map((line) => line.length)) * 6.7 + 50, innerWidth - rect.left - 6);
        const right = Math.max(rect.left, rect.right - width);
        const bottom = Math.max(rect.top, rect.bottom - height);
        const candidates = [[rect.left, rect.top], [right, rect.top], [rect.left, bottom], [right, bottom]];
        const overlap = ([left, top]) => labels.reduce((total, other) => {
          const shared = H.intersect({ left, top, right: left + width, bottom: top + height }, other);
          return total + (shared ? shared.width * shared.height : 0);
        }, 0);
        candidates.sort((a, b) => overlap(a) - overlap(b));
        const [left, top] = candidates[0];
        label.style.left = `${left - rect.left - 2}px`;
        label.style.top = `${top - rect.top}px`;
        label.style.maxWidth = `${Math.max(20, innerWidth - rect.left - 6)}px`;
        labels.push({ left, top, right: left + width, bottom: top + height });
        box.append(label); output.append(box);
      }
    }
    layer.replaceChildren(output);
    drawDiscovery();
    renderHover();
  }

  function drawDiscovery() {
    if (!discoveryLayer) return;
    const output = document.createDocumentFragment();
    if (discoveryActive && preferences.enabled) {
      let count = 0;
      for (const [node, items] of dataTargets) {
        const kinds = [...new Set(items.filter((entry) => preferences[kindOption[entry.kind]])
          .map((entry) => entry.kind === "event" ? "controller" : entry.kind))];
        if (!kinds.length) continue;
        const rect = visibleRect(node);
        if (!rect) continue;
        if (count++ >= 300) break;
        kinds.forEach((kind, index) => {
          const outline = document.createElement("div");
          outline.className = `discovery-outline ${kind}`;
          outline.dataset.targetId = node.id;
          outline.dataset.kind = kind;
          // Separate rings keep every active flag's color visible on one field.
          outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline-offset:${2 + index * 3}px`;
          output.append(outline);
        });
      }
    }
    discoveryLayer.replaceChildren(output);
  }

  function highlightTargets(active) {
    const next = Boolean(active && preferences.enabled);
    if (next === discoveryActive) return;
    discoveryActive = next;
    if (next) schedule(true); else discoveryLayer?.replaceChildren();
  }

  function requestHighlights(active) {
    highlightTargets(active);
    // The focused frame receives the keyboard event; the extension coordinates
    // the temporary outlines with the other frames in this tab.
    window.postMessage({ channel: "ui5-lens:highlight-request", active }, "*");
  }

  function hoveredData() {
    // "Locate" from the popup also previews the data, even without a pointer.
    const located = entries.find((entry) => entry.key === selected && ["model", "odata", "controller", "event"].includes(entry.kind) && preferences[kindOption[entry.kind]]);
    if (located) {
      const node = located.roots.flatMap(domRoots).find((item) => visibleRect(item));
      if (node) return { node, items: dataTargets.get(node) || [located], located: true };
    }
    if (!pointer) return null;
    let node = document.elementFromPoint(pointer.x, pointer.y);
    let data = null, controller = null, eventTarget = null, passedControl = false;
    while (node && node !== host) {
      if (node.tagName === "IFRAME") return null; // the frame manages its own card
      const items = dataTargets.get(node);
      if (!eventTarget && preferences.controllers) {
        const matches = items?.filter((entry) => entry.kind === "event");
        if (matches?.length) eventTarget = { node, items: matches };
      }
      if (!controller && preferences.controllers) {
        const matches = items?.filter((entry) => entry.kind === "controller");
        const item = matches?.find((entry) => entry.scopeKind === "fragment") || matches?.[0];
        if (item) controller = { node, items: [item] };
      }
      if (!data && !passedControl) {
        const matches = items?.filter((entry) => entry.kind === "model" || entry.kind === "odata");
        if (matches?.length) data = { node, items: matches };
      }
      // Don't attribute an unbound field/button to a bound ancestor window.
      if (node.hasAttribute("data-sap-ui")) passedControl = true;
      if (!preferences.controllers && passedControl) break;
      node = node.parentElement;
    }
    const target = data || eventTarget || controller;
    if (!target || target.node === dismissedNode) return null;
    return { node: target.node, items: [...(data?.items || []), ...(eventTarget?.items || []), ...(eventTarget ? [] : controller?.items || [])] };
  }
  function controlLabel(control) {
    // Read explicitly associated labels only, never a field value or its text.
    const nodes = new Set([safe(() => control.getFocusDomRef()), safe(() => control.getDomRef())].filter(Boolean));
    const labels = new Set();
    for (const node of nodes) {
      for (const label of node.labels || []) labels.add(label);
      for (const id of (node.getAttribute("aria-labelledby") || "").split(/\s+/)) {
        const label = document.getElementById(id);
        if (label?.matches("label,.sapMLabel,.sapUiLbl")) labels.add(label);
      }
    }
    return [...labels].map((label) => label.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ");
  }

  function sizeHoverCard(card, fixed) {
    card.style.width = `${Math.max(0, Math.min(fixed ? 560 : 460, innerWidth - 24))}px`;
    card.style.maxHeight = `${Math.max(0, Math.min(fixed ? 760 : 520, innerHeight - 24))}px`;
  }

  function fitHoverPreview(content, note, omitted) {
    const updateNote = () => { note.textContent = `${omitted ? `+${omitted} elementos · ` : ""}Alt para ver todo y copiar · Esc para cerrar`; };
    updateNote();
    // Remove whole summary rows rather than silently cutting off a section or
    // the Alt hint. Full paths, parameters and all rows remain in the pinned card.
    while (content.scrollHeight > content.clientHeight + 1) {
      const sections = [...content.querySelectorAll(".hover-section")];
      const multiple = sections.findLast((section) => section.querySelectorAll(".hover-row").length > 1);
      if (multiple) { multiple.querySelector(".hover-row:last-child").remove(); omitted++; }
      else if (sections.length) { omitted += sections.at(-1).querySelectorAll(".hover-row").length; sections.at(-1).remove(); }
      else {
        const metadata = content.querySelector(".hover-scope") || content.querySelector(".hover-id");
        if (!metadata) break;
        metadata.remove(); omitted++;
      }
      updateNote();
    }
  }

  function renderHover() {
    if (!hoverLayer) return;
    if (pinned && (!preferences.enabled || pinned.options !== inspectionOptions())) releasePinned(false);
    // Keep a pinned DOM intact: replacing it would erase the user's selection.
    if (pinned?.card?.isConnected) {
      const rect = visibleRect(pinned.node);
      pinned.outline.style.display = rect ? "block" : "none";
      if (rect) pinned.outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      sizeHoverCard(pinned.card, true);
      const box = pinned.card.getBoundingClientRect();
      pinned.card.style.left = `${Math.max(12, Math.min(box.left, innerWidth - box.width - 12))}px`;
      pinned.card.style.top = `${Math.max(12, Math.min(box.top, innerHeight - box.height - 12))}px`;
      return;
    }
    hoverLayer.replaceChildren(); activeHoverNode = null;
    if (!preferences.enabled || !inspectionEnabled()) return;
    const hovered = pinned || hoveredData();
    if (!hovered) return;
    const rect = visibleRect(hovered.node);
    if (!rect) return;
    const items = hovered.items.filter((entry) => preferences[kindOption[entry.kind]]);
    if (!items.length) return;
    activeHoverNode = hovered.node;
    const entry = items.find((item) => item.kind === "model") || items[0];
    const odata = items.some((item) => item.kind === "odata");
    const controllerItems = items.filter((item) => item.kind === "controller" || item.kind === "event");
    const eventItems = items.filter((item) => item.kind === "event");
    const controllerOnly = items.every((item) => item.kind === "controller" || item.kind === "event");
    const outline = document.createElement("div"), card = document.createElement("div");
    outline.className = `hover-outline${odata ? " odata" : controllerOnly ? " controller" : ""}`;
    outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    card.className = `hover-card${odata ? " odata" : controllerOnly ? " controller" : ""}${pinned ? " pinned" : ""}`;
    card.dataset.controlId = controlId(entry.roots[0]);
    const add = (parent, tag, className, text) => {
      const element = document.createElement(tag); element.className = className; element.textContent = text; parent.append(element); return element;
    };
    const content = add(card, "div", "hover-content", "");
    if (pinned) {
      const actions = document.createElement("div"); actions.className = "hover-actions";
      add(actions, "span", "", "Fijada · Alt o Esc");
      const copy = add(actions, "button", "hover-copy", "Copiar todo"); copy.type = "button";
      copy.addEventListener("click", async () => {
        try { await copyCard(content); copy.textContent = "Copiado"; }
        catch { copy.textContent = "Selecciona y usa Ctrl+C"; }
      });
      const close = add(actions, "button", "hover-close", "Cerrar"); close.type = "button";
      close.setAttribute("aria-label", "Cerrar inspector técnico");
      close.addEventListener("click", releaseCard);
      card.prepend(actions); card.tabIndex = -1; content.tabIndex = 0;
      card.setAttribute("role", "region"); card.setAttribute("aria-label", "Inspector técnico fijado");
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) card.addEventListener(type, (event) => event.stopPropagation());
    }
    const headings = [items.some((item) => item.kind === "model") ? "Modelos" : "", odata ? "OData" : "", controllerItems.length ? "Controladores" : ""].filter(Boolean);
    add(content, "div", "hover-heading", headings.join(headings.length === 2 ? " y " : " · "));
    const type = entry.controlType.split(".").pop(), label = controlLabel(entry.roots[0]);
    add(content, "div", "hover-name", controllerOnly && !eventItems.length ? entry.scope.split("/").pop() : label ? `${label} · ${type}` : type);
    add(content, "div", "hover-id", card.dataset.controlId);
    if (entry.scope) add(content, "div", "hover-scope", entry.scope);
    let omitted = 0;
    const previewLimit = 2;
    if (entry.bindings.length) {
      const section = add(content, "div", "hover-section", "");
      add(section, "div", "hover-section-title", "Bindings del elemento");
      for (const binding of pinned ? entry.bindings : entry.bindings.slice(0, previewLimit)) {
        const row = add(section, "div", "hover-row", "");
        add(row, "strong", "", `${binding.property} ← ${binding.model || "(por defecto)"}`);
        add(row, "code", "", binding.resolved || `${binding.path} [sin contexto]`);
        if (pinned && binding.resolved && binding.path !== binding.resolved) add(row, "code", "", `Ruta relativa: ${binding.path}`);
      }
      omitted += Math.max(0, entry.bindings.length - previewLimit);
    }
    if (entry.models.length) {
      const section = add(content, "div", "hover-section", "");
      add(section, "div", "hover-section-title", entry.bindings.length ? "Modelos asociados" : "Modelos disponibles en esta ventana");
      for (const model of pinned ? entry.models : entry.models.slice(0, previewLimit)) {
        const row = add(section, "div", "hover-row", "");
        add(row, "strong", "", `${model.label} · ${model.version || model.type.split(".").pop()}`);
        if (odata && model.odata) add(row, "code", "", model.service || "Servicio no disponible");
        if (pinned) {
          add(row, "code", "", model.type);
          if (odata && model.dataSource) add(row, "code", "", `Data source: ${model.dataSource}`);
          if (model.context) add(row, "code", "", `Contexto: ${model.context}`);
        }
      }
      omitted += Math.max(0, entry.models.length - previewLimit);
    }

    // Keep source names and paths in one shared list. Listeners outside the
    // associated controller set still retain their own source, once per module.
    const controllers = new Map();
    const controllerKey = (name, path) => `${name}|${path || ""}`;
    for (const association of controllerItems) for (const controller of association.controllers) {
      controllers.set(controllerKey(controller.name, controller.path), controller);
    }
    const handlerSources = new Set();
    for (const item of eventItems) for (const event of item.events) for (const handler of event.handlers) {
      const key = controllerKey(handler.controller, handler.path);
      handlerSources.add(key);
      if (!controllers.has(key)) controllers.set(key, { name: handler.controller, path: handler.path });
    }
    for (const item of eventItems) {
      const section = add(content, "div", "hover-section", "");
      add(section, "div", "hover-section-title", "Eventos y métodos asociados");
      for (const event of pinned ? item.events : item.events.slice(0, previewLimit)) {
        const row = add(section, "div", "hover-row", "");
        add(row, "strong", "", event.name);
        if (pinned) add(row, "code", "", `Parámetros del evento: ${event.parameters.map((param) => `${param.name}: ${param.type}`).join(", ") || "sin parámetros declarados"}`);
        for (const handler of pinned ? event.handlers : event.handlers.slice(0, 1)) {
          const owner = handlerSources.size > 1 ? `${handler.controller} · ` : "";
          add(row, "code", "", `→ ${owner}${handler.name}(${handler.arguments})`);
          if (pinned) {
            if (handler.declaration) add(row, "code", "", `XML: ${handler.declaration}`);
            add(row, "code", "", handler.resolution);
            const button = add(row, "button", "hover-copy", "Ver función en DevTools"); button.type = "button";
            button.dataset.handlerToken = handler.token;
            const status = add(row, "div", "hover-source-status", ""); status.setAttribute("role", "status");
            button.addEventListener("click", () => {
              status.textContent = "Conectando con DevTools…";
              window.postMessage({ channel: "ui5-lens:source-request", token: handler.token }, "*");
            });
          }
        }
        omitted += Math.max(0, event.handlers.length - 1);
      }
      omitted += Math.max(0, item.events.length - previewLimit);
    }
    if (controllerItems.length) {
      const section = add(content, "div", "hover-section", "");
      add(section, "div", "hover-section-title", "Controladores asociados");
      if (pinned) {
        const associations = new Set();
        for (const association of controllerItems) {
          const description = [association.association, association.scope !== entry.scope ? association.scope : "", association.ownerView ? `Vista: ${association.ownerView}` : "", !association.controllers.length ? association.controllerStatus : ""].filter(Boolean).join(" · ");
          if (description && !associations.has(description)) { add(section, "div", "hover-row", description); associations.add(description); }
        }
      }
      if (!controllers.size && !pinned) add(section, "div", "hover-row", controllerItems[0].controllerStatus);
      const sources = [...controllers.values()];
      for (const controller of pinned ? sources : sources.slice(0, 1)) {
        const row = add(section, "div", "hover-row", "");
        add(row, "strong", "", [controller.name, controller.role].filter(Boolean).join(" · "));
        if (controller.path) add(row, "code", "", controller.path);
        if (pinned && controller.pathSource) add(row, "code", "", `Ruta: ${controller.pathSource}`);
      }
      omitted += Math.max(0, sources.length - 1);
    }
    const note = add(card, "div", "hover-note", pinned ? "Ctrl+C copia la selección · Ctrl+A selecciona el contenido de esta tarjeta" : "");
    const margin = 12;
    sizeHoverCard(card, Boolean(pinned));
    hoverLayer.append(outline, card);
    if (!pinned) fitHoverPreview(content, note, omitted);
    const box = card.getBoundingClientRect();
    const anchor = !hovered.located && pointer ? pointer : { x: rect.left + Math.min(rect.width, 40), y: rect.top + Math.min(rect.height, 30) };
    let left = anchor.x + 18, top = anchor.y + 18;
    if (left + box.width > innerWidth - margin) left = anchor.x - box.width - 18;
    if (top + box.height > innerHeight - margin) top = anchor.y - box.height - 18;
    card.style.left = `${Math.max(margin, Math.min(left, innerWidth - box.width - margin))}px`;
    card.style.top = `${Math.max(margin, Math.min(top, innerHeight - box.height - margin))}px`;
    if (pinned) {
      pinned.card = card; pinned.outline = outline; pinned.content = content;
      host.removeAttribute("aria-hidden");
      content.focus({ preventScroll: true });
    }
  }
  async function copyCard(content) {
    const text = content.innerText;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch { /* HTTP apps may require the local fallback. */ }
    const textarea = document.createElement("textarea"); textarea.value = text;
    textarea.style.cssText = "position:fixed;left:-10000px;top:0";
    content.append(textarea); textarea.select();
    try { if (!document.execCommand("copy")) throw new Error("Clipboard unavailable"); }
    finally { textarea.remove(); pinned?.content?.focus({ preventScroll: true }); }
  }
  function pinHovered() {
    if (pinned || !preferences.enabled || !inspectionEnabled()) return Boolean(pinned);
    dismissedNode = null; // An explicit Alt press may reopen a card closed by Esc.
    const hovered = hoveredData();
    if (!hovered || !visibleRect(hovered.node)) return false;
    pinned = { ...hovered, options: inspectionOptions(), previousFocus: document.activeElement };
    renderHover();
    return Boolean(pinned?.card);
  }
  function releasePinned(restoreFocus = true) {
    const previous = pinned;
    pinned = null;
    host?.setAttribute("aria-hidden", "true");
    if (previous && restoreFocus && document.activeElement === host && previous.previousFocus?.isConnected) previous.previousFocus.focus({ preventScroll: true });
  }
  function queueHover() {
    if (!preferences.enabled || hoverRequest) return;
    hoverRequest = requestAnimationFrame(() => {
      hoverRequest = null;
      if (performance.now() - lastScan > 650) collect();
      renderHover();
    });
  }
  function onPointerMove(event) {
    if (event.isTrusted && Boolean(event.ctrlKey) !== discoveryActive) requestHighlights(Boolean(event.ctrlKey));
    if (pinned) return;
    if (event.pointerType === "touch" || !inspectionEnabled()) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (dismissedNode && !dismissedNode.contains(event.target)) dismissedNode = null;
    queueHover();
  }
  function onPointerOut(event) {
    if (pinned) return;
    if (!event.relatedTarget || event.relatedTarget.tagName === "IFRAME") { pointer = null; dismissedNode = null; queueHover(); }
  }
  function onBlur() {
    if (discoveryActive) requestHighlights(false);
    if (!pinned) { pointer = null; dismissedNode = null; queueHover(); }
  }
  function onVisibilityChange() { if (document.hidden) onBlur(); }
  function onKeyDown(event) {
    if (event.key === "Control" && !event.repeat) requestHighlights(true);
    if (event.key === "Escape") {
      // Consume this key sequence only while closing an inspector card. In
      // particular, held-key repeats must not leak through to a UI5 dialog.
      if (!handledEscape && !hoverLayer?.querySelector(".hover-card")) return;
      handledEscape = true;
      event.preventDefault(); event.stopImmediatePropagation();
      releaseCard();
      return;
    }
    const inCard = pinned?.card && (event.composedPath().includes(pinned.card) || pinned.card.contains(pinned.card.getRootNode().activeElement));
    if (inCard) event.stopPropagation();
    if (event.key === "Alt" && !event.repeat && !event.ctrlKey && !event.metaKey && preferences.enabled && inspectionEnabled()) {
      handledAlt = true; event.preventDefault();
      window.postMessage({ channel: "ui5-lens:hover-request", command: "toggle" }, "*");
    }
    if (inCard && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const range = document.createRange(); range.selectNodeContents(pinned.content);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
  function onKeyUp(event) {
    if (event.key === "Control") requestHighlights(Boolean(event.ctrlKey));
    if (event.key === "Escape" && handledEscape) { event.preventDefault(); event.stopImmediatePropagation(); handledEscape = false; }
    if (event.key === "Alt" && (handledAlt || pinned)) { event.preventDefault(); event.stopPropagation(); handledAlt = false; }
  }

  function schedule(rescan = false) {
    if (!preferences.enabled) return;
    if (rescan) lastScan = 0;
    if (!frameRequest) frameRequest = requestAnimationFrame(draw);
  }
  const onLayout = () => schedule();
  function setOptions(input) {
    const wasEnabled = preferences.enabled;
    preferences = H.options({ ...preferences, ...input });
    if (preferences.enabled && !wasEnabled) {
      ensureRuntime();
      const started = performance.now();
      runtimeTimer = setInterval(() => {
        ensureRuntime();
        if (hooksInstalled || performance.now() - started > 20000) clearInterval(runtimeTimer);
      }, 25);
      observer = new MutationObserver((records) => {
        if (records.some((record) => record.target !== host && !host?.contains(record.target))) schedule();
      });
      if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });
      window.addEventListener("scroll", onLayout, true);
      window.addEventListener("resize", onLayout);
      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("pointerout", onPointerOut, true);
      document.addEventListener("mousemove", onPointerMove, true);
      document.addEventListener("mouseout", onPointerOut, true);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyUp, true);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibilityChange);
      timer = setInterval(() => { if (!document.hidden) schedule(true); }, 900);
      collect();
    }
    if (!preferences.enabled) {
      observer?.disconnect(); clearInterval(timer); clearInterval(runtimeTimer); cancelAnimationFrame(frameRequest);
      cancelAnimationFrame(hoverRequest); hoverRequest = null;
      frameRequest = null;
      window.removeEventListener("scroll", onLayout, true); window.removeEventListener("resize", onLayout);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("mousemove", onPointerMove, true);
      document.removeEventListener("mouseout", onPointerOut, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (discoveryActive) requestHighlights(false);
      releasePinned(); handledAlt = false; handledEscape = false;
      pointer = null; dismissedNode = null; activeHoverNode = null;
      host?.remove(); host = null; layer = null; discoveryLayer = null; hoverLayer = null;
    } else schedule(true);
    return preferences;
  }

  function snapshot() {
    collect();
    const apps = D.applications(controls, (control) => domRoots(control).some((node) => Boolean(visibleRect(node))));
    return {
      detected: Boolean(window.sap?.ui?.getCore || window.sap?.ui?.require),
      version: window.sap?.ui?.version || "", title: document.title, url: location.href,
      options: preferences, tracking: hooksInstalled, apps,
      entries: entries.map((entry) => ({ key: entry.key, kind: entry.kind, name: entry.name, path: entry.path, source: entry.source,
        controlType: entry.controlType, scope: entry.scope, models: entry.models, bindings: entry.bindings, events: entry.events,
        scopeKind: entry.scopeKind, controllers: entry.controllers, controllerStatus: entry.controllerStatus,
        association: entry.association, ownerView: entry.ownerView, ownerViewId: entry.ownerViewId,
        ids: entry.roots.map(controlId), visible: entry.roots.flatMap(domRoots).some((node) => Boolean(visibleRect(node))) }))
    };
  }
  function focus(key) {
    const entry = entries.find((item) => item.key === key);
    if (!entry) return false;
    selected = key;
    const node = entry.roots.flatMap(domRoots)[0];
    if (!node) return false;
    node.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    schedule();
    setTimeout(() => { selected = ""; schedule(); }, 2500);
    return true;
  }
  function releaseCard() {
    if (!pinned && !hoverLayer?.querySelector(".hover-card")) return;
    dismissedNode = pinned?.node || activeHoverNode; releasePinned(); selected = ""; activeHoverNode = null; hoverLayer?.replaceChildren();
  }
  const api = Object.freeze({ snapshot, setOptions, focus, isPinned: () => Boolean(pinned), pin: pinHovered, release: releaseCard, highlightTargets });
  Object.defineProperty(window, "__UI5_TECH_LENS__", { value: api, configurable: true });
  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.channel === "ui5-lens:options") setOptions(event.data.options);
    if (event.source === window && event.data?.channel === "ui5-lens:source-result" && typeof event.data.status === "string") {
      for (const button of hoverLayer?.querySelectorAll("[data-handler-token]") || []) {
        if (button.dataset.handlerToken === event.data.token) button.nextElementSibling.textContent = event.data.status;
      }
    }
  });
  window.postMessage({ channel: "ui5-lens:ready" }, "*");
})();
