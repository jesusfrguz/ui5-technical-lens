"use strict";
const path = require("node:path");
// Keep the downloaded browser with this checkout instead of a shared Windows
// cache. An explicit PLAYWRIGHT_BROWSERS_PATH still takes precedence.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(__dirname, "../node_modules/.cache/ms-playwright");
const { chromium } = require("playwright");

async function launchExtension(profile, options = {}) {
  const extensionRoot = path.resolve(process.env.UI5_TEST_EXTENSION_DIR || path.join(__dirname, ".."));
  const channel = process.env.UI5_TEST_BROWSER || "chromium";
  const context = await chromium.launchPersistentContext(profile, {
    ...options,
    channel,
    executablePath: process.env.UI5_TEST_EXECUTABLE_PATH || undefined,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", ...(options.args || [])]
  });
  try {
    // Match manual unpacked installation in this test-only profile. Without
    // Developer mode, Chrome can disable the extension on runtime.reload().
    const settings = await context.newPage();
    try {
      await settings.goto("chrome://extensions/");
      await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      const configuration = await settings.evaluate(() => chrome.developerPrivate.getProfileConfiguration());
      if (!configuration.inDeveloperMode) throw new Error("Developer mode is required in the isolated browser test profile.");
    } finally { await settings.close(); }
    // CDP also supports branded Chrome/Edge, which removed --load-extension.
    const session = await context.browser().newBrowserCDPSession();
    try { await session.send("Extensions.loadUnpacked", { path: extensionRoot }); }
    finally { await session.detach(); }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    console.log(`Browser: ${channel} ${context.browser().version()} · extension ${manifest.version} · ${extensionRoot}`);
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

module.exports = { launchExtension };
