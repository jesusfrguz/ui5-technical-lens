"use strict";
const defaults = { enabled: false, views: true, fragments: true, models: false, odatas: false, compact: false };
const stateKey = (tabId) => `tab:${tabId}`;
// Serialize writes: popup changes and newly loaded frames must see one consistent state.
let writes = Promise.resolve();
let hoverCommands = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.channel !== "ui5-lens") return;
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  const tabId = fromExtensionPage ? message.tabId : sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
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
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(stateKey(tabId)));
