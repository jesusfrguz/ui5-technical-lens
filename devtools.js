/* Runs only while the inspected tab's DevTools are open. */
"use strict";
const SOURCES = globalThis.__UI5_TECH_LENS_SOURCES__;
const validToken = (value) => typeof value === "string" && /^h[a-f0-9]{32}_\d+$/.test(value);
let generation = 0;
const timed = (operation) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("DevTools no respondió. Vuelve a abrirlo e inténtalo otra vez.")), 10000);
  operation((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
});
async function locate(value) {
  const resources = await timed((resolve) => chrome.devtools.inspectedWindow.getResources(resolve));
  const candidates = resources.filter((resource) => /\.(?:[cm]?js)(?:[?#]|$)/i.test(resource.url) || SOURCES.sameResource(resource.url, value.url));
  const read = async (items) => Promise.all(items.map((resource) => timed((resolve) => resource.getContent((content, encoding) => resolve({ url: resource.url, content: encoding ? "" : content }))).catch(() => ({ url: resource.url, content: "" }))));
  const preferred = candidates.filter((resource) => SOURCES.sameResource(resource.url, value.url));
  const known = preferred.length ? SOURCES.locate(await read(preferred), value) : null;
  if (known && !known.error) return known;
  return SOURCES.locate(await read(candidates), value);
}
function connect() {
  const port = chrome.runtime.connect({ name: "ui5-lens-devtools" });
  const post = (message) => { try { port.postMessage(message); } catch { /* Worker reconnects for subsequent requests. */ } };
  post({ action: "connect", tabId: chrome.devtools.inspectedWindow.tabId });
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
  port.onMessage.addListener(async (message) => {
    if (message.action !== "openHandler" || !validToken(message.token)) return;
    const request = ++generation;
    try {
      const value = message.descriptor;
      if (!value || typeof value.source !== "string") throw new Error("No se encontró la función en este marco. Vuelve a señalar el control.");
      const location = await locate(value);
      if (request !== generation) return;
      if (location.error) throw new Error(location.error);
      await timed((resolve, reject) => chrome.devtools.panels.openResource(location.url, location.line, location.column, (result) => {
        const error = chrome.runtime.lastError;
        if (error || result?.isError) reject(new Error(error?.message || result.description || "DevTools no pudo abrir el recurso."));
        else resolve(true);
      }));
      if (request === generation) post({ action: "result", requestId: message.requestId,
        status: `Ubicación enviada a Sources: ${location.url.split("/").pop()} · línea ${location.line + 1}, columna ${location.column + 1}.` });
    } catch (error) {
      if (request === generation) post({ action: "result", requestId: message.requestId, status: error.message });
    }
  });
}
connect();
