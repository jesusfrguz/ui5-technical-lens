"use strict";
require("./browser-context.cjs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
