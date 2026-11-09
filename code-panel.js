"use strict";
const $ = (id) => document.getElementById(id);
let resources = [], navigation, current = null, history = [], lastLocation = null, loading = 0, revision = 0;
let pendingLocation = null;
let moduleUrls = Object.create(null), jumpRequest = 0;
let resourceTimer, resourcesReady = Promise.resolve(), selection = 0, navigationDirty = true;
let searchMatches = [], searchIndex = -1, searchKey = "", searchQuery = "";
let resultLimit = 200;
const resultButtons = new Map();
const folderStates = new Map(), fileButtons = new Map();
// Exclude extension origins, including object URLs created by extensions.
const isExtensionResource = (url) => /^\s*(?:(?:blob|filesystem):)*chrome-extension:/i.test(url);
const isXML = (url) => /\.(?:view|fragment)\.xml(?:[?#]|$)/i.test(url);
const scriptResources = () => resources.filter((r) => !isXML(r.url) && typeof r.content === "string");
function findResource(location) {
  if (!location) return null;
  // Keep the exact frame association even for iframes with identical URLs.
  return resources.find((r) => r.url === location.url && (!location.key || r.xmlDescriptor?.key === location.key && r.xmlDescriptor?.frameId === location.frameId))
    || resources.find((r) => r.url === location.url)
    || (location.path && resources.find((r) => r.path === location.path));
}
async function discoverXML(request) {
  if (!chrome.runtime?.sendMessage) return;
  try {
    const result = await chrome.runtime.sendMessage({ channel: "ui5-lens", action: "getXMLResources", tabId: chrome.devtools.inspectedWindow.tabId });
    if (request !== loading) return;
    for (const descriptor of result?.resources || []) {
      if (!isXML(descriptor.url) || !/^https?:/.test(descriptor.url) || typeof descriptor.key !== "string" || !Number.isInteger(descriptor.frameId)) continue;
      const existing = resources.find((r) => r.url === descriptor.url);
      // Resource content can be shared for identical URLs; controller context
      // from a popup request still overrides the tree's default association.
      if (existing) { existing.xmlDescriptor ||= descriptor; existing.path ||= descriptor.path; continue; }
      resources.push({ url: descriptor.url, path: descriptor.path, runtimeXML: true, synthetic: true, xmlDescriptor: descriptor,
        source: { getContent(done) {
          chrome.runtime.sendMessage({ channel: "ui5-lens", action: "readXML", tabId: chrome.devtools.inspectedWindow.tabId, key: descriptor.key, frameId: descriptor.frameId })
            .then((result) => { if (result?.error) { this.error = result.error; done(null); } else done(result?.content); })
            .catch((error) => { this.error = error.message; done(null); });
        } } });
    }
  } catch { /* The source inventory remains usable when a frame is inaccessible. */ }
}
function resourceParts(url) {
  try {
    const parsed = new URL(url);
    return [parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol, ...parsed.pathname.split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } })].map((part, i, parts) => i === parts.length - 1 ? part + parsed.search + parsed.hash : part);
  } catch { return ["Otros scripts", ...url.split("/").filter(Boolean)]; }
}
const status = (text, id = "status") => { $(id).textContent = text; $(id).title = text; };
const timed = (operation) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("DevTools no respondió al leer el recurso.")), 10000);
  operation((value) => { clearTimeout(timer); resolve(value); });
});
function files() {
  const filter = $("filter").value.toLowerCase();
  const root = { folders: new Map(), files: [] };
  fileButtons.clear();
  for (const r of resources.filter((r) => r.url.toLowerCase().includes(filter))) {
    const parts = resourceParts(r.url); let folder = root;
    for (const part of parts.slice(0, -1)) {
      if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
      folder = folder.folders.get(part);
    }
    folder.files.push({ ...r, name: parts.at(-1) || r.url });
  }
  function branch(folder, path = []) {
    const list = document.createElement("ul");
    for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const item = document.createElement("li"), details = document.createElement("details"), summary = document.createElement("summary");
      const key = JSON.stringify([...path, name]);
      summary.textContent = name; summary.title = [...path, name].join("/");
      details.dataset.folder = key;
      details.open = Boolean(filter) || (folderStates.get(key) ?? path.length === 0);
      details.addEventListener("toggle", () => { if (details.isConnected && !$("filter").value) folderStates.set(key, details.open); });
      details.append(summary, branch(child, [...path, name])); item.append(details); list.append(item);
    }
    for (const file of folder.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const item = document.createElement("li"), button = document.createElement("button");
      button.className = "file"; button.textContent = file.name; button.title = file.url; button.dataset.url = file.url;
      if (isXML(file.url)) button.classList.add("xml-file");
      button.onclick = () => show({ url: file.url, line: 0, column: 0 });
      fileButtons.set(file.url, button); item.append(button); list.append(item);
    }
    return list;
  }
  $("files").replaceChildren(branch(root));
  if (!fileButtons.size) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No hay archivos que mostrar."; $("files").append(empty); }
  markCurrentFile();
}
function markCurrentFile(reveal = false) {
  for (const [url, button] of fileButtons) {
    if (url === current?.url) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  const active = fileButtons.get(current?.url);
  if (!active) return;
  for (let folder = active.closest("details"); folder; folder = folder.parentElement.closest("details")) { folder.open = true; folderStates.set(folder.dataset.folder, true); }
  if (reveal) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}
// Share reads between background workers and a user selecting an unloaded file.
function readResource(resource, request = loading) {
  if (typeof resource.content === "string") return Promise.resolve(resource);
  if (!resource.reading) resource.reading = timed((done) => resource.source.getContent((text, encoding) => done(encoding || typeof text !== "string" ? null : text)))
    .then((content) => {
      if (request !== loading) return null;
      if (content === null) throw new Error("No se pudo leer el recurso.");
      resource.content = content.replace(/\r\n?/g, "\n");
      resource.failed = false; navigationDirty = true; searchKey = "";
      return resource;
    }).catch(() => { if (request === loading) resource.failed = true; return null; })
    .finally(() => { resource.reading = null; });
  return resource.reading;
}
async function refresh() {
  const request = ++loading;
  status("Leyendo lista de archivos…", "load-status");
  resourcesReady = timed((done) => chrome.devtools.inspectedWindow.getResources(done));
  try {
    const list = await resourcesReady;
    if (request !== loading) return;
    resources = [...new Map(list.filter((r) => !isExtensionResource(r.url) && (r.type === "script" || /\.[cm]?js(?:[?#]|$)/i.test(r.url) || isXML(r.url)))
      .map((r) => [r.url, { url: r.url, source: r }])).values()].sort((a, b) => a.url.localeCompare(b.url));
    await discoverXML(request);
    if (request !== loading) return;
    navigation = null; navigationDirty = true;
    const preferred = pendingLocation || (current && { ...current, scrollTop: $("viewport").scrollTop, scrollLeft: $("viewport").scrollLeft }) || lastLocation;
    const preferredResource = findResource(preferred);
    const location = preferredResource ? { ...preferred, url: preferredResource.url } : !pendingLocation && !isXML(preferred?.url || "") && resources.length ? { url: resources[0].url, line: 0, column: 0 } : null;
    // Show the requested file before building the tree or reading other contents.
    if (location) await show(location, false, Boolean(pendingLocation));
    else { current = null; $("code").replaceChildren(); $("sources").disabled = true; $("filename").textContent = "Selecciona un archivo"; syncSearch(); }
    if (request !== loading) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (request !== loading) return;
    files();
    let next = 0, completed = 0;
    await Promise.all(Array.from({ length: Math.min(6, resources.length) }, async () => {
      const scripts = resources.filter((r) => !r.runtimeXML);
      while (request === loading && next < scripts.length) {
        await readResource(scripts[next++], request);
        if (request !== loading) return;
        completed++;
        status(`Cargando archivos en segundo plano: ${completed}/${scripts.length}…`, "load-status");
        // Yield to painting and input even if DevTools serves cached contents.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }));
    if (request !== loading) return;
    await addPreloadXML(request);
    if (request !== loading) return;
    files();
    if (pendingLocation && findResource(pendingLocation)) {
      const resource = findResource(pendingLocation);
      await show({ ...pendingLocation, url: resource.url }, false);
    }
    const failed = resources.filter((r) => r.failed).length;
    status(`${resources.length - failed} archivos disponibles.${failed ? ` ${failed} recursos no se pudieron leer.` : ""}`, "load-status");
    syncSearch();
  } catch (error) { if (request === loading) status(error.message, "load-status"); }
}

async function addPreloadXML(request) {
  const xml = [];
  if (typeof UI5CodeXML === "undefined") return;
  for (const resource of scriptResources().filter((r) => r.content.includes("preload") && /\.(?:view|fragment)\.xml/.test(r.content))) {
    for (const entry of UI5CodeXML.preloads(resource.content, acorn)) xml.push({ ...entry, preload: resource.url });
  }
  if (!xml.length) return;
  let mapped = [];
  if (chrome.devtools.inspectedWindow.eval) {
    const paths = [...new Set(xml.map((r) => r.path))];
    try { mapped = await timed((done) => chrome.devtools.inspectedWindow.eval(`(() => { const loader = globalThis.sap?.ui?.require; return ${JSON.stringify(paths)}.map(path => { try { return [path, new URL(loader.toUrl(path), location.href).href]; } catch { return null; } }).filter(Boolean); })()`, (value, error) => done(error ? [] : value))); } catch { /* Keep a local source view if loader URLs cannot be resolved. */ }
  }
  if (request !== loading) return;
  const urls = new Map(Array.isArray(mapped) ? mapped.filter((p) => Array.isArray(p) && typeof p[1] === "string" && /^https?:/.test(p[1])) : []);
  for (const entry of xml) {
    const url = urls.get(entry.path) || new URL(entry.path, entry.preload).href;
    if (!/^https?:/.test(url) || isExtensionResource(url)) continue;
    const existing = resources.find((r) => r.url === url || r.path === entry.path);
    if (existing?.runtimeXML && typeof existing.content !== "string") { existing.content = entry.content; existing.preload = entry.preload; }
    else if (!existing) resources.push({ ...entry, url, synthetic: true });
  }
  navigationDirty = true; searchKey = "";
}

function render(resource) {
  const xml = isXML(resource.url);
  const tokens = xml ? UI5CodeXML.inspect(resource.content).tokens : [];
  const moduleOffsets = new Set(xml ? [] : UI5CodeNavigation.create([resource]).moduleOffsets(resource.url));
  try {
    if (!xml) {
    const tokenizer = acorn.tokenizer(resource.content, { ecmaVersion: "latest", allowHashBang: true, onComment: (_block, _text, start, end) => tokens.push({ start, end, style: "comment" }) });
    for (;;) { const t = tokenizer.getToken(); if (t.type.label === "eof") break; if (t.type.label === "name" || t.type.keyword || ["string", "template", "regexp"].includes(t.type.label)) tokens.push({ start: t.start, end: t.end, style: t.type.label === "name" ? "identifier" : t.type.keyword ? "keyword" : "string" }); }
    }
  } catch { /* Unparseable resources remain readable as plain text. */ }
  tokens.sort((a, b) => a.start - b.start);
  const fragment = document.createDocumentFragment(); let offset = 0, tokenIndex = 0;
  for (const [i, text] of resource.content.split("\n").entries()) {
    const row = document.createElement("span"); row.className = "line"; row.dataset.line = i; row.dataset.offset = offset;
    const number = document.createElement("span"); number.className = "number"; number.textContent = i + 1; number.setAttribute("aria-hidden", "true"); row.append(number);
    let position = offset; const end = offset + text.length;
    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= offset) tokenIndex++;
    let j = tokenIndex;
    while (j < tokens.length && tokens[j].start < end) {
      const t = tokens[j++], start = Math.max(position, t.start), stop = Math.min(end, t.end);
      if (start > position) row.append(document.createTextNode(resource.content.slice(position, start)));
      if (stop > start) {
        const span = document.createElement("span"); span.className = t.style; span.textContent = resource.content.slice(start, stop);
        if (t.style.includes("identifier")) { span.dataset.offset = t.start; span.tabIndex = 0; span.title = t.method ? `Ctrl+clic: ir al método ${t.method} del controlador (${t.event})` : "Ctrl+clic: ir a la definición"; }
        if (moduleOffsets.has(t.start)) { span.classList.add("module-reference"); span.dataset.offset = t.start; span.tabIndex = 0; span.title = "Ctrl+clic: abrir módulo importado"; }
        row.append(span); position = stop;
      }
    }
    row.append(document.createTextNode(resource.content.slice(position, end))); fragment.append(row); offset = end + 1;
  }
  $("code").replaceChildren(fragment);
}
async function show(location, remember = true, focusCode = true) {
  if (remember) pendingLocation = null;
  const chosen = ++selection, request = loading;
  const resource = resources.find((r) => r.url === location.url);
  if (!resource) { status("El recurso ya no está cargado. Pulsa Actualizar."); return; }
  if (isXML(resource.url)) {
    if (resource.xmlDescriptor) location = { ...resource.xmlDescriptor, xmlContext: resource.xmlDescriptor.controllers, ...location };
    if (location.xmlContext) resource.xmlContext = location.xmlContext;
    location = { ...location, xmlContext: location.xmlContext ?? resource.xmlContext };
    if (location.moduleUrls) { Object.assign(moduleUrls, location.moduleUrls); navigationDirty = true; }
  }
  if (typeof resource.content !== "string") {
    status(`Cargando ${location.url}…`);
    const loaded = await readResource(resource, request);
    if (chosen !== selection || request !== loading) return;
    if (!loaded) {
      current = null; $("code").replaceChildren(); $("filename").textContent = resourceParts(location.url).at(-1); $("sources").disabled = true;
      status(resource.source?.error || "No se pudo leer el recurso. Pulsa Actualizar para reintentarlo."); return;
    }
  }
  if (remember && current) history.push({ ...current, scrollTop: $("viewport").scrollTop, scrollLeft: $("viewport").scrollLeft });
  if (current?.url !== location.url || current.revision !== revision) render(resource);
  current = { ...location, revision }; $("back").disabled = !history.length; $("sources").disabled = Boolean(resource.synthetic);
  if (!fileButtons.has(location.url) && $("filter").value) { $("filter").value = ""; files(); }
  markCurrentFile(true);
  $("filename").textContent = resourceParts(location.url).at(-1); $("filename").title = location.url;
  $("candidates").hidden = true;
  document.querySelectorAll(".selected, .destination").forEach((el) => el.classList.remove("selected", "destination"));
  const row = $("code").children[location.line || 0];
  if (row) {
    row.classList.add("selected");
    const offset = location.offset ?? resource.content.split("\n").slice(0, location.line || 0).reduce((n, s) => n + s.length + 1, 0) + (location.column || 0);
    const target = [...row.querySelectorAll(".identifier, .module-reference")].find((el) => Number(el.dataset.offset) === offset);
    target?.classList.add("destination");
    (target || row).scrollIntoView({ block: "center", inline: "center" });
    if (target && focusCode) target.focus({ preventScroll: true });
  }
  if (location.scrollTop !== undefined) { $("viewport").scrollTop = location.scrollTop; $("viewport").scrollLeft = location.scrollLeft; }
  status(`${location.url} · línea ${(location.line || 0) + 1}, columna ${(location.column || 0) + 1}`);
  syncSearch();
}
function syncSearch() {
  const query = searchQuery, all = $("find-all").checked;
  const key = JSON.stringify([query, all, $("find-case").checked, revision, all ? null : current?.url]);
  if (key !== searchKey) {
    searchKey = key; searchMatches = []; searchIndex = -1;
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const resource of resources.filter((r) => typeof r.content === "string" && (all || r.url === current?.url))) {
        const regex = new RegExp(escaped, $("find-case").checked ? "g" : "gi");
        let match, line = 0, lineStart = 0, scan = 0;
        while ((match = regex.exec(resource.content))) {
          while (scan < match.index) { if (resource.content[scan] === "\n") { line++; lineStart = scan + 1; } scan++; }
          searchMatches.push({ url: resource.url, offset: match.index, end: match.index + match[0].length, line, column: match.index - lineStart });
        }
      }
      if (searchMatches.length) searchIndex = 0;
    }
    resultLimit = 200;
    $("search-results").scrollTop = 0;
    renderSearchResults();
  }
  paintSearch();
}
function renderSearchResults() {
  const previousScroll = $("search-results").scrollTop;
  const visible = $("find-all").checked && Boolean(searchQuery) && !$("findbar").hidden;
  $("search-results").hidden = !visible;
  $("search-result-list").replaceChildren(); resultButtons.clear();
  if (!visible) return;
  $("search-results-title").textContent = `${searchMatches.length} coincidencias en todos los archivos`;
  const byURL = new Map(resources.map((r) => [r.url, r.content]));
  const fragment = document.createDocumentFragment();
  searchMatches.slice(0, resultLimit).forEach((match, index) => {
    const item = document.createElement("li"), button = document.createElement("button");
    button.className = "search-result"; button.dataset.index = index;
    const file = document.createElement("span"), location = document.createElement("span"), snippet = document.createElement("span");
    file.className = "result-file"; file.textContent = match.url;
    location.className = "result-location"; location.textContent = `Línea ${match.line + 1} · Columna ${match.column + 1}`;
    const content = byURL.get(match.url), start = Math.max(match.offset - match.column, match.offset - 60), newline = content.indexOf("\n", match.offset);
    snippet.className = "result-code"; snippet.textContent = content.slice(start, Math.min(newline < 0 ? content.length : newline, start + 200));
    button.title = `${match.url}:${match.line + 1}:${match.column + 1}\n${snippet.textContent}`;
    button.append(file, location, snippet); button.onclick = () => selectSearch(index);
    resultButtons.set(index, button); item.append(button); fragment.append(item);
  });
  $("search-result-list").append(fragment);
  $("search-more").hidden = resultLimit >= searchMatches.length;
  $("search-results").scrollTop = previousScroll;
}
function paintSearch() {
  $("find-count").textContent = !searchQuery ? "Buscar en el código" : searchMatches.length ? `${searchIndex + 1} de ${searchMatches.length}` : "0 resultados";
  $("find-prev").disabled = $("find-next").disabled = !searchMatches.length;
  for (const [index, button] of resultButtons) {
    if (index === searchIndex) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
  }
  const matches = new Highlight(), active = new Highlight();
  if (!searchMatches.length) { CSS.highlights.set("ui5-find", matches); CSS.highlights.set("ui5-find-active", active); return; }
  // Build source offsets from text nodes, excluding line numbers. Ranges can
  // span syntax tokens without replacing identifier nodes or their handlers.
  const segments = [];
  for (const row of $("code").children) {
    let offset = Number(row.dataset.offset);
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement.closest(".number") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let node;
    while ((node = walker.nextNode())) { const end = offset + node.length; if (end > offset) segments.push({ node, start: offset, end }); offset = end; }
  }
  function boundary(offset, end) {
    let low = 0, high = segments.length;
    while (low < high) { const mid = (low + high) >>> 1; if (segments[mid].end < offset || (!end && segments[mid].end === offset)) low = mid + 1; else high = mid; }
    const segment = segments[low];
    return segment && segment.start <= offset && offset <= segment.end ? [segment.node, offset - segment.start] : null;
  }
  searchMatches.forEach((match, i) => {
    if (match.url !== current?.url) return;
    const start = boundary(match.offset, false), end = boundary(match.end, true);
    if (!start || !end) return;
    const firstRow = start[0].parentElement.closest(".line"), lastRow = end[0].parentElement.closest(".line");
    for (let row = firstRow; row; row = row.nextElementSibling) {
      const range = document.createRange();
      if (row === firstRow) range.setStart(...start); else range.setStartAfter(row.firstChild);
      if (row === lastRow) range.setEnd(...end); else range.setEnd(row, row.childNodes.length);
      matches.add(range); if (i === searchIndex) active.add(range);
      if (row === lastRow) break;
    }
  });
  CSS.highlights.set("ui5-find", matches); CSS.highlights.set("ui5-find-active", active);
}
function selectSearch(index) {
  if (!searchMatches.length) return;
  searchIndex = (index + searchMatches.length) % searchMatches.length;
  if (searchIndex >= resultLimit) { resultLimit = Math.ceil((searchIndex + 1) / 200) * 200; renderSearchResults(); }
  show(searchMatches[searchIndex], true, false);
  resultButtons.get(searchIndex)?.scrollIntoView({ block: "nearest" });
  const range = CSS.highlights.get("ui5-find-active").values().next().value;
  if (range) {
    const rect = range.getBoundingClientRect(), viewport = $("viewport"), box = viewport.getBoundingClientRect();
    viewport.scrollTop += rect.top - box.top - box.height / 2;
    if (rect.left < box.left || rect.right > box.right) viewport.scrollLeft += rect.left - box.left - box.width / 3;
  }
}
function searchChanged() { searchKey = ""; syncSearch(); selectSearch(0); }
function selectedCodeText() {
  if (document.activeElement?.matches("input, textarea")) return "";
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return "";
  const range = selection.getRangeAt(0), code = $("code");
  if (!code.contains(range.startContainer) || !code.contains(range.endContainer)) return "";
  const element = (node) => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (element(range.startContainer).closest(".number") && element(range.endContainer).closest(".number")) return "";
  const fragment = range.cloneContents();
  fragment.querySelectorAll(".number").forEach((node) => node.remove());
  const lines = [...fragment.querySelectorAll(".line")];
  return lines.length ? lines.map((line) => line.textContent).join("\n") : fragment.textContent;
}
function openSearch() {
  const selected = selectedCodeText();
  $("findbar").hidden = false;
  if (selected) { window.getSelection().removeAllRanges(); $("find").value = selected; searchQuery = selected; searchChanged(); }
  else renderSearchResults();
  $("find").focus(); $("find").select();
}
function closeSearch() { $("findbar").hidden = true; $("find").value = ""; searchQuery = ""; searchChanged(); $("viewport").focus(); }
window.focusPanel = () => ($("findbar").hidden ? $("viewport") : $("find")).focus();
// Consume the shortcut before DevTools' iframe keyboard forwarding sees it.
window.addEventListener("keydown", (event) => {
  const findShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f";
  const nextShortcut = event.key === "F3" || (event.key === "Enter" && event.target === $("find"));
  const closeShortcut = event.key === "Escape" && !$("findbar").hidden;
  if (!findShortcut && !nextShortcut && !closeShortcut) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (findShortcut) openSearch();
  else if (closeShortcut) closeSearch();
  else if ($("findbar").hidden) openSearch();
  else selectSearch(searchIndex + (event.shiftKey ? -1 : 1));
}, true);
async function navigate(offset) {
  if (!current) return;
  const jump = ++jumpRequest, chosen = selection, request = loading, url = current.url;
  if (navigationDirty || !navigation) {
    navigation = UI5CodeNavigation.create(scriptResources(), { moduleUrls });
    navigationDirty = false;
  }
  const resource = resources.find((r) => r.url === url);
  const xml = isXML(url);
  const controllers = xml ? UI5CodeXML.controllerNames(resource, resources, current.xmlContext) : [];
  const token = xml ? UI5CodeXML.inspect(resource.content).tokens.find((t) => t.method && t.start <= offset && offset < t.end) : null;
  const resolve = () => {
    if (!xml) return navigation.resolve(url, offset);
    if (!controllers.length) return { error: "No se conoce el controlador de este fragmento. Ábrelo desde el botón XML del inspector para usar su asociación actual." };
    const locations = token ? controllers.flatMap((name) => navigation.controllerMethod(name, token.method)) : [];
    const unique = [...new Map(locations.map((l) => [`${l.url}:${l.offset}`, l])).values()];
    return unique.length ? { locations: unique } : { error: `No se puede resolver «${token?.method || "evento"}» en el controlador asociado con el código cargado.` };
  };
  let result = resolve();
  if (result.error && chrome.devtools.inspectedWindow.eval) {
    const names = xml ? controllers.map((name) => name.startsWith("module:") ? name.slice(7).replace(/\.js$/, "") : name.replace(/\./g, "/") + ".controller").filter((name) => !Object.hasOwn(moduleUrls, name)) : navigation.moduleNames(url);
    if (names.length) {
      status("Consultando las rutas del cargador UI5…");
      // Only resolve URLs with UI5's loader. Never load a module or invoke an
      // exported application function. Contents still come from DevTools.
      const expression = `(() => { const loader = globalThis.sap?.ui?.require; if (typeof loader?.toUrl !== 'function') return []; return ${JSON.stringify(names)}.map(id => { try { return [id, new URL(loader.toUrl(id + '.js'), location.href).href]; } catch { return null; } }).filter(Boolean); })()`;
      let mapped = [];
      try { mapped = await timed((done) => chrome.devtools.inspectedWindow.eval(expression, (value, error) => done(error ? [] : value))); } catch { /* Static failure remains actionable if the loader cannot be read. */ }
      if (jump !== jumpRequest || chosen !== selection || request !== loading) return;
      for (const pair of Array.isArray(mapped) ? mapped : []) {
        if (Array.isArray(pair) && names.includes(pair[0]) && typeof pair[1] === "string" && !isExtensionResource(pair[1])) moduleUrls[pair[0]] = pair[1];
      }
      navigation = UI5CodeNavigation.create(scriptResources(), { moduleUrls });
      navigationDirty = false;
      result = resolve();
    }
  }
  $("candidates").replaceChildren(); $("candidates").hidden = true;
  if (result.error) { status(resources.some((r) => typeof r.content !== "string" && !r.failed) ? "Todavía se están cargando scripts. Vuelve a intentar el salto cuando termine la carga." : result.error); return; }
  if (result.locations.length === 1) { show(result.locations[0]); return; }
  status("Hay varias definiciones posibles. Selecciona el destino:"); $("candidates").hidden = false;
  for (const location of result.locations) { const button = document.createElement("button"); button.textContent = `${location.label ? location.label + " · " : ""}${location.url}:${location.line + 1}:${location.column + 1}`; button.onclick = () => show(location); $("candidates").append(button); }
}
$("code").addEventListener("click", (event) => { const token = event.target.closest(".identifier, .module-reference"); if (event.ctrlKey && token) { event.preventDefault(); navigate(Number(token.dataset.offset)); } });
document.addEventListener("keydown", (event) => {
  document.body.classList.toggle("ctrl", event.ctrlKey);
  if (event.ctrlKey && event.key === "Enter" && event.target.matches(".identifier, .module-reference")) { event.preventDefault(); navigate(Number(event.target.dataset.offset)); }
  if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); $("back").click(); }
});
document.addEventListener("keyup", (event) => document.body.classList.toggle("ctrl", event.ctrlKey));
window.addEventListener("blur", () => document.body.classList.remove("ctrl"));
$("back").onclick = () => { const previous = history.pop(); if (previous) show(previous, false); };
$("filter").oninput = files;
$("find-open").onclick = openSearch;
$("find-close").onclick = closeSearch;
$("find").oninput = () => { searchQuery = $("find").value; searchChanged(); };
$("find-prev").onclick = () => selectSearch(searchIndex - 1);
$("find-next").onclick = () => selectSearch(searchIndex + 1);
$("find-all").onchange = $("find-case").onchange = searchChanged;
$("search-more").onclick = () => { resultLimit += 200; renderSearchResults(); paintSearch(); };
$("refresh").onclick = () => { revision++; refresh(); };
$("sources").onclick = () => { if (current) chrome.devtools.panels.openResource(current.url, current.line || 0, current.column || 0); };
$("last").onclick = () => { if (lastLocation) window.openLocation(lastLocation); };
// Called by the persistent DevTools page when an inspected handler is located.
window.openLocation = async (location) => {
  if (isExtensionResource(location.url)) return;
  lastLocation = pendingLocation = location; $("last").disabled = false;
  $("last").textContent = isXML(location.url) ? "Último XML" : "Última función";
  ++selection;
  try {
    await resourcesReady.catch(() => {});
    if (pendingLocation !== location || lastLocation !== location) return;
    if (!findResource(location)) { revision++; await refresh(); }
    if (pendingLocation !== location || lastLocation !== location) return;
    const resource = findResource(location);
    if (!resource) { status("El recurso no está entre los archivos cargados ni en un preload literal disponible. No se ha solicitado al servidor."); return; }
    pendingLocation = null;
    return await show({ ...location, url: resource.url });
  } finally { if (pendingLocation === location) pendingLocation = null; }
};
chrome.devtools.inspectedWindow.onResourceAdded.addListener((resource) => {
  if (isExtensionResource(resource.url)) return;
  // executeScript inventory queries appear as anonymous debugger VM scripts.
  // They are not getResources entries; reacting to them would query forever.
  if (/^debugger:\/\/\/VM\d+(?:[?#]|$)/i.test(resource.url)) return;
  if (resource.type !== "script" && !/\.[cm]?js(?:[?#]|$)/i.test(resource.url) && !isXML(resource.url)) return;
  clearTimeout(resourceTimer);
  resourceTimer = setTimeout(() => { revision++; refresh(); }, 400);
});
chrome.devtools.network.onNavigated.addListener(() => { clearTimeout(resourceTimer); loading++; selection++; resources = []; navigation = null; moduleUrls = Object.create(null); revision++; history = []; current = null; lastLocation = pendingLocation = null; searchKey = ""; searchMatches = []; searchIndex = -1; searchQuery = ""; $("find").value = ""; $("findbar").hidden = true; folderStates.clear(); $("filter").value = ""; $("last").disabled = true; $("back").disabled = true; refresh(); });
refresh();
