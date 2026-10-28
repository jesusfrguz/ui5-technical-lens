/* Controller identity and logical resource paths; never load or instantiate code. */
(() => {
  "use strict";
  if (window.__UI5_TECH_LENS_CONTROLLERS__) return;
  const H = window.__UI5_TECH_LENS_CORE__;
  const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const isView = (value) => safe(() => value.isA("sap.ui.core.mvc.View"), false);
  const generic = (name) => !name || name === "sap.ui.core.mvc.Controller" || name === "sap.ui.core.mvc.ControllerExtension" || name.startsWith("sap.ui.base.");
  function closestView(control) {
    const seen = new Set();
    while (control && !seen.has(control)) {
      if (isView(control)) return control;
      seen.add(control); control = safe(() => control.getParent());
    }
    return null;
  }
  function declaredName(view) {
    return safe(() => view.getControllerName()) || safe(() => view._xContent.getAttribute("controllerName")) || "";
  }
  function resource(name, role, Class) {
    const conventional = H.controllerPath(name);
    const modules = [conventional.replace(/\.js$/, "")];
    if (!name.startsWith("module:")) modules.push(name.replace(/\./g, "/"));
    for (const module of modules) {
      const exported = safe(() => window.sap.ui.require(module));
      if (Class && exported === Class) return { path: `${module}.js`, pathSource: "módulo cargado" };
    }
    return { path: role === "extensión" && !name.startsWith("module:") ? `${name.replace(/\./g, "/")}.js` : conventional, pathSource: "convención UI5" };
  }
  function context(entry) {
    let view, controller, association;
    if (entry.kind === "view") {
      view = entry.roots[0]; controller = safe(() => view.getController()); association = "controlador de la vista";
    } else if (entry.controllerKnown) {
      controller = entry.controller; view = safe(() => controller.getView()) || entry.containingView;
      association = "recibido al crear el fragmento";
    } else {
      view = closestView(entry.containingView) || entry.roots.map(closestView).find(Boolean);
      controller = safe(() => view.getController()); association = "vista contenedora";
    }
    return { view, controller, association };
  }
  function inspect(entry) {
    const { view, controller, association } = context(entry);
    const controllers = [], seenNames = new Set();
    function add(name, role, Class) {
      if (typeof name !== "string" || generic(name) || seenNames.has(name)) return;
      seenNames.add(name); controllers.push({ name, role, ...resource(name, role, Class) });
    }
    let metadata = safe(() => controller.getMetadata());
    const seenMetadata = new Set();
    let role = "principal";
    while (metadata && !seenMetadata.has(metadata)) {
      seenMetadata.add(metadata);
      const name = safe(() => metadata.getName());
      if (generic(name)) break;
      add(name, role, safe(() => metadata.getClass()) || (role === "principal" ? controller.constructor : null));
      role = "base"; metadata = safe(() => metadata.getParent());
    }
    if (controller && !controllers.length && safe(() => controller.getMetadata())) add(declaredName(view), "principal", controller.constructor);
    // Optional UI5 runtime extensions. This internal map is read defensively.
    for (const extension of Object.values(controller?._sapui_Extensions || {})) {
      const value = extension?.extension;
      add(safe(() => value.getMetadata().getName()) || extension?.namespace, "extensión", safe(() => value.getMetadata().getClass()) || value?.constructor);
    }
    const status = controllers.length ? "identificado" : controller ? "Objeto de eventos sin nombre técnico recuperable" : "Sin controlador asociado";
    return { controllers, controllerStatus: status, association,
      ownerView: safe(() => view.getViewName(), ""), ownerViewId: safe(() => view.getId(), "") };
  }
  Object.defineProperty(window, "__UI5_TECH_LENS_CONTROLLERS__", { value: Object.freeze({ inspect, context }), configurable: true });
})();
