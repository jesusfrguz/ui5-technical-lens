"use strict";
const defaults = { enabled: false, views: true, fragments: true, models: false, odatas: false, controllers: false, compact: false };
const stateKey = (tabId) => `tab:${tabId}`;
// Serialize writes: popup changes and newly loaded frames must see one consistent state.
let writes = Promise.resolve();
let hoverCommands = Promise.resolve();
const devtools = new Map();
const validToken = (value) => typeof value === "string" && /^h[a-f0-9]{32}_\d+$/.test(value);
async function sourceRequest(tabId, token, frameId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN",
    func: (id) => window.__UI5_TECH_LENS_EVENTS__?.describe(id) || null, args: [token] });
  const descriptor = results[0]?.result;
  if (!descriptor?.source) throw new Error("La función ya no está disponible. Actualiza la inspección.");
  return { action: "openHandler", token, requestId: token, descriptor };
}
function sourceResult(tabId, token, status) {
  const result = { channel: "ui5-lens", tabId, sourceResult: { token, status: String(status).slice(0, 300) } };
  chrome.tabs.sendMessage(tabId, result).catch(() => {});
  chrome.runtime.sendMessage(result).catch(() => {});
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ui5-lens-devtools" || !port.sender?.url?.startsWith(chrome.runtime.getURL("devtools.html"))) return;
  let tabId;
  port.onMessage.addListener(async (message) => {
    if (message.action === "connect" && Number.isInteger(message.tabId)) {
      tabId = message.tabId; devtools.set(tabId, port);
      const key = `source:${tabId}`, stored = await chrome.storage.session.get(key);
      if (stored[key]) {
        await chrome.storage.session.remove(key);
        try { port.postMessage(await sourceRequest(tabId, stored[key].token, stored[key].frameId)); }
        catch (error) { sourceResult(tabId, stored[key].token, error.message); }
      }
    } else if (message.action === "result" && Number.isInteger(tabId) && validToken(message.requestId)) {
      sourceResult(tabId, message.requestId, message.status);
    }
  });
  port.onDisconnect.addListener(() => { if (devtools.get(tabId) === port) devtools.delete(tabId); });
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.channel !== "ui5-lens") return;
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  const tabId = fromExtensionPage ? message.tabId : sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
  if (message.action === "openHandler" && validToken(message.token)) {
    (async () => {
      const frameId = fromExtensionPage ? message.frameId : sender.frameId;
      if (!Number.isInteger(frameId)) throw new Error("Marco no válido");
      // Read the live function from the exact frame ID, including identical-URL iframes.
      const request = await sourceRequest(tabId, message.token, frameId);
      const port = devtools.get(tabId);
      if (port) { port.postMessage(request); reply({ status: "Abriendo la función en Sources…" }); }
      else {
        await chrome.storage.session.set({ [`source:${tabId}`]: { token: message.token, frameId } });
        reply({ status: "Abre DevTools con F12 o Ctrl+Mayús+I. Se abrirá la última función solicitada." });
      }
    })().catch((error) => reply({ error: error.message }));
    return true;
  }
  if (message.action === "hoverCommand" && sender.tab && message.command === "toggle") {
    hoverCommands = hoverCommands.catch(() => {}).then(async () => {
      // Query the live frames, so pinning still works after service-worker restarts
      // and when keyboard focus and the inspected field are in different frames.
      const states = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: () => Boolean(window.__UI5_TECH_LENS__?.isPinned?.()) });
      const release = states.some((state) => state.result);
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: (release) => {
        const lens = window.__UI5_TECH_LENS__;
        if (release) lens?.release?.(); else lens?.pin?.();
      }, args: [release] });
      reply(true);
    }).catch(() => reply(false));
    return true;
  }
  if (message.action === "getOptions") {
    writes.then(() => chrome.storage.session.get(stateKey(tabId)))
      .then((data) => reply(data[stateKey(tabId)] || defaults)).catch(() => reply(defaults));
    return true;
  }
  if (message.action === "setOptions" && fromExtensionPage) {
    writes = writes.catch(() => {}).then(async () => {
      const data = await chrome.storage.session.get(stateKey(tabId));
      const next = { ...defaults, ...data[stateKey(tabId)] };
      for (const key of Object.keys(defaults)) {
        if (typeof message.options?.[key] === "boolean") next[key] = message.options[key];
      }
      await chrome.storage.session.set({ [stateKey(tabId)]: next });
      await chrome.action.setBadgeText({ tabId, text: next.enabled ? "ON" : "" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#087e8b" });
      try { await chrome.tabs.sendMessage(tabId, { channel: "ui5-lens", options: next }); } catch { /* A new frame reads saved state on startup. */ }
      reply(next);
    }).catch((error) => reply({ error: error.message }));
    return true;
  }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove([stateKey(tabId), `source:${tabId}`]));
