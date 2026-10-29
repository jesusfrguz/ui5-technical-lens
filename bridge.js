/* Isolated world: preferences and commands; detach when an extension reload
   invalidates this content-script context while the app remains open. */
(() => {
  "use strict";
  if (globalThis.__ui5LensBridge) return;
  globalThis.__ui5LensBridge = true;
  let current, stopped = false;
  const reloadMessage = "La extensión se ha recargado. Recarga esta pestaña de la app y vuelve a abrir DevTools.";
  function available() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }
  function stop() {
    if (stopped) return;
    stopped = true; current = null;
    window.removeEventListener("message", onPageMessage);
    // Stop is terminal for an invalidated context. Do not call extension APIs
    // even to remove their listeners; Chrome owns their invalidated lifetime.
    // A pending runtime callback is harmless because it checks stopped first.
  }
  async function request(action, extra = {}) {
    try {
      if (stopped || !available()) { stop(); return { error: reloadMessage }; }
      // Put the invocation itself inside try: invalidated contexts throw
      // synchronously, before sendMessage can return a promise to .catch().
      return await chrome.runtime.sendMessage({ channel: "ui5-lens", action, ...extra });
    } catch (error) {
      const invalid = /extension context invalidated/i.test(error?.message || "") || !available();
      if (invalid) stop();
      return { error: invalid ? reloadMessage : error?.message || "No se pudo conectar con la extensión." };
    }
  }
  const send = () => {
    if (stopped || !available()) { stop(); return; }
    if (current) window.postMessage({ channel: "ui5-lens:options", options: current }, "*");
  };
  function onPageMessage(event) {
    if (event.source !== window || stopped) return;
    if (event.data?.channel === "ui5-lens:ready") send();
    if (event.data?.channel === "ui5-lens:hover-request" && event.data.command === "toggle") {
      void request("hoverCommand", { command: "toggle" });
    }
    if (event.data?.channel === "ui5-lens:highlight-request" && typeof event.data.active === "boolean") {
      void request("highlightTargets", { active: event.data.active });
    }
    if (event.data?.channel === "ui5-lens:source-request" && /^h[a-f0-9]{32}_\d+$/.test(event.data.token)) {
      const token = event.data.token;
      request("openHandler", { token }).then((result) => {
        window.postMessage({ channel: "ui5-lens:source-result", token, status: result?.error || result?.status }, "*");
      });
    }
  }
  function onRuntimeMessage(message) {
    if (stopped || !available()) { stop(); return; }
    if (message?.channel === "ui5-lens" && message.options) { current = message.options; send(); }
    if (message?.channel === "ui5-lens" && message.sourceResult) window.postMessage({ channel: "ui5-lens:source-result", ...message.sourceResult }, "*");
  }
  try {
    window.addEventListener("message", onPageMessage);
    if (!available()) { stop(); return; }
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    request("getOptions").then((value) => {
      if (!stopped && value && !value.error) { current = value; send(); }
    });
  } catch { stop(); }
})();
