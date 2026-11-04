"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { chromium } = require("playwright"), server = require("../tools/serve.cjs");
const root = path.resolve(__dirname, "..");
const extensionRoot = path.resolve(process.env.UI5_TEST_EXTENSION_DIR || root);
const output = path.join(root, "test-results"); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5-lens-test-"));
(async () => {
  let context, completed = false;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { channel: process.env.UI5_TEST_BROWSER || "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`], viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || await context.newPage();
    // Simulate deployment metadata without changing the demo's local paths.
    await context.route("**/manifest.json*", async (route) => {
      const response = await route.fetch();
      const manifest = await response.json();
      if (manifest["sap.app"]?.id === "demo") manifest["sap.platform.abap"] = { uri: "/sap/bc/ui5_ui5/sap/zlens_demo/" };
      await route.fulfill({ response, json: manifest });
    });
    await page.addInitScript(() => {
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (options) {
        const shadow = original.call(this, options);
        if (this.id === "ui5-technical-lens-overlay") window.__testLensShadow = shadow;
        return shadow;
      };
    });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.log("Page error:", error.message); });
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const tabId = tabs[0].id;
    const enabled = { enabled: true, views: true, fragments: true, compact: false };
    await worker.evaluate(({ tabId, enabled }) => chrome.storage.session.set({ [`tab:${tabId}`]: { ...enabled, enabled: false } }), { tabId, enabled });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Abrir diálogo" }).waitFor({ timeout: 45000 });
    assert.equal(await page.locator("#ui5-technical-lens-overlay").count(), 0, "Passive capture leaves the overlay off");
    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.getByRole("dialog").waitFor();
    const activationPopup = await context.newPage();
    await activationPopup.addInitScript((id) => { chrome.tabs.query = async () => [await chrome.tabs.get(id)]; }, tabId);
    await activationPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await activationPopup.waitForFunction(() => document.getElementById("app-id").textContent === "App: demo");
    assert.equal(await activationPopup.locator("#enabled").isChecked(), false);
    await activationPopup.locator("#enabled").check();
    await page.waitForFunction(() => {
      const shadow = window.__testLensShadow;
      return [...(shadow?.querySelectorAll(".box.fragment .tag") || [])].some((node) => node.textContent.includes("OrderDialog.fragment.xml"));
    });
    assert.ok(await page.getByRole("dialog").isVisible(), "Enabling labels identifies an already-open fragment without reopening it");
    await page.evaluate(() => {
      window.__testPlaneAllows = (plane, x, y) => {
        const clip = getComputedStyle(plane).clipPath;
        if (clip === "none") return true;
        if (!clip.startsWith('path("')) return false;
        return document.createElement("canvas").getContext("2d").isPointInPath(new Path2D(clip.slice(6, -2)), x, y);
      };
    });
    assert.ok(await page.evaluate(() => {
      const shadow = window.__testLensShadow, dialog = document.querySelector('[data-sap-ui-popup][id$="--orderDialog"]');
      const rect = dialog.getBoundingClientRect(), background = shadow.querySelector(".box.view").parentElement;
      const foreground = [...shadow.querySelectorAll(".box.fragment")].find((box) => box.dataset.source.endsWith("OrderDialog.fragment.xml")).parentElement;
      return !window.__testPlaneAllows(background, rect.left + rect.width / 2, rect.top + rect.height / 2) && window.__testPlaneAllows(background, 10, 10)
        && window.__testPlaneAllows(foreground, rect.left + 20, rect.top + 20) && foreground.dataset.popupId === dialog.id;
    }), "Popup clips background labels/outlines but retains its own label and the visible background");
    await page.screenshot({ path: path.join(output, "fragment-open-before-activation.png") });
    await activationPopup.locator("#models").check();
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().options.models);
    await page.bringToFront(); await page.keyboard.down("Control");
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".discovery-outline"));
    assert.ok(await page.evaluate(() => {
      const shadow = window.__testLensShadow, rect = document.querySelector('[data-sap-ui-popup][id$="--orderDialog"]').getBoundingClientRect();
      const outlines = [...shadow.querySelectorAll(".discovery-outline")];
      const background = outlines.find((node) => node.parentElement.dataset.popupId === "")?.parentElement;
      const foreground = outlines.find((node) => node.dataset.targetId.endsWith("--dialogCustomerField"))?.parentElement;
      return background && foreground && !window.__testPlaneAllows(background, rect.left + 20, rect.top + 20) && window.__testPlaneAllows(foreground, rect.left + 20, rect.top + 20);
    }), "Ctrl outlines respect the same popup stacking as file labels");
    await page.keyboard.up("Control"); await activationPopup.locator("#models").uncheck();
    await page.waitForFunction(() => !window.__UI5_TECH_LENS__.snapshot().options.models);
    // A second, overlapping popup also masks annotations belonging to the lower one.
    await page.evaluate(async () => {
      const dialog = await sap.ui.require("sap/ui/core/Fragment").load({ name: "demo.fragment.OrderDialog", id: "stacked" });
      window.__testStackedDialog = dialog;
      dialog.setTitle("Popup superior").setContentWidth("320px").setContentHeight("120px");
      await new Promise((resolve) => { dialog.attachAfterOpen(resolve); dialog.open(); });
    });
    await page.waitForFunction(() => {
      const shadow = window.__testLensShadow, upper = document.getElementById("stacked--orderDialog").getBoundingClientRect();
      const planes = [...shadow.querySelectorAll(".annotation-plane")], lower = planes.find((plane) => plane.dataset.popupId.endsWith("--orderDialog") && plane.dataset.popupId !== "stacked--orderDialog");
      const top = planes.find((plane) => plane.dataset.popupId === "stacked--orderDialog");
      return lower && top && !window.__testPlaneAllows(lower, upper.left + 20, upper.top + 20) && window.__testPlaneAllows(top, upper.left + 20, upper.top + 20);
    });
    await page.screenshot({ path: path.join(output, "stacked-popup-labels.png") });
    await page.evaluate(() => { window.__testStackedDialog.getDomRef().style.transform = "translateX(90px)"; });
    await page.waitForFunction(() => {
      const rect = document.getElementById("stacked--orderDialog").getBoundingClientRect();
      const background = window.__testLensShadow.querySelector(".box.view").parentElement;
      return !window.__testPlaneAllows(background, rect.right - 5, rect.top + rect.height / 2);
    });
    await page.evaluate(() => new Promise((resolve) => {
      window.__testStackedDialog.attachAfterClose(() => { window.__testStackedDialog.destroy(); delete window.__testStackedDialog; resolve(); });
      window.__testStackedDialog.close();
    }));
    await page.waitForFunction(() => [...window.__testLensShadow.querySelectorAll(".annotation-plane")].some((plane) => plane.dataset.popupId.endsWith("--orderDialog") && getComputedStyle(plane).clipPath === "none"));
    await activationPopup.close(); await page.bringToFront();
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => [...window.__testLensShadow.querySelectorAll(".box")].every((box) => getComputedStyle(box.parentElement).clipPath === "none"));
    await page.waitForFunction(() => window.__UI5_TECH_LENS__?.snapshot().entries.some((entry) => entry.path === "demo/fragment/Stats.fragment.xml"), null, { timeout: 30000 });
    const snapshot = () => page.evaluate(() => window.__UI5_TECH_LENS__.snapshot());
    let state = await snapshot();
    assert.match(state.version, /^1\.120\./);
    assert.ok(state.apps.some((app) => app.id === "demo"), "Component manifest identifies current app");
    for (const resource of ["demo/view/Main.view.xml", "demo/fragment/Summary.fragment.xml", "demo/fragment/Badge.fragment.xml", "demo/fragment/Stats.fragment.xml"]) {
      assert.ok(state.entries.some((entry) => entry.path === resource && entry.visible), resource);
    }
    assert.equal(state.entries.find((entry) => entry.path.endsWith("Stats.fragment.xml")).ids.length, 2, "Multi-root fragment");
    assert.equal(await page.locator("#ui5-technical-lens-overlay").evaluate((node) => getComputedStyle(node).pointerEvents), "none");
    await page.waitForFunction(() => window.__testLensShadow?.querySelectorAll(".box").length === 5);
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector(".tag").getBoundingClientRect().width > 0));
    await page.screenshot({ path: path.join(output, "app-overlay.png"), fullPage: true });

    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().entries.some((entry) => entry.path.endsWith("OrderDialog.fragment.xml") && entry.visible));
    await page.screenshot({ path: path.join(output, "dialog-overlay.png") });
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal((await snapshot()).entries.find((entry) => entry.path.endsWith("OrderDialog.fragment.xml")).visible, false);
    await page.evaluate(async () => {
      const [Popover, Text] = await new Promise((resolve) => sap.ui.require(["sap/m/Popover", "sap/m/Text"], (...modules) => resolve(modules)));
      const anchor = Object.values(sap.ui.require("sap/ui/core/Element").registry.all()).find((control) => control.getId().endsWith("--openDialog"));
      window.__testPopover = new Popover("occlusion-popover", { title: "Popover", placement: "Bottom", contentWidth: "320px", content: [new Text({ text: "Las etiquetas de fondo deben quedar detrás" })] });
      await new Promise((resolve) => { window.__testPopover.attachAfterOpen(resolve); window.__testPopover.openBy(anchor); });
    });
    await page.waitForFunction(() => {
      const rect = document.getElementById("occlusion-popover").getBoundingClientRect(), plane = window.__testLensShadow.querySelector(".box.view").parentElement;
      return !window.__testPlaneAllows(plane, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    await page.evaluate(() => new Promise((resolve) => {
      window.__testPopover.attachAfterClose(() => { window.__testPopover.destroy(); delete window.__testPopover; resolve(); }); window.__testPopover.close();
    }));
    await page.getByRole("button", { name: "Cargar una segunda vista" }).click();
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().entries.some((entry) => entry.path.endsWith("Details.view.xml")));

    // Cross-origin frame: the extension must inspect the frame independently.
    const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame.url().startsWith(url.replace("127.0.0.1", "localhost")) });
    await page.evaluate((frameUrl) => {
      const frame = document.createElement("iframe"); frame.src = frameUrl;
      frame.style.cssText = "width:700px;height:400px;position:fixed;bottom:0;right:0;z-index:20";
      document.body.append(frame);
    }, url.replace("127.0.0.1", "localhost"));
    const frame = await navigated;
    await frame.getByRole("button", { name: "Abrir diálogo" }).waitFor({ timeout: 90000 });
    await frame.waitForFunction(() => window.__UI5_TECH_LENS__?.snapshot().entries.some((entry) => entry.kind === "fragment"));

    // A popup opened as a test tab uses the real APIs; only active-tab lookup is
    // pinned to the app because the test tab itself would otherwise become active.
    const popup = await context.newPage();
    popup.on("pageerror", (error) => errors.push(error.message));
    await popup.addInitScript((id) => { chrome.tabs.query = async () => [await chrome.tabs.get(id)]; }, tabId);
    await popup.setViewportSize({ width: 440, height: 780 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => document.getElementById("app-id").textContent === "App: demo");
    assert.equal(await popup.locator("#app-title").textContent(), "Pedidos · Demo Technical Lens", "Translated app title on popup open");
    assert.equal(await popup.locator("#app-service").textContent(), "Servicio BSP/SICF: ZLENS_DEMO");
    assert.equal(await popup.locator("#app-service-path").textContent(), "/sap/bc/ui5_ui5/sap/zlens_demo");
    await popup.getByText("demo/fragment/Summary.fragment.xml", { exact: true }).first().waitFor();
    assert.ok((await popup.locator("#runtime").textContent()).includes("2 marcos"));
    await popup.screenshot({ path: path.join(output, "popup.png"), fullPage: true });
    await popup.locator("#search").fill("OrderDialog");
    assert.equal(await popup.locator(".file").count(), 1);
    await popup.locator("#search").fill("");
    await popup.locator("#controllers").check();
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().entries.some((entry) => entry.kind === "controller"));
    let controllerState = await snapshot();
    const mainController = controllerState.entries.find((entry) => entry.kind === "controller" && entry.scope === "demo/view/Main.view.xml");
    assert.equal(mainController.controllers[0].name, "demo.controller.Main");
    assert.equal(mainController.controllers[0].path, "demo/controller/Main.controller.js");
    const customerEvents = controllerState.entries.find((entry) => entry.kind === "event" && entry.ids[0].endsWith("--customerField"));
    assert.ok(customerEvents.events.some((event) => event.name === "valueHelpRequest" && event.handlers[0].name === "onCustomerValueHelp"));
    const changeEvent = customerEvents.events.find((event) => event.name === "change");
    assert.ok(changeEvent.parameters.some((param) => param.name === "value" && param.type === "string"), JSON.stringify(changeEvent));
    assert.equal(changeEvent.handlers[0].arguments, "oEvent");
    const detailsEvent = controllerState.entries.find((entry) => entry.kind === "event" && entry.ids[0].endsWith("--loadDetails")).events.find((event) => event.name === "press");
    assert.equal(detailsEvent.handlers[0].declaration, ".onLoadDetails(…)");
    assert.equal(await page.evaluate((token) => {
      const view = Object.values(sap.ui.require("sap/ui/core/Element").registry.all()).find((control) => control.isA("sap.ui.core.mvc.View") && control.getViewName() === "demo.view.Main");
      return window.__UI5_TECH_LENS_EVENTS__.resolve(token) === view.getController().onLoadDetails;
    }, detailsEvent.handlers[0].token), true, "Parameterized XML resolves to the real application method");
    const cdp = await context.newCDPSession(page), scripts = new Map();
    cdp.on("Debugger.scriptParsed", (script) => scripts.set(script.scriptId, script.url));
    await cdp.send("Runtime.enable"); await cdp.send("Debugger.enable");
    const resolved = await cdp.send("Runtime.evaluate", { expression: `window.__UI5_TECH_LENS_EVENTS__.resolve(${JSON.stringify(detailsEvent.handlers[0].token)})` });
    const properties = await cdp.send("Runtime.getProperties", { objectId: resolved.result.objectId });
    const functionLocation = properties.internalProperties.find((property) => property.name === "[[FunctionLocation]]").value.value;
    assert.ok(scripts.get(functionLocation.scriptId).endsWith("/controller/Main.controller.js"));
    const actualLine = fs.readFileSync(path.join(root, "demo/controller/Main.controller.js"), "utf8").split(/\r?\n/)[functionLocation.lineNumber];
    assert.ok(actualLine.includes("onLoadDetails"), `Exact handler line: ${functionLocation.lineNumber + 1}`);
    console.log(`Source navigation verified: Main.controller.js:${functionLocation.lineNumber + 1}`);
    for (const scope of ["Summary", "Badge", "Stats", "OrderDialog"]) {
      const entry = controllerState.entries.find((item) => item.kind === "controller" && item.scope === `demo/fragment/${scope}.fragment.xml`);
      assert.ok(entry, scope);
      assert.equal(entry.controllers[0]?.name, "demo.controller.Main", `Controller of ${scope}`);
    }
    const detailsController = controllerState.entries.find((entry) => entry.kind === "controller" && entry.scope === "demo/view/Details.view.xml");
    assert.equal(detailsController.controllers.length, 0, "A controllerless child view doesn't inherit the outer controller");
    assert.equal(detailsController.controllerStatus, "Sin controlador asociado");
    await page.evaluate(async () => {
      const Fragment = sap.ui.require("sap/ui/core/Fragment");
      window.__anonymousHandlerFragment = await Fragment.load({ name: "demo.fragment.Badge", id: "anonymous-handler", controller: {} });
    });
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().entries.some((entry) => entry.kind === "controller" && entry.ids[0] === "anonymous-handler--badge"));
    const anonymousController = (await snapshot()).entries.find((entry) => entry.kind === "controller" && entry.ids[0] === "anonymous-handler--badge");
    assert.equal(anonymousController.controllers.length, 0);
    assert.ok(anonymousController.controllerStatus.includes("Objeto de eventos"));
    await page.evaluate(() => window.__anonymousHandlerFragment.destroy());
    await popup.locator("#search").fill("Main.controller.js");
    assert.ok(await popup.locator(".file .controller").count() >= 5);
    await popup.locator("#search").fill("");
    await popup.locator("#views").uncheck(); await popup.locator("#fragments").uncheck();
    await page.locator("iframe").evaluate((node) => { node.style.width = "350px"; node.style.height = "250px"; });
    await page.bringToFront();
    await page.locator('[id$="--customerField-inner"]').hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-heading")?.textContent === "Controladores");
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent.includes("demo/controller/Main.controller.js")));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await page.keyboard.press("Control+a");
    assert.ok((await page.evaluate(() => window.getSelection().toString())).includes("demo/controller/Main.controller.js"));
    await page.screenshot({ path: path.join(output, "controllers-inspector.png") });
    const sourceButton = await page.evaluate(() => {
      const button = window.__testLensShadow.querySelector("[data-handler-token]"); button.scrollIntoView({ block: "center" });
      const box = button.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, token: button.dataset.handlerToken };
    });
    await page.mouse.click(sourceButton.x, sourceButton.y);
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-source-status")?.textContent.includes("F12"));
    const queued = await worker.evaluate((tabId) => chrome.storage.session.get(`source:${tabId}`), tabId);
    assert.equal(queued[`source:${tabId}`].token, sourceButton.token);
    // Verify popup/card messaging against actual loaded script sources; the
    // separate devtools-browser test checks the native Sources cursor as well.
    const devtoolsPage = await context.newPage();
    const openedLocations = [];
    await devtoolsPage.exposeBinding("__testResources", () => [...new Set(scripts.values())]);
    await devtoolsPage.exposeBinding("__testResourceContent", async (_, url) => {
      const scriptId = [...scripts].find(([, scriptURL]) => scriptURL === url)?.[0];
      return scriptId ? (await cdp.send("Debugger.getScriptSource", { scriptId })).scriptSource : "";
    });
    await devtoolsPage.exposeBinding("__testOpenResource", (_, location) => { openedLocations.push(location); });
    await devtoolsPage.addInitScript((id) => {
      chrome.devtools = { inspectedWindow: { tabId: id,
        getResources: (callback) => window.__testResources().then((urls) => callback(urls.map((url) => ({ url, getContent: (callback) => window.__testResourceContent(url).then((source) => callback(source, "")) })))) },
        panels: { openResource: (url, line, column, callback) => window.__testOpenResource({ url, line, column }).then(() => callback()) } };
    }, tabId);
    await devtoolsPage.goto(`chrome-extension://${extensionId}/devtools.html`);
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-source-status")?.textContent.includes("Ubicación enviada"));
    assert.ok(openedLocations.at(-1)?.url.endsWith("/controller/Main.controller.js"));
    assert.ok(fs.readFileSync(path.join(root, "demo/controller/Main.controller.js"), "utf8").split(/\r?\n/)[openedLocations.at(-1).line].includes("onCustomerChange"));
    assert.equal(await page.getByRole("dialog").count(), 0, "Inspecting valueHelpRequest doesn't open the app dialog");
    await popup.locator("#search").fill("onLoadDetails");
    const popupEvent = popup.locator(".file").filter({ has: popup.locator(".key.event") }).first();
    await popupEvent.locator("summary").click();
    await popupEvent.getByRole("button", { name: "Ver función en DevTools" }).click();
    await popup.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes("Ubicación enviada")));
    assert.ok(openedLocations.length >= 2, "Popup and pinned card both navigate through the real background connection");
    assert.ok(fs.readFileSync(path.join(root, "demo/controller/Main.controller.js"), "utf8").split(/\r?\n/)[openedLocations.at(-1).line].includes("onLoadDetails"));
    const invalidSource = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ channel: "ui5-lens", action: "openHandler", tabId, frameId: 0, token: `h${"a".repeat(32)}_99999` }), tabId);
    assert.ok(invalidSource.error.includes("no está disponible"));
    await popup.locator("#search").fill("");
    await page.bringToFront();
    await page.evaluate(() => { document.querySelector("iframe").style.visibility = "hidden"; window.__testLensShadow.querySelector(".hover-content").scrollTop = 0; });
    await page.screenshot({ path: path.join(output, "events-inspector.png") });
    await page.locator("iframe").evaluate((node) => { node.style.visibility = "visible"; });
    await devtoolsPage.close(); await cdp.detach();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    await popup.locator("#models").check();
    await page.bringToFront(); await page.locator('[id$="--customerField-inner"]').hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-heading")?.textContent === "Modelos y Controladores");
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent.includes("demo/controller/Main.controller.js")));
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent.includes("CustomerName")));
    assert.equal(await page.evaluate(() => window.__testLensShadow.querySelectorAll(".hover-card").length), 1);

    // Combined summaries must keep the Alt hint and whole rows visible, including
    // in a small frame. Pinning retains all details and keeps actions accessible.
    await popup.locator("#odatas").check();
    await page.locator("iframe").evaluate((node) => { node.style.visibility = "hidden"; });
    await page.bringToFront();
    await page.waitForFunction(() => document.hasFocus());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.down("Control");
    await page.waitForFunction(() => window.__testLensShadow.querySelectorAll('.discovery-outline[data-target-id$="--customerField"]').length === 3);
    const discoveries = await page.evaluate(() => [...window.__testLensShadow.querySelectorAll(".discovery-outline")].map((node) => ({
      id: node.dataset.targetId, kind: node.dataset.kind, color: getComputedStyle(node).outlineColor,
      offset: getComputedStyle(node).outlineOffset, borderWidth: getComputedStyle(node).borderWidth, pointerEvents: getComputedStyle(node).pointerEvents
    })));
    const customerOutlines = discoveries.filter((node) => node.id.endsWith("--customerField"));
    assert.deepEqual(customerOutlines.map((node) => node.kind).sort(), ["controller", "model", "odata"]);
    assert.deepEqual(customerOutlines.map((node) => node.color).sort(), ["rgb(17, 131, 94)", "rgb(175, 88, 13)", "rgb(86, 86, 184)"].sort());
    assert.equal(new Set(customerOutlines.map((node) => node.offset)).size, 3, "Each active flag has a separate ring");
    assert.ok(discoveries.every((node) => node.pointerEvents === "none"), "Ctrl outlines let app interactions through");
    assert.ok(discoveries.every((node) => node.borderWidth === "0px"), "Only the intended colored outline is drawn");
    assert.ok(discoveries.some((node) => node.id.endsWith("--noteField") && node.kind === "model"));
    assert.ok(!discoveries.some((node) => node.id.endsWith("--noteField") && node.kind === "odata"), "A JSON field is not marked as OData");
    await page.mouse.move(12, 80);
    await page.screenshot({ path: path.join(output, "ctrl-targets.png") });
    await page.evaluate(() => window.__UI5_TECH_LENS__.setOptions({ odatas: false }));
    await page.waitForFunction(() => !window.__testLensShadow.querySelector(".discovery-outline.odata") && window.__testLensShadow.querySelector(".discovery-outline.model"));
    await page.evaluate(() => window.__UI5_TECH_LENS__.setOptions({ odatas: true }));
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".discovery-outline.odata"));
    await page.keyboard.up("Control");
    await page.waitForFunction(() => !window.__testLensShadow.querySelector(".discovery-outline"));
    await page.keyboard.down("Control");
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".discovery-outline"));
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForFunction(() => !window.__testLensShadow.querySelector(".discovery-outline"));
    await page.keyboard.up("Control");
    await page.keyboard.down("Control");
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".discovery-outline"));
    await page.evaluate(() => window.__UI5_TECH_LENS__.setOptions({ enabled: false }));
    await page.locator("#ui5-technical-lens-overlay").waitFor({ state: "detached" });
    await page.keyboard.up("Control");
    await page.evaluate(() => window.__UI5_TECH_LENS__.setOptions({ enabled: true }));
    await page.waitForFunction(() => window.__testLensShadow?.host.isConnected && !window.__testLensShadow.querySelector(".discovery-outline"));
    for (const viewport of [{ width: 1280, height: 900 }, { width: 640, height: 480 }, { width: 360, height: 300 }]) {
      await page.setViewportSize(viewport);
      await page.locator('[id$="--customerField-inner"]').hover();
      await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-heading")?.textContent === "Modelos · OData · Controladores");
      const preview = await page.evaluate(() => {
        const card = window.__testLensShadow.querySelector(".hover-card"), box = card.getBoundingClientRect();
        const content = card.querySelector(".hover-content"), note = card.querySelector(".hover-note").getBoundingClientRect();
        return { inViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          hintVisible: note.top >= box.top && note.bottom <= box.bottom && note.top >= content.getBoundingClientRect().bottom,
          rowsVisible: [...content.querySelectorAll(".hover-row")].every((row) => row.getBoundingClientRect().bottom <= content.getBoundingClientRect().bottom + 1),
          title: card.querySelector(".hover-name").textContent, text: card.textContent };
      });
      assert.ok(preview.inViewport && preview.hintVisible && preview.rowsVisible, `Complete preview rows and Alt hint at ${viewport.width}×${viewport.height}: ${JSON.stringify(preview)}`);
      assert.ok(preview.title.includes("Cliente · OData V2") && preview.title.endsWith("Input"), "Uses the associated label in the control title");
      assert.ok(!preview.text.includes("Cliente demo"), "Preview doesn't read the field value");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('[id$="--customerField-inner"]').hover();
    await page.screenshot({ path: path.join(output, "review-hover-combined.png") });
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    const combined = await page.evaluate(() => window.__testLensShadow.querySelector(".hover-content").innerText);
    for (const detail of ["CustomerName", "editable", "ordersService", "onCustomerChange", "onCustomerValueHelp", "Parámetros del evento", "Eventos y métodos asociados"]) assert.ok(combined.includes(detail), detail);
    assert.equal(combined.split("demo/controller/Main.controller.js").length - 1, 1, "A shared controller resource is listed once");
    await page.screenshot({ path: path.join(output, "review-alt-combined.png") });
    await page.setViewportSize({ width: 360, height: 300 });
    await page.keyboard.press("End");
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-content").scrollTop > 0);
    const pinnedLayout = await page.evaluate(() => {
      const card = window.__testLensShadow.querySelector(".hover-card.pinned"), content = card.querySelector(".hover-content");
      const box = card.getBoundingClientRect(), actions = card.querySelector(".hover-actions").getBoundingClientRect(), note = card.querySelector(".hover-note").getBoundingClientRect();
      return { scrolling: content.scrollTop > 0, actionsVisible: actions.top >= box.top && actions.bottom <= box.bottom,
        noteVisible: note.top >= box.top && note.bottom <= box.bottom, inViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
    });
    assert.ok(pinnedLayout.scrolling && pinnedLayout.actionsVisible && pinnedLayout.noteVisible && pinnedLayout.inViewport, JSON.stringify(pinnedLayout));
    await page.screenshot({ path: path.join(output, "review-alt-small.png") });
    const fixedCopy = await page.evaluate(() => { const b = window.__testLensShadow.querySelector(".hover-actions .hover-copy").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await page.mouse.click(fixedCopy.x, fixedCopy.y);
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-actions .hover-copy").textContent === "Copiado");
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("onCustomerValueHelp"), "Fixed copy action includes scrolled-out content");
    const closeCard = await page.evaluate(() => { const b = window.__testLensShadow.querySelector(".hover-close").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await page.mouse.click(closeCard.x, closeCard.y);
    await page.waitForFunction(() => !window.__testLensShadow.querySelector(".hover-card"));
    assert.equal(await page.evaluate(() => window.__UI5_TECH_LENS__.isPinned()), false, "Close button releases the inspector");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("iframe").evaluate((node) => { node.style.visibility = "visible"; });
    await popup.locator("#odatas").uncheck();
    await popup.locator("#models").uncheck();
    await popup.locator("#controllers").uncheck();
    await page.waitForFunction(() => !window.__UI5_TECH_LENS__.snapshot().entries.some((entry) => entry.kind === "controller"));
    await popup.locator("#views").check(); await popup.locator("#fragments").check();
    await popup.locator("#fragments").uncheck();
    await popup.waitForFunction(() => !document.querySelector(".file .fragment"));
    assert.equal((await snapshot()).options.fragments, false);
    await popup.locator("#fragments").check();
    await popup.locator("#models").check();
    await popup.locator("#odatas").check();
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().entries.some((entry) => entry.kind === "odata" && entry.ids[0].endsWith("--productField")));
    const dataState = await snapshot();
    const customer = dataState.entries.find((entry) => entry.kind === "odata" && entry.ids[0].endsWith("--customerField"));
    assert.ok(customer, "V2 field OData entry");
    assert.equal(customer.bindings.find((binding) => binding.property === "value").resolved, "/Orders('4500001234')/CustomerName");
    assert.equal(customer.models[0].version, "V2");
    assert.equal(customer.models[0].dataSource, "ordersService");
    assert.match(customer.models[0].service, /\/odata\/v2\/?$/);
    const product = dataState.entries.find((entry) => entry.kind === "odata" && entry.ids[0].endsWith("--productField"));
    assert.equal(product.models[0].version, "V4");
    assert.equal(product.bindings[0].resolved, "/Products('P1')/Name");
    const note = dataState.entries.find((entry) => entry.kind === "model" && entry.ids[0].endsWith("--noteField"));
    assert.equal(note.bindings[0].model, "");
    assert.equal(note.bindings[0].resolved, "/note");
    const composite = dataState.entries.find((entry) => entry.kind === "model" && entry.ids[0].endsWith("--compositeField"));
    assert.ok(composite.bindings.some((binding) => binding.model === "ui"));
    assert.ok(composite.bindings.some((binding) => binding.model === ""));
    const viewModels = dataState.entries.find((entry) => entry.kind === "model" && entry.ids[0].endsWith("---main"));
    assert.ok(viewModels.models.some((model) => model.name === "sales"));
    assert.ok(viewModels.models.some((model) => model.name === "ui"));
    assert.ok(!JSON.stringify(dataState).includes("Entrega por la mañana"), "Inspects bindings without serializing field values");
    // After the app's metadata/data reads settle, introspection must not add requests.
    const dataLoaded = () => document.querySelector('[id$="--customerField-inner"]')?.value === "Cliente demo" && document.querySelector('[id$="--productField-inner"]')?.value === "Equipo de oficina";
    await page.waitForFunction(dataLoaded);
    await frame.waitForFunction(dataLoaded);
    let inspectionRequests = 0;
    const countRequest = (request) => { if (request.url().includes("/odata/")) inspectionRequests++; };
    page.on("request", countRequest);
    await snapshot(); await snapshot();
    assert.equal(inspectionRequests, 0, "Inspection doesn't fetch OData");
    page.off("request", countRequest);
    await popup.locator("#search").fill("customerField");
    assert.ok(await popup.locator(".file .odata").count() > 0);
    assert.ok((await popup.locator(".file-name").allTextContents()).every((name) => name.toLowerCase().includes("customerfield")));
    await popup.locator("#search").fill("");
    await popup.screenshot({ path: path.join(output, "popup-models.png"), fullPage: true });
    await popup.locator("#views").uncheck(); await popup.locator("#fragments").uncheck();
    await page.bringToFront();
    await page.locator("iframe").evaluate((node) => { node.style.width = "350px"; node.style.height = "250px"; });
    await page.getByRole("button", { name: "Abrir diálogo" }).hover();
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    assert.equal(await page.evaluate(() => window.__testLensShadow.querySelectorAll(".box.model,.box.odata").length), 0, "No persistent data labels");
    const customerField = page.locator('[id$="--customerField-inner"]');
    await customerField.hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card")?.dataset.controlId.endsWith("--customerField"));
    let cardText = await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent);
    assert.ok(cardText.includes("Modelos y OData"));
    assert.ok(cardText.includes("/Orders('4500001234')/CustomerName"));
    assert.ok(cardText.includes("/odata/v2"));
    assert.ok(cardText.includes("editable"));
    assert.equal(await page.evaluate(() => window.__testLensShadow.querySelectorAll(".hover-card").length), 1, "One card for nearest control");
    assert.ok(await page.evaluate(() => { const rect = window.__testLensShadow.querySelector(".hover-card").getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }));
    await page.screenshot({ path: path.join(output, "models-overlay.png") });
    // Pin without any application click, then enter the card and select/copy text.
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await page.evaluate(() => { window.__testPinnedCard = window.__testLensShadow.querySelector(".hover-card.pinned"); });
    const pinBox = await page.evaluate(() => window.__testPinnedCard.getBoundingClientRect().toJSON());
    await page.mouse.move(pinBox.left + 35, pinBox.top + 85, { steps: 5 });
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned")?.dataset.controlId.endsWith("--customerField"));
    assert.equal(await page.evaluate(() => getComputedStyle(window.__testPinnedCard).pointerEvents), "auto");
    const codeBox = await page.evaluate(() => window.__testPinnedCard.querySelector(".hover-row code").getBoundingClientRect().toJSON());
    await page.mouse.move(codeBox.left + 1, codeBox.top + codeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(codeBox.left + 150, codeBox.top + codeBox.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.ok((await page.evaluate(() => window.getSelection().toString())).includes("Orders"), "Native drag selects inspector text");
    await page.keyboard.press("Control+a");
    const selectionText = await page.evaluate(() => window.getSelection().toString());
    assert.ok(selectionText.includes("/Orders('4500001234')/CustomerName"), "Select all stays inside the pinned inspector");
    assert.ok(!selectionText.includes("Pedidos recientes"), "Select all doesn't include the application");
    await page.keyboard.press("Control+c");
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("CustomerName"), "Native Ctrl+C copies selected inspector text");
    // Wait for a real automatic scan and verify it doesn't replace selected DOM.
    await page.evaluate(() => { window.__testPinnedScans = 0; window.__testPinnedObserver = new MutationObserver(() => window.__testPinnedScans++); window.__testPinnedObserver.observe(window.__testLensShadow.querySelector(".hover-outline"), { attributes: true }); });
    await page.waitForFunction(() => window.__testPinnedScans > 0);
    assert.ok(await page.evaluate(() => window.__testPinnedCard === window.__testLensShadow.querySelector(".hover-card.pinned")));
    assert.equal(await page.evaluate(() => window.getSelection().toString()), selectionText, "Automatic refresh preserves text selection");
    await page.evaluate(() => window.__testPinnedObserver.disconnect());
    const copyBox = await page.evaluate(() => window.__testPinnedCard.querySelector(".hover-copy").getBoundingClientRect().toJSON());
    await page.mouse.click(copyBox.left + copyBox.width / 2, copyBox.top + copyBox.height / 2);
    await page.waitForFunction(() => window.__testPinnedCard.querySelector(".hover-copy").textContent === "Copiado");
    const allCopied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(allCopied.includes("sap.ui.model.odata.v2.ODataModel"));
    assert.ok(allCopied.includes("Data source: ordersService"));
    // HTTP intranet apps may not expose navigator.clipboard: verify that fallback.
    await page.evaluate(async () => {
      window.__testClipboard = navigator.clipboard;
      await window.__testClipboard.writeText("fallback sentinel");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    });
    await page.mouse.click(copyBox.left + copyBox.width / 2, copyBox.top + copyBox.height / 2);
    await page.waitForFunction(async () => (await window.__testClipboard.readText()).includes("Data source: ordersService"));
    await page.evaluate(() => { delete navigator.clipboard; });
    await page.screenshot({ path: path.join(output, "pinned-inspector.png") });
    // Values are opt-in and stay local to this frame, outside extension snapshots.
    const openBindingValues = async (modelName = "sales") => {
      const point = await page.evaluate((name) => {
        const button = [...window.__testLensShadow.querySelectorAll(".binding-values")].find((node) => node.getAttribute("aria-label").includes(`← ${name}>`));
        if (!button) throw new Error(`Missing values button for ${name}`);
        button.scrollIntoView({ block: "center" });
        const box = button.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }, modelName);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => window.__testLensShadow.querySelector(".values-dialog"));
    };
    inspectionRequests = 0; page.on("request", countRequest);
    await openBindingValues();
    let valuesText = await page.evaluate(() => window.__testLensShadow.querySelector(".values-content").innerText);
    assert.ok(valuesText.includes("Cliente demo") && valuesText.includes("Modelo sales") && valuesText.includes("OData V2"), valuesText);
    assert.ok(await page.evaluate(() => {
      const target = window.__testLensShadow.querySelector(".json-line.target");
      return target?.textContent.includes('"CustomerName": "Cliente demo"') && window.__testLensShadow.activeElement === target;
    }), "V2 highlights and focuses the exact bound property in the cached model");
    await page.keyboard.press("Control+a");
    assert.ok((await page.evaluate(() => getSelection().toString())).includes("Cliente demo"));
    assert.ok(!(await page.evaluate(() => getSelection().toString())).includes("Pedidos recientes"));
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector(".values-dialog").contains(window.__testLensShadow.activeElement)), "Tab stays inside values dialog");
    const valuesCopy = await page.evaluate(() => {
      const box = window.__testLensShadow.querySelector(".values-dialog .hover-copy").getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(valuesCopy.x, valuesCopy.y);
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".values-dialog .hover-copy").textContent === "Copiado");
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("Cliente demo"));
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.screenshot({ path: path.join(output, "binding-values-v2.png") });
    await page.setViewportSize({ width: 460, height: 350 });
    assert.ok(await page.evaluate(() => {
      const dialog = window.__testLensShadow.querySelector(".values-dialog"), box = dialog.getBoundingClientRect();
      const actions = dialog.querySelector(".hover-actions").getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && actions.bottom <= box.bottom && dialog.querySelector(".values-content").scrollHeight > dialog.querySelector(".values-content").clientHeight;
    }), "Small viewport keeps actions visible and scrolls model data");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.down("Escape"); await page.keyboard.down("Escape"); await page.keyboard.up("Escape");
    assert.ok(await page.evaluate(() => !window.__testLensShadow.querySelector(".values-dialog") && window.__testLensShadow.querySelector(".hover-card.pinned")), "Esc and repeats close only values, preserving the card");
    assert.ok(await page.evaluate(() => window.__testLensShadow.activeElement.classList.contains("binding-values")), "Close restores binding button focus");
    await openBindingValues("ui");
    assert.ok((await page.evaluate(() => window.__testLensShadow.querySelector(".values-content").innerText)).includes('"state": "Borrador"'));
    await page.keyboard.press("Escape");
    assert.ok(!JSON.stringify(await snapshot()).includes("Cliente demo"), "Value snapshots never enter the extension data bridge");
    assert.equal(inspectionRequests, 0, "Opening model values doesn't request OData");
    page.off("request", countRequest);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    assert.equal(await page.evaluate(() => window.__UI5_TECH_LENS__.isPinned()), false, "Esc closes independently of Alt");
    await page.getByRole("button", { name: "Abrir diálogo" }).hover();
    await customerField.hover();
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    await page.getByRole("button", { name: "Abrir diálogo" }).hover();
    await customerField.hover();
    await customerField.click();
    assert.ok(await customerField.evaluate((node) => node === document.activeElement), "Hover card doesn't intercept clicks");
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    await page.getByRole("button", { name: "Abrir diálogo" }).hover();
    await customerField.hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card"));
    await page.locator('[id$="--noteField-inner"]').hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card")?.dataset.controlId.endsWith("--noteField"));
    cardText = await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent);
    assert.ok(cardText.includes("/note"));
    assert.ok(!cardText.includes("CustomerName"), "Hover changes without stale field details");
    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.getByRole("dialog").waitFor();
    // The dialog sets its initial focus at the end of its opening animation.
    // Start inspection after that transition, as in an already-open app popup.
    await page.waitForFunction(() => {
      const dialog = Object.values(sap.ui.require("sap/ui/core/Element").registry.all()).find((control) => control.getId().endsWith("--orderDialog"));
      return dialog?.oPopup?.getOpenState() === "OPEN";
    });
    await page.locator('[id$="--dialogCustomerField-inner"]').click();
    await page.locator('[id$="--dialogCustomerField-inner"]').hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card")?.dataset.controlId.endsWith("--dialogCustomerField"));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    // A modal UI5 popup traps focus outside its DOM. The inspector lives in a
    // closed shadow root alongside it and must keep focus while selecting JSON.
    await openBindingValues();
    assert.ok(await page.evaluate(() => {
      const shadow = window.__testLensShadow;
      return document.activeElement.id === "ui5-technical-lens-overlay" && shadow.activeElement === shadow.querySelector(".json-line.target");
    }), "The values dialog retains focus above the modal UI5 popup");
    const popupJSONPoints = await page.evaluate(() => {
      const row = window.__testLensShadow.querySelector(".json-line.target");
      const key = row.querySelector(".json-key").getBoundingClientRect(), value = row.querySelector(".json-string").getBoundingClientRect();
      return { x1: key.left + 1, x2: value.right - 1, y: key.top + key.height / 2 };
    });
    await page.mouse.move(popupJSONPoints.x1, popupJSONPoints.y); await page.mouse.down();
    await page.mouse.move(popupJSONPoints.x2, popupJSONPoints.y, { steps: 12 }); await page.mouse.up();
    const popupJSONSelection = await page.evaluate(() => getSelection().toString());
    assert.ok(popupJSONSelection.includes("CustomerName") && popupJSONSelection.includes("Cliente demo"), `Dragging on JSON above a UI5 modal selects JSON instead of the underlying input: ${JSON.stringify(popupJSONSelection)}`);
    assert.ok(await page.evaluate(() => document.activeElement.id === "ui5-technical-lens-overlay"), "Dragging keeps focus in the inspector");
    await page.keyboard.press("Control+c");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), popupJSONSelection, "Ctrl+C copies the JSON selection above a UI5 modal");
    await page.screenshot({ path: path.join(output, "binding-json-over-ui5-dialog.png") });
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => {
      const shadow = window.__testLensShadow;
      return document.activeElement.id === "ui5-technical-lens-overlay" && shadow.querySelector(".values-dialog").contains(shadow.activeElement);
    }), "Tab retains focus inside model values above a UI5 modal");
    await page.keyboard.press("Escape");
    assert.ok(await page.evaluate(() => {
      const shadow = window.__testLensShadow;
      return document.activeElement.id === "ui5-technical-lens-overlay" && shadow.activeElement.classList.contains("binding-values");
    }), "Closing values restores focus to the binding above the UI5 modal");
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card.pinned"));
    assert.ok(await page.getByRole("dialog").isVisible(), "Pin/unpin doesn't close the application popup");
    assert.ok(await page.locator('[id$="--dialogCustomerField-inner"]').evaluate((node) => document.activeElement === node), "Unpin restores focus to the original field in the UI5 popup");
    await page.locator('[id$="--dialogCustomerField-inner"]').hover();
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await page.keyboard.down("Escape");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    await page.keyboard.down("Escape"); // repeat while held must not close UI5's dialog
    await page.keyboard.up("Escape");
    assert.ok(await page.getByRole("dialog").isVisible(), "Esc closes the inspector without closing the UI5 popup");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await popup.locator("#odatas").uncheck();
    await page.bringToFront(); await customerField.hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-heading")?.textContent === "Modelos");
    assert.ok(!await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent.includes("/odata/v2")));
    assert.ok((await snapshot()).options.models, "OData toggle independent of models");
    await popup.locator("#odatas").check();
    await popup.locator("#models").uncheck();
    await page.bringToFront(); await customerField.hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-heading")?.textContent === "OData");
    assert.ok(!await page.evaluate(() => window.__testLensShadow.querySelector(".hover-card").textContent.includes("editable")));
    await page.locator('[id$="--noteField-inner"]').hover();
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card"));
    await popup.locator("#models").check();
    // Exercise default JSON and V4 through the same actual Alt + binding click flow.
    for (const [field, modelName, expected] of [["noteField", "(por defecto)", "Entrega por la mañana"], ["productField", "catalog", "Equipo de oficina"]]) {
      await page.bringToFront();
      await page.locator(`[id$="--${field}-inner"]`).hover();
      await page.waitForFunction((suffix) => window.__testLensShadow.querySelector(".hover-card")?.dataset.controlId.endsWith(suffix), `--${field}`);
      await page.keyboard.press("Alt");
      await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-card.pinned"));
      inspectionRequests = 0; page.on("request", countRequest);
      await openBindingValues(modelName);
      valuesText = await page.evaluate(() => window.__testLensShadow.querySelector(".values-content").innerText);
      assert.ok(valuesText.includes(expected), valuesText);
      assert.ok(await page.evaluate((value) => {
        const target = window.__testLensShadow.querySelector(".json-line.target");
        return target?.textContent.includes(value) && window.__testLensShadow.activeElement === target;
      }, expected), `${field} highlights the correct model/context property`);
      assert.equal(inspectionRequests, 0, `${field} values use only loaded data`);
      page.off("request", countRequest);
      await page.screenshot({ path: path.join(output, `binding-values-${field}.png`) });
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    }
    // Repeated values far below the fold must select the binding path, not the first match.
    await page.evaluate(() => {
      const field = Object.values(sap.ui.require("sap/ui/core/Element").registry.all()).find((control) => control.getId().endsWith("--noteField"));
      const JSONModel = sap.ui.require("sap/ui/model/json/JSONModel");
      window.__testFocusModel = new JSONModel({ items: Array.from({ length: 350 }, (_, index) => ({ value: "Repetido", enabled: index % 2 === 0 })), html: '<img src="x" onerror="window.__unsafeJSON=true">' });
      field.setModel(window.__testFocusModel, "focusTest"); field.bindProperty("value", "focusTest>/items/299/value");
    });
    await page.locator('[id$="--noteField-inner"]').hover();
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-card")?.textContent.includes("/items/299/value"));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-card.pinned"));
    await openBindingValues("focusTest");
    const jsonFocusState = () => page.evaluate(() => {
      const shadow = window.__testLensShadow, target = shadow.querySelector(".json-line.target"), content = shadow.querySelector(".values-content");
      const row = target.getBoundingClientRect(), viewport = content.getBoundingClientRect();
      return { line: target.dataset.line, text: target.textContent, focused: shadow.activeElement === target, visible: row.top >= viewport.top && row.bottom <= viewport.bottom,
        scrolled: content.scrollTop > 0, highlighted: getComputedStyle(target).backgroundColor !== "rgba(0, 0, 0, 0)",
        data: JSON.parse(shadow.querySelector(".json-view:last-child").innerText).items[299].value,
        colors: ["key", "string", "boolean"].every((type) => shadow.querySelector(`.json-${type}`)), unsafe: Boolean(window.__unsafeJSON || shadow.querySelector(".values-dialog img")) };
    });
    let jsonState = await jsonFocusState();
    assert.deepEqual(jsonState, { line: "1200", text: '      "value": "Repetido",', focused: true, visible: true, scrolled: true, highlighted: true, data: "Repetido", colors: true, unsafe: false });
    await page.evaluate(() => { window.__testLensShadow.querySelector(".values-content").scrollTop = 0; });
    const clickLocateValue = async () => {
      const point = await page.evaluate(() => {
        const box = window.__testLensShadow.querySelector(".values-locate").getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
    };
    await clickLocateValue();
    jsonState = await jsonFocusState(); assert.ok(jsonState.focused && jsonState.visible && jsonState.scrolled, "Ir al valor returns to the target after manual scrolling");
    await page.screenshot({ path: path.join(output, "binding-json-focused.png") });
    // Native drags across tokens and lines select text; folding only uses the gutter button.
    // Some host apps cancel presses during document capture, before the dialog's
    // bubbling listeners can isolate them. Keep native selection working there.
    await page.evaluate(() => {
      window.__testBlockedPresses = 0;
      window.__testCancelPress = (event) => { window.__testBlockedPresses++; event.preventDefault(); };
      for (const type of ["pointerdown", "mousedown"]) document.addEventListener(type, window.__testCancelPress, true);
    });
    const dragJSON = async (multiline) => {
      const points = await page.evaluate((multi) => {
        const target = window.__testLensShadow.querySelector(".json-line.target");
        const start = target.querySelector(multi ? ".json-key" : ".json-string").getBoundingClientRect();
        const end = (multi ? target.nextElementSibling.querySelector(".json-boolean") : target.querySelector(".json-string")).getBoundingClientRect();
        return { x1: start.left + 1, y1: start.top + start.height / 2, x2: end.right - 1, y2: end.top + end.height / 2 };
      }, multiline);
      await page.mouse.move(points.x1, points.y1); await page.mouse.down();
      await page.mouse.move(points.x2, points.y2, { steps: 12 }); await page.mouse.up();
      return page.evaluate(() => getSelection().toString());
    };
    assert.ok((await dragJSON(false)).includes("Repetido"), "Dragging over a colored string selects its text");
    const dragged = await dragJSON(true);
    assert.ok(dragged.includes("Repetido") && dragged.includes("enabled") && dragged.includes("false"), dragged);
    await page.keyboard.press("Control+c");
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("enabled"), "Native Ctrl+C copies a multi-line drag selection");
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector('.json-view:last-child [data-line="1199"] .json-toggle').getAttribute("aria-expanded") === "true"), "Dragging text doesn't fold nodes");
    assert.equal(await page.evaluate(() => window.__testBlockedPresses), 0, "Inspector presses never reach the host app's capture handlers");
    await page.screenshot({ path: path.join(output, "binding-json-selection.png") });
    await page.mouse.click(5, 5);
    assert.equal(await page.evaluate(() => window.__testBlockedPresses), 0, "The values backdrop also isolates presses");
    await page.evaluate(() => getSelection().removeAllRanges());
    const clickJSON = async (lineOrAction) => {
      const point = await page.evaluate((key) => {
        const view = window.__testLensShadow.querySelector(".json-view:last-child");
        const button = typeof key === "number" ? view.querySelector(`[data-line="${key}"] .json-toggle`) : view.previousElementSibling.querySelector(`[data-action="${key}"]`);
        button.scrollIntoView({ block: "center" }); const box = button.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }, lineOrAction);
      await page.mouse.click(point.x, point.y);
    };
    await clickJSON(1199);
    assert.ok(await page.evaluate(() => {
      const view = window.__testLensShadow.querySelector(".json-view:last-child");
      return view.querySelector('[data-line="1199"] .json-toggle').getAttribute("aria-expanded") === "false" && view.querySelector('[data-line="1200"]').hidden && !view.querySelector('[data-line="1203"]').hidden;
    }), "Collapsing an object hides its children and closing brace, preserving siblings");
    await page.keyboard.press("Enter");
    assert.ok(await page.evaluate(() => !window.__testLensShadow.querySelector(".json-line.target").hidden), "Enter expands the focused node");
    await clickJSON(1199); await clickJSON(2); await page.keyboard.press("Space");
    assert.ok(await page.evaluate(() => window.__testLensShadow.querySelector(".json-line.target").hidden), "Expanding a parent preserves the child's collapsed state");
    await clickJSON("collapse");
    assert.equal(await page.evaluate(() => [...window.__testLensShadow.querySelectorAll(".json-view:last-child .json-line")].filter((row) => !row.hidden).length), 1, "Collapse all leaves a root summary");
    const fullCopyPoint = await page.evaluate(() => {
      const box = window.__testLensShadow.querySelector(".values-dialog .hover-copy").getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(fullCopyPoint.x, fullCopyPoint.y);
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith("Modelo focusTest"));
    const copiedModel = await page.evaluate(async () => {
      const text = await navigator.clipboard.readText(), marker = "Datos del modelo JSON en memoria";
      return JSON.parse(text.slice(text.indexOf(marker) + marker.length).trim());
    });
    assert.equal(copiedModel.items.length, 350, "Copy values includes the full snapshot even when nodes are collapsed");
    await clickLocateValue();
    assert.ok(await page.evaluate(() => {
      const shadow = window.__testLensShadow, target = shadow.querySelector(".json-line.target");
      const row = target.getBoundingClientRect(), content = shadow.querySelector(".values-content").getBoundingClientRect();
      return !target.hidden && shadow.activeElement === target && row.top >= content.top && row.bottom <= content.bottom && shadow.querySelector('.json-view:last-child [data-line="3"] .json-toggle').getAttribute("aria-expanded") === "false";
    }), "Ir al valor reopens its ancestors while leaving unrelated branches collapsed");
    await page.screenshot({ path: path.join(output, "binding-json-folded.png") });
    await clickJSON("expand"); await clickLocateValue();
    assert.deepEqual(await jsonFocusState(), jsonState, "Expand all restores the JSON text and original line numbers");
    assert.equal(await page.evaluate(() => window.__testBlockedPresses), 0, "Folding, locating and copying still work with host capture handlers");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    assert.ok(await page.evaluate(() => window.__testBlockedPresses > 0), "Presses outside the pinned inspector still reach the app");
    await page.evaluate(() => {
      for (const type of ["pointerdown", "mousedown"]) document.removeEventListener(type, window.__testCancelPress, true);
      delete window.__testCancelPress; delete window.__testBlockedPresses;
    });
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const field = Object.values(sap.ui.require("sap/ui/core/Element").registry.all()).find((control) => control.getId().endsWith("--noteField"));
      field.bindProperty("value", "/note"); field.setModel(null, "focusTest"); window.__testFocusModel.destroy(); delete window.__testFocusModel;
    });
    await page.locator("iframe").evaluate((node) => { node.style.width = "700px"; node.style.height = "400px"; });
    await page.bringToFront();
    await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.move(10, 10);
    await frame.locator('[id$="--customerField-inner"]').hover();
    const hoveredBox = await frame.locator('[id$="--customerField-inner"]').boundingBox();
    // Continuous motion ensures a real movement event after crossing an OOPIF.
    await page.mouse.move(hoveredBox.x + hoveredBox.width / 2 + 4, hoveredBox.y + hoveredBox.height / 2, { steps: 4 });
    // Headless Edge can omit native move events in a resized cross-origin frame.
    // Exercise that frame's listener with frame-local coordinates as well. All
    // main-page hover, dismissal, dialog and click-through tests use native input.
    await frame.locator('[id$="--customerField-inner"]').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      node.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    });
    await frame.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card")?.dataset.controlId.endsWith("--customerField"));
    assert.equal(await page.evaluate(() => window.__testLensShadow.querySelectorAll(".hover-card").length), 0, "Parent card disappears when entering iframe");
    // Keyboard focus is still outside the iframe: the shortcut must reach its hover card.
    await page.keyboard.down("Control");
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".discovery-outline"));
    await frame.waitForFunction(() => window.__testLensShadow.querySelector(".discovery-outline"));
    await page.keyboard.up("Control");
    await page.waitForFunction(() => !window.__testLensShadow.querySelector(".discovery-outline"));
    await frame.waitForFunction(() => !window.__testLensShadow.querySelector(".discovery-outline"));
    await page.keyboard.press("Alt");
    await frame.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await frame.evaluate(() => window.__testLensShadow.querySelector(".binding-values").click());
    assert.ok((await frame.evaluate(() => window.__testLensShadow.querySelector(".values-content").textContent)).includes("Cliente demo"), "Iframe values come from its own model");
    await frame.evaluate(() => window.__testLensShadow.querySelector(".values-dialog .hover-close").click());
    await page.keyboard.press("Escape");
    await frame.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await popup.locator("#controllers").check();
    await popup.locator("#views").check(); await popup.locator("#fragments").check();
    await popup.locator("#enabled").uncheck();
    await page.locator("#ui5-technical-lens-overlay").waitFor({ state: "detached" });
    assert.equal(await frame.locator("#ui5-technical-lens-overlay").count(), 0, "Disable applies to iframe");
    await popup.locator("#enabled").check();
    await page.locator("#ui5-technical-lens-overlay").waitFor();
    await popup.locator("#compact").check();
    await page.waitForFunction(() => window.__UI5_TECH_LENS__.snapshot().options.compact);
    assert.equal((await snapshot()).options.compact, true);
    await popup.close();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Abrir diálogo" }).waitFor({ timeout: 90000 });
    await page.waitForFunction(() => window.__UI5_TECH_LENS__?.snapshot().entries.some((entry) => entry.path.endsWith("Summary.fragment.xml")));
    assert.equal((await snapshot()).options.enabled, true, "Same-tab reload retains settings");
    assert.equal((await snapshot()).options.models, true);
    assert.equal((await snapshot()).options.odatas, true);
    assert.equal((await snapshot()).options.controllers, true);

    // Re-injection must not add a second inspector or replace wrapped factories.
    const original = await page.evaluateHandle(() => sap.ui.require("sap/ui/core/Fragment").load);
    await page.addScriptTag({ path: path.join(root, "inspector.js") });
    assert.ok(await page.evaluate((fn) => fn === sap.ui.require("sap/ui/core/Fragment").load, original));
    assert.equal(await page.locator("#ui5-technical-lens-overlay").count(), 1);
    assert.deepEqual(errors, [], "No unhandled application/popup errors");
    completed = true;
    console.log("PASS: controller flag, view/declarative/nested/dialog associations, controllerless view, anonymous handlers, combined cards, persistence; Alt/Esc and clipboard, OData, iframe, overlays, reload, idempotency.");
  } finally {
    if (context && !completed) {
      const appPage = context.pages().find((item) => /^http:/.test(item.url()));
      if (appPage && !appPage.isClosed()) {
        console.log("Final browser state:", JSON.stringify(await appPage.evaluate(() => { const state = window.__UI5_TECH_LENS__?.snapshot(); return { title: document.title, ready: document.readyState, ui5: window.sap?.ui?.version, options: state?.options, apps: state?.apps, entries: state?.entries.length }; }).catch((error) => ({ error: error.message }))));
        await appPage.screenshot({ path: path.join(output, "last-state.png") }).catch(() => {});
      }
    }
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    // This path is created exclusively by this test, within the OS temporary dir.
    if (profile.startsWith(path.join(os.tmpdir(), "ui5-lens-test-"))) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
