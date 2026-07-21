#!/usr/bin/env node
"use strict";

const { main } = require("../lib/provider");

main(process.argv.slice(2)).catch((error) => {
  const safe = error && error.safeMessage ? error.safeMessage : "grok-worker failed";
  process.stderr.write(`${safe}\n`);
  process.exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
});
