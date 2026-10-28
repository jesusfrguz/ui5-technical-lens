/* Runs only while the inspected tab's DevTools are open. */
"use strict";
function connect() {
  const port = chrome.runtime.connect({ name: "ui5-lens-devtools" });
  port.postMessage({ action: "connect", tabId: chrome.devtools.inspectedWindow.tabId });
  // MV3 may suspend an idle service worker while DevTools remains open.
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
  port.onMessage.addListener((message) => {
    if (message.action !== "openHandler" || !/^h[a-f0-9]{32}_\d+$/.test(message.token)) return;
    const expression = `(() => { const fn = window.__UI5_TECH_LENS_EVENTS__?.resolve(${JSON.stringify(message.token)}); if (typeof fn !== "function") return false; inspect(fn); return true; })()`;
    chrome.devtools.inspectedWindow.eval(expression, { frameURL: message.frameURL }, (found, error) => {
      port.postMessage({ action: "result", requestId: message.requestId,
        status: !error && found ? "Función abierta en Sources, en su línea real." : "No se encontró la función. Vuelve a señalar el control; puede haberse recargado la página." });
    });
  });
}
connect();
