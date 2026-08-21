#!/usr/bin/env node
/**
 * CY identity normaliser.
 *
 * Rewrites the identifiers inside the CY bundle and the CY webview so that
 * both sides agree with package.json. Extension host <-> webview messaging
 * uses these strings, so they MUST be renamed together.
 *
 * Canonical CY identity:
 *   extension id ....... symbiotyc.cy
 *   uri scheme ......... symbiotyc-cy
 *   chat session type .. symbiotyc-cy
 *   deep link .......... vscode://symbiotyc.cy/
 *   launcher ........... bin/cy-c-wrapper.sh
 *
 * Safe to run repeatedly (idempotent).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = [path.join(ROOT, "out"), path.join(ROOT, "webview", "assets"), path.join(ROOT, "webview")];
const EXT = new Set([".js", ".mjs", ".cjs", ".css", ".map", ".html", ".json"]);

// Order matters: the most specific patterns run first.
const RULES = [
  ["vscode://cy-ide/", "vscode://symbiotyc.cy/"],
  ["vscode://cy/", "vscode://symbiotyc.cy/"],
  ["com.symbiotyc.cy-ide.chat", "com.symbiotyc.cy.chat"],
  ["symbiotyc.cy-ide", "symbiotyc.cy"],
  ["symbiotyc-cy-ide", "symbiotyc-cy"],
  ["cy-codex", "cy-c"],
  ["cy-ide", "cy"],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = new Set();
for (const t of TARGETS) for (const f of walk(t)) files.add(f);

let changed = 0;
const hits = Object.create(null);

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const before = text;
  for (const [from, to] of RULES) {
    if (!text.includes(from)) continue;
    const count = text.split(from).length - 1;
    text = text.split(from).join(to);
    hits[`${from} -> ${to}`] = (hits[`${from} -> ${to}`] || 0) + count;
  }
  if (text !== before) {
    fs.writeFileSync(file, text, "utf8");
    changed++;
  }
}

console.log(`[cy-identity] files scanned: ${files.size}, rewritten: ${changed}`);
for (const [k, v] of Object.entries(hits)) console.log(`  ${k}  x${v}`);
if (!Object.keys(hits).length) console.log("  already normalised");
