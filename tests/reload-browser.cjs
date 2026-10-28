"use strict";
const { chromium } = require("playwright"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const root = path.resolve(__dirname, ".."), profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5-reload-test-"));
const server = http.createServer((request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><h1>Extension reload regression</h1>"); });
(async () => {
  let context;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context = await chromium.launchPersistentContext(profile, { channel: process.env.UI5_TEST_BROWSER || "chromium", headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = context.pages()[0], exceptions = [];
    const cdp = await context.newCDPSession(page); await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text));
    page.on("pageerror", (error) => exceptions.push(error.message));
    await page.addInitScript(() => { window.__sourceReplies = []; window.addEventListener("message", (event) => {
      if (event.source === window && event.data?.channel === "ui5-lens:source-result") window.__sourceReplies.push(event.data);
    }); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => Boolean(window.__UI5_TECH_LENS__));
    const token = `h${"a".repeat(32)}_9999`;
    const sendSource = () => page.evaluate((token) => window.postMessage({ channel: "ui5-lens:source-request", token }, "*"), token);
    await sendSource();
    await page.waitForFunction(() => window.__sourceReplies.some((reply) => reply.status?.includes("La función ya no está disponible")));
    const nextWorker = context.waitForEvent("serviceworker", { predicate: (next) => next !== worker, timeout: 20000 });
    await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); return true; });
    await nextWorker;
    await page.evaluate(() => { window.__sourceReplies = []; });
    await sendSource();
    await page.evaluate(() => {
      window.postMessage({ channel: "ui5-lens:hover-request", command: "toggle" }, "*");
      window.postMessage({ channel: "ui5-lens:ready" }, "*");
    });
    // Invalidated bridges either report reload guidance or have already been
    // removed by the browser. Neither may emit an uncaught context exception.
    await page.waitForTimeout(300);
    const afterReload = await page.evaluate(() => window.__sourceReplies);
    if (afterReload.length) assert.ok(afterReload.every((reply) => reply.status?.includes("Recarga esta pestaña")));
    assert.deepEqual(exceptions, []);
    await page.reload(); await page.waitForFunction(() => Boolean(window.__UI5_TECH_LENS__));
    await sendSource();
    await page.waitForFunction(() => window.__sourceReplies.some((reply) => reply.status?.includes("La función ya no está disponible")));
    assert.deepEqual(exceptions, []);
    console.log("PASS: extension runtime reload with the app open, stale Alt/source/ready messages, no uncaught errors and live bridge after page reload.");
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (profile.startsWith(path.join(os.tmpdir(), "ui5-reload-test-"))) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
