/* Main world: compare actual loaded URLs with fresh ABAP tokens, on app entry. */
(() => {
  "use strict";
  if (window.__UI5_LENS_UPDATES__?.version === 2) return;
  const resources = new Map(), checked = new Map(), requests = new Map();
  let lastDiscovery = "", lastEntry = "", generation = 0, scheduled;
  function resource(value) {
    try {
      if (typeof value !== "string") return null;
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^(.*?\/sap\/bc\/ui5_ui5\/[^/]+\/[^/]+)\/(~[\w.-]+~([A-Z0-9])?)(?:\/(.*))?$/i);
      if (!match) return null;
      return { base: match[1], token: match[2], aggregate: Boolean(match[3]), path: match[4] || "", url: url.href };
    } catch { return null; }
  }
  function remember(entries) {
    for (const entry of entries) {
      const item = resource(entry.name);
      if (item?.path && !item.path.startsWith("resources/")) resources.set(item.url, item);
    }
  }
  function navigation() {
    return location.pathname + (location.hash || "").split(/[?&/]/)[0];
  }
  function enter(entry) {
    if (entry !== lastEntry) { lastEntry = entry; generation++; checked.clear(); }
  }
  function targets() {
    enter(navigation());
    const apps = window.__UI5_TECH_LENS_DATA__?.applications([], (control) => Boolean(control?.getDomRef?.()?.getClientRects().length)) || [];
    const candidates = apps.filter((app) => app.bsp && !/^sap\.ushell(?:\.|$)/.test(app.id));
    const visible = candidates.filter((app) => app.score >= 100);
    const active = visible.length ? visible : window.sap?.ushell?.Container ? [] : candidates.slice(0, 1);
    return active.map((app) => {
      // Only observed requests count as loaded. require.toUrl() is a prediction.
      const loaded = [...resources.values()].filter((item) => item.base.endsWith(app.bsp.path));
      const base = loaded[0]?.base;
      const aggregates = [...new Set(loaded.filter((item) => item.aggregate).map((item) => item.token))].sort();
      const evidence = aggregates.length ? aggregates : [...new Set(loaded.map((item) => JSON.stringify([item.path, item.token])))].sort();
      return { app, loaded, base, key: JSON.stringify([generation, app.id, base, evidence]) };
    });
  }
  async function json(url) {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 4000000) throw new Error("Metadatos demasiado grandes.");
    return JSON.parse(text);
  }
  function endpoint(path, sample) {
    const url = new URL(path, location.origin);
    const client = new URL(sample.url).searchParams.get("sap-client") || new URL(location.href).searchParams.get("sap-client");
    if (client) url.searchParams.set("sap-client", client);
    return url;
  }
  async function compare({ app, loaded, base }) {
    const result = { app: app.id, title: app.title, state: "unavailable" };
    if (!base || !loaded.length) return result;
    try {
      const aggregate = loaded.filter((item) => item.aggregate);
      if (aggregate.length) {
        const prefix = base.slice(0, base.indexOf("/sap/bc/ui5_ui5/"));
        const url = endpoint(prefix + "/sap/bc/ui2/app_index/ui5_app_info_json", loaded[0]);
        url.searchParams.set("id", app.id);
        const data = (await json(url.href))?.[app.id];
        // AppInfoAdapter consumes app.url; asyncHints can also provide its URL.
        const hints = Array.isArray(data?.asyncHints?.components) ? data.asyncHints.components : [];
        const urls = [data?.url, ...hints.filter((hint) => hint.name === app.component || hint.name === app.id).map((hint) => typeof hint.url === "string" ? hint.url : hint.url?.url)];
        const tokens = urls.map(resource).filter((item) => item?.aggregate && item.base === base).map((item) => item.token);
        const unique = [...new Set(tokens)];
        if (unique.length !== 1) return result;
        return { ...result, state: aggregate.some((item) => item.token !== unique[0]) ? "changed" : aggregate.length === loaded.length ? "current" : "unavailable", loadedToken: aggregate[0].token, currentToken: unique[0] };
      }
      const index = await json(endpoint(base + "/sap-ui-cachebuster-info.json", loaded[0]).href);
      if (!index || Array.isArray(index) || typeof index !== "object") return result;
      let comparable = 0;
      for (const item of loaded) {
        const token = index[item.path];
        if (typeof token !== "string" || !/^[\w.-]+$/.test(token)) continue;
        comparable++;
        if (item.token !== `~${token}~`) return { ...result, state: "changed", loadedToken: item.token, currentToken: `~${token}~`, path: item.path };
      }
      return { ...result, state: comparable === loaded.length ? "current" : "unavailable" };
    } catch { return result; }
  }
  async function check(force = false) {
    remember(performance.getEntriesByType("resource"));
    return Promise.all(targets().map(async (target) => {
      if (!force && checked.has(target.key)) return checked.get(target.key);
      if (!requests.has(target.key)) {
        requests.set(target.key, compare(target).then((result) => { checked.set(target.key, result); return result; }).finally(() => requests.delete(target.key)));
      }
      return requests.get(target.key);
    }));
  }
  function schedule() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      remember(performance.getEntriesByType("resource"));
      const discovery = JSON.stringify([navigation(), targets().map((target) => target.key)]);
      if (discovery === lastDiscovery) return;
      lastDiscovery = discovery;
      window.postMessage({ channel: "ui5-lens:updates-request" }, "*");
    }, 500);
  }
  Object.defineProperty(window, "__UI5_LENS_UPDATES__", { value: Object.freeze({ version: 2, check }), configurable: true });
  try {
    const observer = new PerformanceObserver((list) => { remember(list.getEntries()); schedule(); });
    observer.observe({ type: "resource", buffered: true });
    // Local discovery covers late registration and components already in memory.
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    window.addEventListener("hashchange", (event) => {
      // Preserve rapid home -> app entries even if the render debounce groups them.
      try {
        const url = new URL(event.newURL || location.href);
        enter(url.pathname + url.hash.split(/[?&/]/)[0]);
      } catch { enter(navigation()); }
      schedule();
    });
    window.addEventListener("pageshow", schedule);
    schedule();
  } catch { /* Manual checks remain available on older browser surfaces. */ }
})();
