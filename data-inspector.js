/* Read runtime metadata only. Never request values, refresh a model or issue OData requests. */
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
  Object.defineProperty(window, "__UI5_TECH_LENS_DATA__", { value: Object.freeze({ inspect, applications }), configurable: true });
})();
