/* Isolated world: validated boolean preferences and the pin-toggle command. */
(() => {
  "use strict";
  if (globalThis.__ui5LensBridge) return;
  globalThis.__ui5LensBridge = true;
  let current;
  const send = () => {
    if (current) window.postMessage({ channel: "ui5-lens:options", options: current }, "*");
  };
  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.channel === "ui5-lens:ready") send();
    if (event.source === window && event.data?.channel === "ui5-lens:hover-request" && event.data.command === "toggle") {
      chrome.runtime.sendMessage({ channel: "ui5-lens", action: "hoverCommand", command: event.data.command }).catch(() => {});
    }
    if (event.source === window && event.data?.channel === "ui5-lens:source-request" && /^h[a-f0-9]{32}_\d+$/.test(event.data.token)) {
      const token = event.data.token;
      chrome.runtime.sendMessage({ channel: "ui5-lens", action: "openHandler", token }).then((result) => {
        window.postMessage({ channel: "ui5-lens:source-result", token, status: result?.error || result?.status }, "*");
      }).catch(() => window.postMessage({ channel: "ui5-lens:source-result", token, status: "Recarga la página y la extensión para conectar DevTools." }, "*"));
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.channel === "ui5-lens" && message.options) { current = message.options; send(); }
    if (message?.channel === "ui5-lens" && message.sourceResult) window.postMessage({ channel: "ui5-lens:source-result", ...message.sourceResult }, "*");
  });
  chrome.runtime.sendMessage({ channel: "ui5-lens", action: "getOptions" })
    .then((value) => { current = value; send(); }).catch(() => {});
})();
