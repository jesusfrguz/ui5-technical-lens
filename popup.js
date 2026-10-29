"use strict";
const $ = (id) => document.getElementById(id);
let tabId, tabTitle = "", frames = [], rows = [], options = {}, busy = false, updating = false;
let renderedInventory = "";
const optionKeys = ["enabled", "views", "fragments", "models", "odatas", "controllers", "compact"];
const kindOption = { view: "views", fragment: "fragments", model: "models", odata: "odatas", controller: "controllers", event: "controllers" };
const kindLetter = { view: "V", fragment: "F", model: "M", odata: "O", controller: "C", event: "E" };
function message(text, error = false) { $("message").textContent = text; $("message").className = error ? "error" : ""; }
async function background(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ channel: "ui5-lens", action, tabId, ...extra });
  if (response?.error) throw new Error(response.error);
  return response;
}
async function inject() {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: ["core.js", "data-inspector.js", "controller-inspector.js", "event-inspector.js", "inspector.js"] });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["bridge.js"] });
}
async function inspect() {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: "MAIN",
    func: (settings) => {
      const lens = window.__UI5_TECH_LENS__;
      if (!lens) return null;
      lens.setOptions(settings);
      return lens.snapshot();
    }, args: [options]
  });
  frames = results.filter((item) => item.result?.detected);
  rows = frames.flatMap(({ frameId, result }) => result.entries.map((entry) => ({ ...entry, frameId })));
  const app = frames.flatMap((frame) => frame.result.apps).sort((a, b) => b.score - a.score)[0];
  const main = frames.find((frame) => frame.frameId === 0) || frames[0];
  $("status-dot").classList.toggle("detected", frames.length > 0);
  $("runtime").textContent = main ? `SAPUI5 ${main.result.version || "detectado"}${frames.length > 1 ? ` · ${frames.length} marcos` : ""}` : "SAPUI5 no detectado";
  $("app-title").textContent = (app?.titleResolved ? app.title : tabTitle || main?.result.title || app?.title) || "Aplicación actual";
  $("app-title").title = $("app-title").textContent;
  $("app-id").textContent = app?.id ? `App: ${app.id}` : "";
  $("app-component").textContent = app?.component && app.component !== app.id ? `Componente: ${app.component}` : "";
  $("reload").disabled = !frames.length;
  if (!frames.length) message("Abre una aplicación SAPUI5/OpenUI5 y actualiza la detección. Si todavía está cargando, espera unos segundos.");
  else if (options.enabled) message(options.models || options.odatas || options.controllers ? "Señala un elemento y pulsa Alt para fijar su tarjeta y copiar. Alt o Esc la cierran por separado." : "Etiquetas activas · V: vistas · F: fragmentos.");
  else message("Superposición desactivada. Actívala para identificar los elementos.");
  render();
}
function render() {
  const query = $("search").value.trim().toLowerCase();
  const filtered = rows.filter((entry) => options[kindOption[entry.kind]] &&
    `${entry.name} ${entry.path} ${entry.ids.join(" ")} ${entry.scope || ""} ${JSON.stringify(entry.models || [])} ${JSON.stringify(entry.controllers || [])} ${JSON.stringify(entry.events || [])}`.toLowerCase().includes(query));
  const signature = JSON.stringify(filtered);
  if (signature === renderedInventory) return;
  renderedInventory = signature;
  $("count").textContent = filtered.length;
  $("visible-count").textContent = `${filtered.filter((entry) => entry.visible).length} en pantalla`;
  const container = $("inventory"), scrollTop = container.scrollTop; container.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "empty";
    empty.textContent = query ? "Ningún elemento coincide con la búsqueda." : "No hay elementos detectados con los filtros actuales.";
    container.append(empty); return;
  }
  for (const entry of filtered) {
    const item = document.createElement("div"), badge = document.createElement("span"), body = document.createElement("div");
    item.className = `file${entry.visible ? "" : " inactive"}`;
    badge.className = `key ${entry.kind}`; badge.textContent = kindLetter[entry.kind];
    body.className = "file-body";
    const name = document.createElement("div"), path = document.createElement("div"), meta = document.createElement("div");
    const dataEntry = entry.kind === "model" || entry.kind === "odata";
    name.className = "file-name"; name.textContent = entry.kind === "controller" ? `${entry.scope.split("/").pop()} → controlador` : dataEntry || entry.kind === "event" ? `${entry.controlType.split(".").pop()} · ${entry.ids[0]}` : entry.path.split("/").pop();
    path.className = "file-path"; path.textContent = entry.path;
    meta.className = "file-meta"; meta.textContent = `${entry.visible ? "Visible" : "Fuera de pantalla / sin DOM"} · ${entry.source}${entry.frameId ? ` · iframe ${entry.frameId}` : ""}`;
    body.title = entry.ids.join("\n"); body.append(name, path, meta);
    if (entry.kind === "event") {
      const details = document.createElement("details"), summary = document.createElement("summary"), info = document.createElement("div");
      summary.textContent = "Eventos, parámetros y métodos asociados"; info.className = "binding-details";
      for (const event of entry.events) {
        const title = document.createElement("div");
        title.textContent = `${event.name}\nParámetros del evento: ${event.parameters.map((param) => `${param.name}: ${param.type}`).join(", ") || "sin parámetros declarados"}`;
        info.append(title);
        for (const handler of event.handlers) {
          const text = document.createElement("p"), button = document.createElement("button"), status = document.createElement("div");
          text.textContent = `${handler.controller} · ${handler.name}(${handler.arguments})\n${handler.path}\n${handler.declaration ? `XML: ${handler.declaration}\n` : ""}${handler.resolution}`;
          button.textContent = "Ver función en DevTools"; button.type = "button"; button.dataset.handlerToken = handler.token;
          status.setAttribute("role", "status");
          button.addEventListener("click", async () => {
            try { const response = await background("openHandler", { token: handler.token, frameId: entry.frameId }); status.textContent = response.status; }
            catch (error) { status.textContent = error.message; }
          });
          info.append(text, button, status);
        }
      }
      details.append(summary, info); body.append(details);
    }
    if (entry.kind === "controller") {
      const details = document.createElement("details"), summary = document.createElement("summary"), info = document.createElement("div");
      summary.textContent = "Controladores asociados"; info.className = "binding-details";
      info.textContent = [`Vista / fragmento: ${entry.scope}`, `Asociación: ${entry.association}`, entry.ownerView ? `Vista: ${entry.ownerView}` : "",
        ...entry.controllers.map((controller) => `${controller.name} · ${controller.role}\n${controller.path}\nRuta: ${controller.pathSource}`), entry.controllers.length ? "" : entry.controllerStatus].filter(Boolean).join("\n\n");
      details.append(summary, info); body.append(details);
    }
    if (dataEntry) {
      const details = document.createElement("details"), summary = document.createElement("summary"), info = document.createElement("div");
      summary.textContent = "Modelos y bindings"; info.className = "binding-details";
      info.textContent = [...(entry.scope ? [`Vista / fragmento: ${entry.scope}`] : []),
        ...entry.models.map((model) => `${model.label} · ${model.type}${model.version ? ` · ${model.version}` : ""}${model.dataSource ? ` · ${model.dataSource}` : ""}${model.service ? `\nServicio: ${model.service}` : ""}${model.context ? `\nContexto: ${model.context}` : ""}`),
        ...entry.bindings.map((binding) => `${binding.property}: ${binding.model || "(por defecto)"}>${binding.path}\nRuta resuelta: ${binding.resolved || "pendiente de contexto"}`)].join("\n\n");
      details.append(summary, info); body.append(details);
    }
    const actions = document.createElement("div"); actions.className = "file-actions";
    const focus = document.createElement("button"), copy = document.createElement("button");
    focus.textContent = "◎"; focus.title = "Localizar en la app"; focus.setAttribute("aria-label", `Localizar ${entry.path}`);
    focus.addEventListener("click", () => locate(entry).catch(showError));
    copy.textContent = "⧉"; copy.title = "Copiar ruta técnica"; copy.setAttribute("aria-label", `Copiar ${entry.path}`);
    copy.addEventListener("click", () => navigator.clipboard.writeText(entry.path).then(() => message(`Ruta copiada: ${entry.path}`)).catch(showError));
    actions.append(focus, copy); item.append(badge, body, actions); container.append(item);
  }
  container.scrollTop = scrollTop;
}
async function locate(entry) {
  options = await background("setOptions", { options: { enabled: true, [kindOption[entry.kind]]: true } });
  syncOptions();
  const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [entry.frameId] }, world: "MAIN", func: (key, settings) => {
    window.__UI5_TECH_LENS__?.setOptions(settings);
    return window.__UI5_TECH_LENS__?.focus(key);
  }, args: [entry.key, options] });
  message(result[0]?.result ? "Elemento resaltado en amarillo durante unos segundos." : "El control no tiene DOM visible. Abre su pestaña o diálogo en la app y actualiza.");
}
function syncOptions() { for (const key of optionKeys) $(key).checked = Boolean(options[key]); }
chrome.runtime.onMessage.addListener((message) => {
  if (message?.channel !== "ui5-lens" || message.tabId !== tabId || !message.sourceResult) return;
  for (const button of document.querySelectorAll("[data-handler-token]")) if (button.dataset.handlerToken === message.sourceResult.token) button.nextElementSibling.textContent = message.sourceResult.status;
});
function showError(error) { message(`No se pudo inspeccionar esta pestaña. ${error.message || error}`, true); }
async function refresh() {
  if (busy) return; busy = true; $("refresh").disabled = true;
  try { await inspect(); } finally { busy = false; $("refresh").disabled = false; }
}
for (const key of optionKeys) $(key).addEventListener("change", async () => {
  const value = $(key).checked;
  updating = true;
  for (const name of optionKeys) $(name).disabled = true;
  try {
    options = await background("setOptions", { options: { [key]: value } });
    syncOptions(); await refresh();
  } catch (error) { syncOptions(); showError(error); }
  finally { updating = false; for (const name of optionKeys) $(name).disabled = false; }
});
$("search").addEventListener("input", render);
$("refresh").addEventListener("click", () => refresh().catch(showError));
$("reload").addEventListener("click", async () => {
  try {
    await background("setOptions", { options: { enabled: true } });
    await chrome.tabs.reload(tabId); window.close();
  } catch (error) { showError(error); }
});
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    tabTitle = tab?.title || "";
    $("app-title").textContent = tabTitle || "Aplicación actual";
    if (!tabId || !/^https?:/.test(tab.url || "")) {
      throw new Error("Abre una app en HTTP/HTTPS; Chrome bloquea las extensiones en sus páginas internas y en la tienda.");
    }
    $("app-url").textContent = tab.url; $("app-url").title = tab.url;
    options = await background("getOptions"); syncOptions();
    await inject(); await refresh();
    // Resolve components/titles that become available after UI5 startup.
    setInterval(() => { if (!busy && !updating) refresh().catch(showError); }, 2000);
  } catch (error) { for (const key of optionKeys) $(key).disabled = true; $("reload").disabled = true; $("runtime").textContent = "Pestaña no disponible"; showError(error); }
})();
