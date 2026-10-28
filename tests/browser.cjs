"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { chromium } = require("playwright"), server = require("../tools/serve.cjs");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results"); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui5-lens-test-"));
(async () => {
  let context, completed = false;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { channel: process.env.UI5_TEST_BROWSER || "chromium", headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || await context.newPage();
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
    await worker.evaluate(({ tabId, enabled }) => chrome.storage.session.set({ [`tab:${tabId}`]: enabled }), { tabId, enabled });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Abrir diálogo" }).waitFor({ timeout: 45000 });
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
    // Run the shipped DevTools script with real extension messaging. The native
    // inspectedWindow.eval transport is represented by CDP's Console Utility API.
    const devtoolsPage = await context.newPage();
    const inspectedFunctions = [];
    cdp.on("Runtime.inspectRequested", (event) => inspectedFunctions.push(event.object));
    await devtoolsPage.exposeBinding("__testDevtoolsEval", async (_, expression) => {
      const response = await cdp.send("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    });
    await devtoolsPage.addInitScript((id) => {
      chrome.devtools = { inspectedWindow: { tabId: id, eval: (expression, settings, callback) => window.__testDevtoolsEval(expression, settings).then((value) => callback(value, null), (error) => callback(null, { description: error.message })) } };
    }, tabId);
    await devtoolsPage.goto(`chrome-extension://${extensionId}/devtools.html`);
    await page.waitForFunction(() => window.__testLensShadow.querySelector(".hover-source-status")?.textContent.includes("línea real"));
    assert.equal(inspectedFunctions.at(-1)?.type, "function", "DevTools inspects the function without invoking it");
    assert.equal(await page.getByRole("dialog").count(), 0, "Inspecting valueHelpRequest doesn't open the app dialog");
    await popup.locator("#search").fill("onLoadDetails");
    const popupEvent = popup.locator(".file").filter({ has: popup.locator(".key.event") }).first();
    await popupEvent.locator("summary").click();
    await popupEvent.getByRole("button", { name: "Ver función en DevTools" }).click();
    await popup.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes("línea real")));
    assert.ok(inspectedFunctions.length >= 2, "Popup and pinned card both navigate through the real background connection");
    const invalidSource = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ channel: "ui5-lens", action: "openHandler", tabId, frameId: 0, token: `h${"a".repeat(32)}_99999` }), tabId);
    assert.ok(invalidSource.error.includes("no está disponible"));
    await popup.locator("#search").fill("");
    await page.bringToFront();
    await page.evaluate(() => { document.querySelector("iframe").style.visibility = "hidden"; window.__testLensShadow.querySelector(".hover-card").scrollTop = 0; });
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
    await page.locator('[id$="--dialogCustomerField-inner"]').hover();
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card")?.dataset.controlId.endsWith("--dialogCustomerField"));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
    await page.keyboard.press("Alt");
    await page.waitForFunction(() => !window.__testLensShadow?.querySelector(".hover-card.pinned"));
    assert.ok(await page.getByRole("dialog").isVisible(), "Pin/unpin doesn't close the application popup");
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
    await page.keyboard.press("Alt");
    await frame.waitForFunction(() => window.__testLensShadow?.querySelector(".hover-card.pinned"));
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
