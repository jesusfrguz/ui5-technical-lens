/* Automatic inspection reads metadata only. Values are read from memory on explicit binding clicks. */
(() => {
  "use strict";
  if (window.__UI5_TECH_LENS_DATA__) return;
  const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const moduleValue = (name) => safe(() => sap.ui.require(name));
  const alias = (name) => !name || name === "undefined" ? "" : name;
  const typeOf = (value) => safe(() => value.getMetadata().getName(), "Modelo desconocido");
  const keys = (value) => value && typeof value === "object" ? Object.keys(value) : [];
  const modelNames = (value) => keys(value?.oModels).concat(keys(value?.oPropagatedProperties?.oModels)).map(alias);
  const owners = new WeakMap();
  const bundles = new WeakMap();

  function owner(control) {
    if (owners.has(control)) return owners.get(control);
    const Component = moduleValue("sap/ui/core/Component") || window.sap?.ui?.core?.Component;
    let current = control, component;
    const seen = new Set();
    while (current && !seen.has(current) && !component) {
      seen.add(current);
      component = safe(() => Component.getOwnerComponentFor(current));
      current = safe(() => current.getParent());
    }
    // Don't cache absent owners: Component propagation may still be in progress.
    if (component) owners.set(control, component);
    return component;
  }
  function configuration(component) {
    return { models: safe(() => component.getManifestEntry("/sap.ui5/models"), {}),
      sources: safe(() => component.getManifestEntry("/sap.app/dataSources"), {}) };
  }
  function serviceUrl(value) {
    if (typeof value !== "string" || !value) return "";
    return safe(() => {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol)) return "";
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return url.href;
    }, "");
  }
  function describe(model, name, component) {
    const type = typeOf(model), config = configuration(component);
    const definition = config.models?.[name] || {};
    const source = config.sources?.[definition.dataSource] || {};
    const odata = /sap\.ui\.model\.odata\.(?:(?:v2|v4)\.)?ODataModel/.test(type) ||
      safe(() => model.isA("sap.ui.model.odata.v2.ODataModel") || model.isA("sap.ui.model.odata.v4.ODataModel") || model.isA("sap.ui.model.odata.ODataModel"), false);
    return { name, label: name || "(por defecto)", type, odata,
      version: odata ? (/\.v4\./.test(type) || safe(() => model.isA("sap.ui.model.odata.v4.ODataModel"), false) ? "V4" : "V2") : "",
      service: odata ? serviceUrl(safe(() => model.getServiceUrl()) || model.sServiceUrl || source.uri) : "",
      dataSource: odata && typeof definition.dataSource === "string" ? definition.dataSource : "" };
  }

  function inspect(control, windowScope = false) {
    const component = owner(control), config = configuration(component);
    const names = new Set(["", ...modelNames(control), ...modelNames(component), ...keys(config.models).map(alias)]);
    const models = new Map(), bindings = [];
    function addModel(name, instance) {
      name = alias(name);
      const model = instance || safe(() => control.getModel(name || undefined));
      if (!model) return null;
      const result = describe(model, name, component);
      result.context = safe(() => control.getBindingContext(name || undefined)?.getPath(), "");
      result.local = Object.hasOwn(control.oModels || {}, name || "undefined");
      models.set(`${name}|${result.type}|${result.service}`, result);
      return result;
    }
    function bindingInfo(property, info, binding, inheritedName) {
      if (!info) return;
      if (Array.isArray(info.parts)) {
        const parts = safe(() => binding.getBindings(), []);
        info.parts.forEach((part, index) => bindingInfo(property, part, parts[index], info.model));
        return;
      }
      if (typeof info.path !== "string") return; // static composite parts aren't model bindings
      const name = alias(info.model ?? inheritedName);
      names.add(name);
      const instance = safe(() => binding.getModel()) || safe(() => control.getModel(name || undefined));
      const model = addModel(name, instance);
      const context = safe(() => binding.getContext()) || safe(() => control.getBindingContext(name || undefined));
      const path = safe(() => binding.getPath(), info.path);
      const resolved = safe(() => instance.resolve(path, context), path.startsWith("/") ? path : "");
      bindings.push({ property, model: name, path, resolved, context: safe(() => context.getPath(), ""),
        type: model?.type || "Modelo no disponible", odata: Boolean(model?.odata),
        service: model?.service || "", version: model?.version || "" });
    }
    const metadata = safe(() => control.getMetadata());
    const properties = new Set([...keys(safe(() => metadata.getAllProperties())), ...keys(safe(() => metadata.getAllAggregations())), ...keys(control.mBindingInfos)]);
    for (const property of properties) {
      const info = safe(() => control.getBindingInfo(property));
      if (info) bindingInfo(property, info, safe(() => control.getBinding(property)));
    }
    for (const name of names) {
      const binding = safe(() => control.getObjectBinding(name || undefined)) || safe(() => control.getElementBinding(name || undefined));
      if (binding) bindingInfo("contexto", { path: safe(() => binding.getPath(), ""), model: name }, binding);
      // Windows show models available through inheritance. Ordinary controls only
      // show bindings or models assigned locally, so unbound fields stay unmarked.
      if (windowScope || modelNames({ oModels: control.oModels }).includes(name)) addModel(name);
    }
    return { models: [...models.values()], bindings };
  }

  // Build bounded plain text without invoking getters or toJSON on business data.
  function valueText(value) {
    let remaining = 2000, characters = 80000;
    const ancestors = new WeakSet();
    function snapshot(item, depth) {
      if (--remaining < 0 || characters <= 0) return "[Límite de tamaño]";
      if (item === undefined) return "[No disponible en memoria]";
      if (typeof item === "string") {
        const result = item.slice(0, Math.min(10000, characters));
        characters -= result.length;
        return result.length < item.length ? `${result}… [Texto recortado]` : result;
      }
      if (item === null || typeof item === "boolean" || typeof item === "number") return item;
      if (typeof item === "bigint") return String(item);
      if (typeof item !== "object") return `[${typeof item}]`;
      try { return Number.isFinite(Date.prototype.getTime.call(item)) ? Date.prototype.toISOString.call(item) : "[Fecha no válida]"; }
      catch { /* Not a Date; traverse its data properties below. */ }
      if (ancestors.has(item)) return "[Referencia circular]";
      if (depth >= 10) return "[Límite de profundidad]";
      ancestors.add(item);
      const result = Array.isArray(item) ? [] : Object.create(null);
      let count = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (remaining <= 0 || characters <= 0 || count++ >= 500) {
          if (Array.isArray(result)) result.push("[Límite de tamaño]");
          else result["…"] = "[Límite de tamaño]";
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        const label = key.slice(0, Math.min(500, Math.max(0, characters)));
        characters -= label.length;
        const child = descriptor && Object.hasOwn(descriptor, "value") ? snapshot(descriptor.value, depth + 1) : "[Accessor no leído]";
        if (Array.isArray(result)) result.push(child); else result[label] = child;
      }
      ancestors.delete(item);
      return result;
    }
    return safe(() => JSON.stringify(snapshot(value, 0), null, 2), "[No se pudo representar el valor]");
  }

  function readBinding(control, descriptor) {
    const unavailable = { status: "El binding ya no está disponible o ha cambiado. Cierra la tarjeta y vuelve a inspeccionar el elemento." };
    if (!control || safe(() => control.isDestroyed(), control.bIsDestroyed || false)) return unavailable;
    let match;
    function find(info, binding, inheritedName) {
      if (!info) return;
      if (Array.isArray(info.parts)) {
        const parts = safe(() => binding.getBindings(), []);
        info.parts.forEach((part, index) => find(part, parts[index], info.model));
      } else if (info.path === descriptor.path && alias(info.model ?? inheritedName) === descriptor.model) match = { info, binding };
    }
    if (descriptor.property === "contexto") {
      const binding = safe(() => control.getObjectBinding(descriptor.model || undefined)) || safe(() => control.getElementBinding(descriptor.model || undefined));
      if (binding) find({ path: safe(() => binding.getPath()), model: descriptor.model }, binding);
    } else find(safe(() => control.getBindingInfo(descriptor.property)), safe(() => control.getBinding(descriptor.property)));
    if (!match) return unavailable;
    const binding = match.binding;
    const model = safe(() => binding.getModel()) || safe(() => control.getModel(descriptor.model || undefined));
    if (!model) return { status: "Modelo no disponible." };
    const context = safe(() => binding.getContext()) || safe(() => control.getBindingContext(descriptor.model || undefined));
    const path = safe(() => binding.getPath(), match.info.path);
    const resolved = safe(() => model.resolve(path, context), path.startsWith("/") ? path : "");
    if (resolved !== descriptor.resolved || typeOf(model) !== descriptor.type) return unavailable;
    const isType = (name) => typeOf(model) === name || safe(() => model.isA(name), false);
    const v4 = isType("sap.ui.model.odata.v4.ODataModel");
    const json = isType("sap.ui.model.json.JSONModel");
    const v2 = isType("sap.ui.model.odata.v2.ODataModel") || isType("sap.ui.model.odata.ODataModel");
    const read = (fn) => { try { return fn(); } catch { return undefined; } };
    const segments = (value) => value === "/" || value === "" ? [] : value.replace(/^\//, "").split("/");
    let value, data, scope = "Valor del binding disponible en memoria";
    let focusPath = resolved ? segments(resolved) : null;
    if (v4) {
      // V4 exposes cached data through contexts, not through Model.getProperty.
      const bound = safe(() => binding.getBoundContext()) || context;
      value = descriptor.property === "contexto" ? read(() => bound.getObject()) : read(() => binding.getValue());
      if (value === undefined && resolved && context) value = read(() => context.getObject(path));
      data = read(() => bound.getObject());
      const base = safe(() => bound.getPath(), "");
      focusPath = base && resolved === base ? [] : base && resolved.startsWith(`${base}/`) ? segments(resolved.slice(base.length + 1)) : null;
      scope = `Contexto OData V4 en memoria${base ? ` · ${base}` : ""}`;
      if (data === undefined && typeof binding?.getCurrentContexts === "function") {
        data = read(() => binding.getCurrentContexts().slice(0, 100).map((item) => item?.getObject()));
        scope = "Contextos OData V4 cargados (máximo 100)";
        focusPath = resolved ? [] : null;
      }
    } else if (json || v2 || isType("sap.ui.model.xml.XMLModel") || isType("sap.ui.model.resource.ResourceModel")) {
      if (resolved) value = read(() => model.getProperty(path, context));
      if (json) { data = read(() => model.getData()); scope = "Datos del modelo JSON en memoria"; }
      else if (v2) { data = read(() => model.getProperty("/")); scope = "Datos OData V2 en memoria (pueden estar incompletos)"; }
      else { data = value; focusPath = resolved ? [] : null; }
    } else {
      return { status: "Este tipo de modelo no ofrece una lectura de valores en memoria compatible.", type: typeOf(model) };
    }
    return { type: typeOf(model), path: resolved || path, scope, value: valueText(value), data: valueText(data), focusPath: data === undefined ? null : focusPath,
      status: "Instantánea local al abrir · Solo datos ya cargados · Los valores grandes se recortan" };
  }

  function translatedTitle(component, value) {
    if (typeof value !== "string" || !value.trim()) return "";
    if (!/\{\{.+?\}\}/.test(value)) return value;
    for (const name of new Set(["i18n", ...modelNames(component)])) {
      const model = safe(() => component.getModel(name || undefined));
      if (!model || !/ResourceModel$/.test(typeOf(model))) continue;
      let bundle = bundles.get(model) || safe(() => model.getResourceBundle());
      if (bundle?.then) {
        if (!bundles.has(model)) {
          bundles.set(model, bundle);
          bundle.then((resolved) => { bundles.set(model, resolved); }, () => { bundles.delete(model); });
        }
        continue;
      }
      if (typeof bundle?.getText !== "function") continue;
      const translated = value.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, key) => safe(() => bundle.getText(key), ""));
      if (translated && !/\{\{/.test(translated)) return translated;
    }
    return "";
  }
  function applications(controls, isVisible) {
    const Component = moduleValue("sap/ui/core/Component") || window.sap?.ui?.core?.Component;
    const registry = Component?.registry || moduleValue("sap/ui/core/ComponentRegistry");
    const components = new Set(Object.values(safe(() => registry.all(), {})));
    const visibility = new Map();
    for (const control of controls) {
      const component = owner(control) || safe(() => control.getComponentInstance());
      if (component) {
        components.add(component);
        if (!visibility.has(component) && isVisible(control)) visibility.set(component, true);
      }
    }
    const result = [];
    for (const component of components) {
      const app = safe(() => component.getManifestEntry("sap.app"), {});
      const componentName = safe(() => component.getMetadata().getComponentName()) || typeOf(component).replace(/\.Component$/, "");
      const id = app.id || componentName;
      if (!id) continue;
      const root = safe(() => component.getRootControl());
      const visible = visibility.has(component) || (root && isVisible(root));
      const title = translatedTitle(component, app.title);
      const shell = /^sap\.(ushell|ui|m)(\.|$)/.test(id);
      result.push({ id, title: title || id, component: componentName, titleResolved: Boolean(title),
        score: (visible ? 100 : 0) + (app.type === "application" ? 30 : 0) + (title ? 10 : 0) - (shell ? 200 : 0) });
    }
    return result.sort((a, b) => b.score - a.score);
  }
  Object.defineProperty(window, "__UI5_TECH_LENS_DATA__", { value: Object.freeze({ inspect, applications, readBinding }), configurable: true });
})();
