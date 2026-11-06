/* Static navigation only: never evaluates code from the inspected application. */
(() => {
  "use strict";
  const acorn = typeof module !== "undefined" && module.exports ? require("acorn") : globalThis.acorn;
  const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  const keyName = (node) => node && (!node.computed ? node.key?.name ?? node.key?.value : typeof node.key?.value === "string" ? node.key.value : null);
  function index(url, content) {
    let ast;
    try { ast = acorn.parse(content, { ecmaVersion: "latest", sourceType: "module", locations: true }); }
    catch { try { ast = acorn.parse(content, { ecmaVersion: "latest", sourceType: "script", locations: true }); } catch { return { url, content, error: "No se puede analizar este JavaScript." }; } }
    const root = { parent: null, bindings: new Map(), functionScope: true }, nodes = [], meta = new WeakMap(), modules = [], exports = new Map(), exportStars = [], moduleLinks = new Map();
    const bind = (scope, name, node, value) => { if (name) scope.bindings.set(name, { node, value }); };
    function pattern(node, scope) {
      if (!node) return;
      if (node.type === "Identifier") bind(scope, node.name, node, null);
      else if (node.type === "AssignmentPattern") pattern(node.left, scope);
      else if (node.type === "RestElement") pattern(node.argument, scope);
      else if (node.type === "ObjectPattern") node.properties.forEach((p) => pattern(p.value || p.argument, scope));
      else if (node.type === "ArrayPattern") node.elements.forEach((p) => pattern(p, scope));
    }
    function preloadId(node) {
      for (let p = meta.get(node)?.parent; p; p = meta.get(p)?.parent) {
        if (p.type !== "Property" || typeof p.key?.value !== "string" || !p.key.value.endsWith(".js")) continue;
        const object = meta.get(p)?.parent, call = meta.get(object)?.parent, c = call?.callee;
        if (call?.type === "CallExpression" && call.arguments[0] === object && c?.type === "MemberExpression" && c.property.name === "preload"
          && c.object?.type === "MemberExpression" && c.object.property.name === "require" && c.object.object?.type === "MemberExpression"
          && c.object.object.object.name === "sap" && c.object.object.property.name === "ui") return p.key.value.replace(/\.js$/, "");
      }
      return null;
    }
    function walk(node, scope, owner, parent) {
      if (!node?.type) return;
      if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") bind(scope, node.id?.name, node.id, node);
      if (functions.has(node.type)) {
        scope = { parent: scope, bindings: new Map(), functionScope: true };
        if (node.type !== "ArrowFunctionExpression") owner = parent?.type === "Property" && parent.value === node ? meta.get(parent)?.container : parent?.type === "MethodDefinition" ? meta.get(parent)?.container : null;
        bind(scope, node.id?.name, node.id, node);
        node.params.forEach((p) => pattern(p, scope));
      } else if (["BlockStatement", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement", "SwitchStatement", "ClassExpression", "ClassDeclaration"].includes(node.type)) {
        scope = { parent: scope, bindings: new Map(), functionScope: false };
        if (node.type === "CatchClause") pattern(node.param, scope);
        if (node.type.startsWith("Class")) bind(scope, node.id?.name, node.id, node);
      }
      const info = { scope, owner, parent, container: ["Property", "MethodDefinition"].includes(node.type) ? (parent?.type === "ClassBody" ? meta.get(parent)?.parent : parent) : null };
      meta.set(node, info); nodes.push(node);
      if (node.type === "VariableDeclarator") {
        let target = scope;
        if (parent.kind === "var") while (!target.functionScope && target.parent) target = target.parent;
        if (node.id.type === "Identifier") bind(target, node.id.name, node.id, node.init); else pattern(node.id, target);
      }
      if (node.type === "ImportDeclaration") {
        moduleLinks.set(node.source, { module: node.source.value, imported: "*", moduleOnly: true });
        for (const spec of node.specifiers) bind(scope, spec.local.name, spec.local, { module: node.source.value, imported: spec.type === "ImportDefaultSpecifier" ? "default" : spec.type === "ImportNamespaceSpecifier" ? "*" : spec.imported.name });
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "start", "end"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach((child) => walk(child, scope, owner, node));
        else if (value?.type) walk(value, scope, owner, node);
      }
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
        const c = node.callee, object = c.object;
        if (["define", "predefine", "require"].includes(c.property.name) && object.type === "MemberExpression" && object.object.name === "sap" && object.property.name === "ui") {
          const args = node.arguments, deps = args.find((a) => a.type === "ArrayExpression"), factory = args.find((a) => functions.has(a.type));
          if (factory) {
            const factoryScope = meta.get(factory).scope;
            const id = typeof args[0]?.value === "string" ? args[0].value : preloadId(node);
            deps?.elements.forEach((dep, i) => {
              if (typeof dep?.value !== "string") return;
              // Relative dependencies in a preload are relative to the named module,
              // not to Component-preload.js, which may contain many modules.
              const module = id && dep.value.startsWith(".") ? new URL(dep.value, "https://ui5.invalid/" + id).pathname.slice(1) : dep.value;
              const ref = { module, imported: "default", ui5: true };
              moduleLinks.set(dep, { ...ref, moduleOnly: true });
              if (factory.params[i]?.type === "Identifier") bind(factoryScope, factory.params[i].name, factory.params[i], ref);
            });
            const returns = nodes.filter((n) => n.type === "ReturnStatement" && n.start > factory.start && n.end < factory.end && enclosingFunction(n) === factory);
            if (c.property.name !== "require") modules.push({ id, value: factory.type === "ArrowFunctionExpression" && factory.body.type !== "BlockStatement" ? factory.body : returns.length === 1 ? returns[0].argument : null, node: factory });
          }
        }
        if (!c.computed && c.property.name === "forEach" && object.type === "ArrayExpression" && object.elements.length
          && object.elements.every((e) => typeof e?.value === "string")) {
          const callback = node.arguments[0];
          if (functions.has(callback?.type) && callback.params[0]?.type === "Identifier") {
            const b = meta.get(callback).scope.bindings.get(callback.params[0].name);
            b.iterationKeys = object.elements.map((e) => e.value);
          }
        }
      }
      // Bind arguments of a synchronous inline factory for static lookup only.
      // The factory itself is never invoked by the inspector.
      if (node.type === "CallExpression" && functions.has(node.callee.type) && !node.callee.async && !node.callee.generator) {
        const scope = meta.get(node.callee).scope;
        node.callee.params.forEach((p, i) => { if (p.type === "Identifier" && node.arguments[i]?.type !== "SpreadElement") scope.bindings.get(p.name).value = node.arguments[i]; });
      }
      if (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) moduleLinks.set(node.source, { module: node.source.value, imported: "*", moduleOnly: true });
      if (node.type === "ExportDefaultDeclaration") exports.set("default", node.declaration);
      if (node.type === "ExportNamedDeclaration") {
        if (node.declaration?.id) exports.set(node.declaration.id.name, node.declaration);
        for (const d of node.declaration?.declarations || []) {
          const names = (p) => {
            if (!p) return;
            if (p.type === "Identifier") exports.set(p.name, p);
            else if (p.type === "AssignmentPattern") names(p.left);
            else if (p.type === "RestElement") names(p.argument);
            else if (p.type === "ObjectPattern") p.properties.forEach((v) => names(v.value || v.argument));
            else if (p.type === "ArrayPattern") p.elements.forEach(names);
          };
          names(d.id);
        }
        for (const s of node.specifiers) exports.set(s.exported.name ?? s.exported.value, node.source ? { module: node.source.value, imported: s.local.name ?? s.local.value } : s.local);
      }
      if (node.type === "ExportAllDeclaration") {
        const ref = { module: node.source.value, imported: "*" };
        if (node.exported) exports.set(node.exported.name ?? node.exported.value, ref);
        else exportStars.push(ref);
      }
    }
    function enclosingFunction(node) { let p = meta.get(node)?.parent; while (p && !functions.has(p.type)) p = meta.get(p)?.parent; return p; }
    walk(ast, root, null, null);
    // Reassigned bindings cannot be safely resolved without executing the app.
    for (const node of nodes) {
      const target = node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument : null;
      if (target?.type === "Identifier") {
        let scope = meta.get(target)?.scope;
        while (scope && !scope.bindings.has(target.name)) scope = scope.parent;
        if (scope) { const b = scope.bindings.get(target.name); b.value = null; delete b.iterationKeys; }
      }
    }
    return { url, content, ast, nodes, meta, modules, exports, exportStars, moduleLinks };
  }
  function create(resources, { moduleUrls = {} } = {}) {
    const docs = resources.map((r) => ({ url: r.url, content: r.content }));
    const ensure = (doc) => { if (!doc.parsed) { Object.assign(doc, index(doc.url, doc.content)); doc.parsed = true; } return doc; };
    function binding(doc, node) {
      let scope = doc.meta.get(node)?.scope;
      while (scope) { if (scope.bindings.has(node.name)) return scope.bindings.get(node.name); scope = scope.parent; }
      return null;
    }
    function imported(doc, ref) {
      let expected;
      try { expected = new URL(ref.module, doc.url); } catch { return []; }
      const clean = (s) => s.replace(/-dbg(?=\.js$)/, "").replace(/\.js$/, "");
      const candidates = [];
      for (const d of docs) {
        let match = false;
        try { const u = new URL(d.url), path = /^(?:\.{1,2}\/|\/|[a-z][a-z\d+.-]*:)/i.test(ref.module); match = (u.origin === expected.origin || (ref.ui5 && !path)) && (path ? clean(u.pathname) === clean(expected.pathname) : clean(u.pathname).endsWith("/" + clean(ref.module))); } catch { /* Non-URL source names cannot resolve imports. */ }
        if (ref.ui5 && Object.hasOwn(moduleUrls, ref.module)) {
          try { const mapped = new URL(moduleUrls[ref.module]), actual = new URL(d.url); match = mapped.origin === actual.origin && clean(mapped.pathname) === clean(actual.pathname); } catch { /* Keep the static match if a loader URL is invalid. */ }
        }
        if (!match && ![ref.module, ref.module + ".js"].some((id) => d.content.includes(JSON.stringify(id)) || d.content.includes("'" + id + "'"))) continue;
        ensure(d); if (d.error) continue;
        const named = d.modules.filter((m) => m.id === ref.module || (ref.module.startsWith(".") && m.id === clean(expected.pathname).replace(/^\//, "")));
        if (named.length) named.forEach((m) => candidates.push({ doc: d, node: ref.moduleOnly ? m.node : m.value }));
        else if (match) {
          if (ref.moduleOnly) candidates.push({ doc: d, node: d.ast });
          else if (ref.imported === "*") candidates.push({ doc: d, namespace: true });
          else if (d.exports.has(ref.imported)) candidates.push({ doc: d, node: d.exports.get(ref.imported) });
          else if (ref.imported === "default" && d.modules.length === 1) candidates.push({ doc: d, node: d.modules[0].value });
          else if (ref.imported !== "default") candidates.push({ doc: d, namespace: true, member: ref.imported });
        }
      }
      return candidates.filter((c) => c.node || c.namespace);
    }
    function values(doc, node, seen = new Set()) {
      if (!node || seen.has(node)) return [];
      seen = new Set(seen).add(node);
      if (node.module) return imported(doc, node).flatMap((v) => v.member ? members(v, v.member, seen).flatMap((m) => values(m.doc, m.node, seen)) : v.namespace ? [v] : values(v.doc, v.node, seen));
      if (node.type === "Identifier") { const b = binding(doc, node); return b ? values(doc, b.value, seen) : []; }
      if (node.type === "ThisExpression") { const owner = doc.meta.get(node)?.owner; return owner ? [{ doc, node: owner }] : []; }
      if (node.type === "Super") {
        const owner = doc.meta.get(node)?.owner;
        return owner?.superClass ? values(doc, owner.superClass, seen) : [];
      }
      if (node.type === "NewExpression") return values(doc, node.callee, seen).filter((v) => v.node?.type.startsWith("Class") || functions.has(v.node?.type) || v.node?.type === "ObjectExpression");
      if (node.type === "ChainExpression") return values(doc, node.expression, seen);
      if (node.type === "CallExpression" && functions.has(node.callee.type) && !node.callee.async && !node.callee.generator) {
        const factory = node.callee;
        if (factory.body.type !== "BlockStatement") return values(doc, factory.body, seen);
        const returns = doc.nodes.filter((n) => n.type === "ReturnStatement" && n.start > factory.start && n.end < factory.end
          && (() => { let p = doc.meta.get(n)?.parent; while (p && !functions.has(p.type)) p = doc.meta.get(p)?.parent; return p === factory; })());
        return returns.length === 1 && doc.meta.get(returns[0]).parent === factory.body ? values(doc, returns[0].argument, seen) : [];
      }
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
        && node.callee.object.name === "Object" && node.callee.property.name === "create" && !binding(doc, node.callee.object)
        && node.arguments[0]?.type === "Literal" && node.arguments[0].value === null) return [{ doc, node }];
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "extend") {
        const object = node.arguments.at(-1); return object?.type === "ObjectExpression" ? [{ doc, node: object }] : [];
      }
      if (node.type === "MemberExpression") {
        const name = !node.computed ? node.property.name : typeof node.property.value === "string" ? node.property.value : null;
        if (name === "prototype") return values(doc, node.object, seen).filter((v) => functions.has(v.node?.type) || v.node?.type.startsWith("Class") || v.node?.type === "ObjectExpression");
        return name ? values(doc, node.object, seen).flatMap((v) => members(v, name, seen)).flatMap((v) => values(v.doc, v.node, seen)) : [];
      }
      return [{ doc, node }];
    }
    function members(value, name, seen = new Set()) {
      const { doc, node } = value;
      if (value.namespace) {
        if (doc.exports.has(name)) return [{ doc, node: doc.exports.get(name) }];
        if (name === "default") return [];
        return doc.exportStars.filter((ref) => !seen.has(ref)).flatMap((ref) => imported(doc, ref).flatMap((v) => members(v, name, new Set(seen).add(ref))));
      }
      const properties = node.type === "ObjectExpression" ? node.properties : node.type.startsWith("Class") ? node.body.body : [];
      if (properties.some((p) => p.type === "SpreadElement" || (p.computed && keyName(p) === null))) return [];
      const own = properties.filter((p) => keyName(p) === name && p.kind !== "set");
      const original = own.map((p) => ({ doc, node: p.value, definition: p.key }));
      // UI5 libraries commonly attach APIs after creating the exported class or
      // object: MessageBox.alert = ..., Control.prototype.setValue = ... .
      if (!seen.has(node)) {
        const assigned = doc.nodes.filter((n) => !seen.has(n) && n.type === "AssignmentExpression" && n.operator === "=" && n.left.type === "MemberExpression"
          && (!n.left.computed ? n.left.property.name === name : n.left.property.value === name || (n.left.property.type === "Identifier" && binding(doc, n.left.property)?.iterationKeys?.includes(name)))
          && values(doc, n.left.object, new Set(seen).add(n)).some((v) => v.doc === doc && v.node === node));
        if (assigned.length) {
          const wrappers = assigned.filter((n) => n.left.computed && n.left.property.type === "Identifier" && binding(doc, n.left.property)?.iterationKeys);
          if (original.length && wrappers.length) return [...original.map((v) => ({ ...v, label: "Método original" })), ...wrappers.map((n) => ({ doc, node: n.right, definition: n.right, label: "Wrapper asignado" }))];
          if (!original.length) return assigned.map((n) => ({ doc, node: n.right, definition: n.left.property }));
        }
      }
      if (original.length) return original;
      if (node.superClass && !seen.has(node)) return values(doc, node.superClass, new Set(seen).add(node)).flatMap((v) => members(v, name, new Set(seen).add(node)));
      // UI5 Controller.extend: inherited methods come from the base module.
      const parent = doc.meta.get(node)?.parent;
      if (parent?.type === "CallExpression" && parent.callee.type === "MemberExpression" && parent.callee.property.name === "extend" && !seen.has(node)) return values(doc, parent.callee.object, new Set(seen).add(node)).flatMap((v) => members(v, name, new Set(seen).add(node)));
      return [];
    }
    // Declaration lookup is independent of value inference: reassigned variables,
    // parameters and destructuring still have a known lexical declaration.
    function definitions(doc, node, seen = new Set()) {
      if (!node || seen.has(node)) return [];
      seen = new Set(seen).add(node);
      if (node.module) return imported(doc, node).flatMap((v) => v.namespace
        ? v.member ? members(v, v.member, seen).flatMap((m) => definitions(m.doc, m.node, seen)) : [{ doc: v.doc, definition: v.doc.ast }]
        : definitions(v.doc, v.node, seen));
      if (node.type === "Identifier") {
        const b = binding(doc, node);
        return b ? b.value?.module ? definitions(doc, b.value, seen) : [{ doc, definition: b.node }] : [];
      }
      return [{ doc, definition: node.id || node }];
    }
    function resolve(url, offset) {
      const doc = docs.find((d) => d.url === url);
      if (doc) ensure(doc);
      if (!doc || doc.error) return { error: doc?.error || "Recurso no disponible." };
      const link = [...doc.moduleLinks].find(([n]) => n.start <= offset && offset < n.end);
      if (link) {
        const locations = imported(doc, link[1]).map((v) => ({ url: v.doc.url, offset: v.node.start, line: v.node.loc.start.line - 1, column: v.node.loc.start.column, name: link[1].module }));
        const unique = [...new Map(locations.map((l) => [`${l.url}:${l.offset}`, l])).values()];
        return unique.length ? { locations: unique } : { error: `El módulo «${link[1].module}» no está disponible en los scripts cargados.` };
      }
      const token = doc.nodes.filter((n) => n.type === "Identifier" && n.start <= offset && offset < n.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      if (!token) return { error: "Selecciona el nombre de una función, método, variable o constante." };
      const parent = doc.meta.get(token).parent;
      let found;
      if (parent.type === "MemberExpression" && parent.property === token && !parent.computed) found = values(doc, parent.object).flatMap((v) => members(v, token.name)).flatMap((v) => v.definition ? [v] : definitions(v.doc, v.node));
      else if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.key === token && !parent.shorthand) found = [];
      else found = definitions(doc, token);
      const locations = found.map((v) => { const n = v.definition || v.node; return { url: v.doc.url, offset: n.start, line: n.loc.start.line - 1, column: n.loc.start.column, name: token.name, ...(v.label ? { label: v.label } : {}) }; });
      const unique = [...new Map(locations.map((l) => [`${l.url}:${l.offset}`, l])).values()];
      return unique.length ? { locations: unique } : { error: `No se puede resolver «${token.name}» de forma estática con los scripts cargados.` };
    }
    function moduleOffsets(url) {
      const doc = docs.find((d) => d.url === url);
      if (doc) ensure(doc);
      return doc && !doc.error ? [...doc.moduleLinks.keys()].map((n) => n.start) : [];
    }
    function moduleNames(url) {
      const doc = docs.find((d) => d.url === url);
      if (doc) ensure(doc);
      return doc && !doc.error ? [...new Set([...doc.moduleLinks.values()].filter((r) => r.ui5 && !r.module.startsWith(".")).map((r) => r.module))] : [];
    }
    return { resolve, moduleOffsets, moduleNames, documents: docs };
  }
  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.UI5CodeNavigation = api;
})();
