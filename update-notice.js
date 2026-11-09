/* Isolated world, top frame only: results from app-entry checks and manual reload. */
(() => {
  "use strict";
  if (window !== window.top || globalThis.__ui5LensUpdateNotice) return;
  globalThis.__ui5LensUpdateNotice = true;
  let stopped = false, host, displayed = "";
  function stop() {
    stopped = true; host?.remove();
  }
  function show(response) {
    if (stopped) return;
    try {
      if (!chrome.runtime?.id) { stop(); return; }
      const changed = response?.updates?.filter((item) => item.state === "changed") || [];
      if (!changed.length) { host?.remove(); host = null; return; }
      const signature = JSON.stringify(changed);
      if (host?.isConnected && displayed === signature) return;
      host?.remove(); displayed = signature;
      host = document.createElement("div");
      host.id = "ui5-lens-update-notice";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = ":host{all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;max-width:min(420px,calc(100vw - 24px))!important}section{font:14px/1.5 Segoe UI,system-ui,sans-serif;background:#fff8df;color:#493900;padding:16px;border:1px solid #c29420;border-radius:10px;box-shadow:0 4px 20px #0003}p{margin:6px 0 12px}button{font:inherit;background:#173247;color:white;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}button:focus-visible{outline:3px solid #087e8b;outline-offset:3px}";
      const section = document.createElement("section"); section.setAttribute("role", "status");
      const title = document.createElement("strong"); title.textContent = "Hay una versión diferente disponible";
      const text = document.createElement("p");
      text.textContent = `${changed.map((item) => item.title || item.app).join(", ")}. Guarda los cambios pendientes antes de recargar todo el Launchpad.`;
      const button = document.createElement("button"); button.type = "button"; button.textContent = "Recargar Launchpad sin caché";
      button.addEventListener("click", async (event) => {
        if (!event.isTrusted || stopped) return;
        button.disabled = true;
        try {
          const result = await chrome.runtime.sendMessage({ channel: "ui5-lens", action: "reloadLaunchpad" });
          if (result?.error) throw new Error(result.error);
        } catch { text.textContent = "No se pudo recargar. Reabre la extensión y vuelve a intentarlo."; button.disabled = false; }
      });
      section.append(title, text, button); shadow.append(style, section); document.documentElement.append(host);
    } catch (error) {
      if (/extension context invalidated/i.test(error?.message || "")) stop();
      else try { if (!chrome.runtime?.id) stop(); } catch { stop(); }
    }
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.channel === "ui5-lens" && Array.isArray(message.updates)) show(message);
  });
})();
