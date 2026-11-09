"use strict";
const { launchExtension } = require("./browser-context.cjs"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5-updates-test-")), base = "/sap/bc/ui5_ui5/sap/zapp";
let token = "one", bootstrap = "one", metadataRequests = 0, resourceRequests = 0, pageRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (req.url.includes("ui5_app_info_json")) {
    metadataRequests++; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ "demo.app": { url: base + `/~${token}~5/` } }));
  } else if (req.url.includes("Component-preload.js")) {
    resourceRequests++; res.setHeader("Cache-Control", "public, max-age=3600"); res.setHeader("Content-Type", "application/javascript");
    res.end(`window.loadedBuild = ${JSON.stringify(req.url.includes("~one~5") ? "one" : "two")};`);
  } else {
    pageRequests++; res.setHeader("Content-Type", "text/html"); res.setHeader("Cache-Control", "no-store");
    res.end(`<!doctype html><div id="app"><h1>Launchpad mock</h1></div><script src="${base}/~${bootstrap}~5/Component-preload.js"></script>`);
  }
});
(async () => {
  let context;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context = await launchExtension(profile);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"), extensionId = new URL(worker.url()).host;
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const app = { getMetadata: () => ({ getComponentName: () => "demo.app" }),
        getRootControl: () => ({ getDomRef: () => document.getElementById("app") }),
        getManifestEntry: (key) => key === "sap.app" ? { id: "demo.app", title: "Pedidos", type: "application" } : key === "sap.platform.abap" ? { uri: "/sap/bc/ui5_ui5/sap/zapp" } : undefined };
      const Component = { registry: { all: () => ({ app }) } };
      const require = (name) => name === "sap/ui/core/Component" ? Component : undefined;
      // This prediction is deliberately different; only the requested URL counts.
      require.toUrl = () => "/sap/bc/ui5_ui5/sap/zapp/~predicted~5/Component.js";
      window.sap = { ui: { require }, ushell: { Container: {} } };
    });
    const origin = `http://127.0.0.1:${server.address().port}`, url = origin + "/sap/bc/ui2/flp?sap-client=100#App-open";
    await context.addCookies([{ name: "sap-session", value: "keep-me", url: origin }]);
    await page.goto(url);
    await page.evaluate(() => localStorage.setItem("keep", "local-data"));
    await page.waitForFunction(async () => (await window.__UI5_LENS_UPDATES__?.check())?.[0]?.state === "current");
    assert.equal(await page.evaluate(() => window.loadedBuild), "one");
    const firstResourceRequests = resourceRequests;
    // ABAP has a newer build, but the shell still requests the old URL.
    token = "two";
    await page.reload();
    await page.locator("#ui5-lens-update-notice").waitFor();
    assert.equal(resourceRequests, firstResourceRequests, "The old app really came from the HTTP cache");
    assert.equal(await page.evaluate(() => window.loadedBuild), "one");
    const loaded = await page.evaluate(() => performance.getEntriesByType("resource").find((entry) => entry.name.includes("Component-preload.js"))?.transferSize);
    assert.equal(loaded, 0, "Cached app load is represented in Resource Timing");
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, url);
    const initialLoads = pageRequests, initialChecks = metadataRequests;
    await page.clock.install();
    await page.clock.fastForward(125000);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); location.hash = "#App-open&/detail/1"; });
    await page.clock.runFor(1000);
    assert.equal(metadataRequests, initialChecks, "No minute polling, focus polling or checks for inner routes");
    assert.equal(pageRequests, initialLoads, "Detection never reloads automatically");
    const popup = await context.newPage();
    await popup.addInitScript((id) => { chrome.tabs.query = async () => [await chrome.tabs.get(id)]; }, tabId);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole("button", { name: "Recargar Launchpad sin caché", exact: true }).waitFor();
    assert.match(await popup.locator("#update-status").innerText(), /token cargado difiere/);
    assert.equal(metadataRequests, initialChecks, "Opening the popup reuses the entry check");
    await popup.getByRole("button", { name: "Comprobar cambios", exact: true }).click();
    await popup.waitForFunction(() => !document.getElementById("check-updates").disabled);
    assert.equal(metadataRequests, initialChecks + 1, "Explicit checking performs one fresh request");
    const output = path.join(__dirname, "../test-results"); fs.mkdirSync(output, { recursive: true });
    await popup.screenshot({ path: path.join(output, "updates-popup.png") });
    // Expose the isolated world's closed shadow root for the real page-button click.
    const cdp = await context.newCDPSession(page), worlds = [];
    cdp.on("Runtime.executionContextCreated", ({ context }) => worlds.push(context)); await cdp.send("Runtime.enable");
    const isolated = worlds.find((world) => world.origin === `chrome-extension://${extensionId}` || world.name === extensionId);
    assert.ok(isolated);
    await cdp.send("Runtime.evaluate", { contextId: isolated.id, expression: `
      const originalAttach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (options) { return originalAttach.call(this, { ...options, mode: 'open' }); };
      document.getElementById('ui5-lens-update-notice')?.remove();
    ` });
    await popup.getByRole("button", { name: "Comprobar cambios", exact: true }).click();
    await page.getByRole("button", { name: "Recargar Launchpad sin caché", exact: true }).waitFor();
    await popup.close();
    await page.screenshot({ path: path.join(output, "updates-notice.png") });
    bootstrap = "two";
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Recargar Launchpad sin caché", exact: true }).click()]);
    assert.equal(page.url(), origin + "/sap/bc/ui2/flp?sap-client=100#App-open&/detail/1");
    assert.equal((await context.cookies(origin)).find((cookie) => cookie.name === "sap-session").value, "keep-me");
    assert.equal(await page.evaluate(() => localStorage.getItem("keep")), "local-data");
    await page.waitForFunction(async () => (await window.__UI5_LENS_UPDATES__?.check())?.[0]?.state === "current");
    assert.equal(await page.evaluate(() => window.loadedBuild), "two");
    const checksBeforeEntry = metadataRequests;
    await page.evaluate(() => { document.getElementById("app").hidden = true; location.hash = "#Shell-home"; });
    await page.clock.runFor(1000);
    token = "three";
    await page.evaluate(() => { document.getElementById("app").hidden = false; location.hash = "#App-open"; });
    await page.clock.runFor(1000);
    await page.locator("#ui5-lens-update-notice").waitFor();
    assert.equal(metadataRequests, checksBeforeEntry + 1, "Re-entering an app whose modules stay in memory performs one comparison");
    assert.deepEqual(errors, []);
    console.log("PASS: cached stale build detected on entry, actual URLs override predictions, no polling over 125s, manual check and reload, cookies/storage/URL preserved.");
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (profile.startsWith(path.join(os.tmpdir(), "ui5-updates-test-"))) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
