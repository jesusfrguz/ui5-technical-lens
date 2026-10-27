"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..", "demo");
const mockOData = require("./mock-odata.cjs");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".json": "application/json; charset=utf-8" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (mockOData(req, res, url)) return;
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, `.${relative === "/" ? "/index.html" : relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(data);
  });
});
if (require.main === module) server.listen(Number(process.env.PORT || 4173), "127.0.0.1", () => console.log("Demo: http://127.0.0.1:4173"));
module.exports = server;
