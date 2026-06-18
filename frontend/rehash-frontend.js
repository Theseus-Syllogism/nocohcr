#!/usr/bin/env node
/* Blindvault — content-hash the frontend entry bundle and rewrite index.html.
 *
 * Why: dist files are edited IN PLACE on this server (no source tree), so the
 * URL stays constant across content changes and caches serve stale JS until the
 * service-worker shell version is bumped by hand. Content-hashing makes the URL
 * change whenever the content changes, so the browser + SW fetch the new file
 * automatically (the SW serves "/" stale-while-revalidate, so the updated
 * index.html — and thus the new bundle URL — propagates on the next load with
 * NO manual SW bump). Old hashed bundles are kept (immutable, harmless) so any
 * client still holding a cached old index.html doesn't 404.
 *
 * Usage:
 *   node rehash-frontend.js              # rehash the entry bundle + index.html
 *   node rehash-frontend.js --prune      # also delete main-*.js not referenced by index.html
 *
 * Run this after any in-place edit to dist/main-*.js instead of bumping the SW.
 * NOTE: chunks (dist/chunks/*.js) are referenced from inside the bundle, not
 * index.html — editing a chunk in place still needs the SW ?v bump (or a future
 * extension here that rewrites the bundle's import strings then rehashes).
 */
"use strict";
const fs = require("fs");
const crypto = require("crypto");

const ROOT = "/var/www/blindvault";
const IDX = ROOT + "/index.html";
const prune = process.argv.includes("--prune");

let idx = fs.readFileSync(IDX, "utf8");
const m = idx.match(/\/dist\/(main-[A-Za-z0-9]+\.js)/);
if (!m) {
  console.error("ERROR: no /dist/main-*.js reference found in index.html");
  process.exit(1);
}
const curRel = m[0];                 // "/dist/main-3879D0B3.js"
const curName = m[1];                // "main-3879D0B3.js"
const curFile = ROOT + "/dist/" + curName;
if (!fs.existsSync(curFile)) {
  console.error("ERROR: referenced bundle missing: " + curFile);
  process.exit(1);
}

const buf = fs.readFileSync(curFile);
const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8).toUpperCase();
const newName = "main-" + hash + ".js";
const newRel = "/dist/" + newName;

if (newName === curName) {
  console.log("unchanged: index.html already references " + curName + " (content hash matches)");
} else {
  // Write the new content-addressed copy (keep the old file for in-flight clients).
  fs.writeFileSync(ROOT + "/dist/" + newName, buf);
  // Update the single reference in index.html (plain string replace; the hashed
  // name is unique so this can't mismatch).
  idx = idx.split(curRel).join(newRel);
  fs.writeFileSync(IDX, idx);
  console.log("rehashed entry bundle: " + curName + " -> " + newName);
  console.log("updated index.html reference.");
}

if (prune) {
  const keep = new Set([fs.readFileSync(IDX, "utf8").match(/\/dist\/(main-[A-Za-z0-9]+\.js)/)[1]]);
  for (const f of fs.readdirSync(ROOT + "/dist")) {
    if (/^main[-.][A-Za-z0-9]+\.js$/.test(f) && !keep.has(f)) {
      fs.unlinkSync(ROOT + "/dist/" + f);
      console.log("pruned old bundle: " + f);
    }
  }
}
