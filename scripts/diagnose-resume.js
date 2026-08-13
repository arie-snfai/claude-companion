#!/usr/bin/env node
// Explains why auto-resume is or is not picking up interrupted work on this
// machine. Standalone on purpose: copy it anywhere and run `node
// diagnose-resume.js`, no build and no dependencies needed.

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_AGE_MS = 12 * 60 * 60 * 1000; // must match interruptedSession.ts
const TRANSCRIPTS = path.join(os.homedir(), ".claude", "projects");
const now = Date.now();

function heading(text) {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

heading("1. Which build is installed");
const extensionsDir = path.join(os.homedir(), ".vscode", "extensions");
let installed = [];
try {
  installed = fs.readdirSync(extensionsDir).filter((name) => name.includes("claude-companion"));
} catch {
  console.log(`  cannot read ${extensionsDir}`);
}
if (installed.length === 0) {
  console.log("  no claude-companion build installed for this VS Code");
}
for (const name of installed) {
  const bundle = path.join(extensionsDir, name, "out", "extension.js");
  let code = "";
  try {
    code = fs.readFileSync(bundle, "utf8");
  } catch {
    console.log(`  ${name}: no out/extension.js`);
    continue;
  }
  const hasResume = code.includes("autoResume");
  const surface = code.includes("claude-vscode.editor.open")
    ? "Claude Code panel"
    : code.includes("createTerminal")
      ? "terminal (old behavior)"
      : "n/a";
  console.log(`  ${name}`);
  console.log(`    auto-resume code: ${hasResume ? "present" : "MISSING, this build cannot resume anything"}`);
  console.log(`    resumes into    : ${hasResume ? surface : "n/a"}`);
  console.log(`    built           : ${fs.statSync(bundle).mtime.toISOString()}`);
}
console.log("\n  Remember that installing a build only takes effect after a window reload.");

heading("2. Is the setting on");
const settingsPaths = [
  path.join(os.homedir(), ".config", "Code", "User", "settings.json"),
  path.join(os.homedir(), "Library", "Application Support", "Code", "User", "settings.json"),
  path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "settings.json"),
];
let settingsFound = false;
for (const file of settingsPaths) {
  if (!fs.existsSync(file)) continue;
  settingsFound = true;
  const text = fs.readFileSync(file, "utf8");
  const hits = text.match(/"claudeCompanion\.[^"]+"\s*:\s*[^,\n}]+/g);
  console.log(`  ${file}`);
  console.log(hits ? hits.map((h) => `    ${h.trim()}`).join("\n") : "    no claudeCompanion settings, so defaults apply (auto-resume on, panel mode)");
}
if (!settingsFound) console.log("  no user settings.json found, so defaults apply (auto-resume on, panel mode)");

heading("3. Sessions the 5h limit interrupted");
let projectDirs = [];
try {
  projectDirs = fs.readdirSync(TRANSCRIPTS, { withFileTypes: true }).filter((d) => d.isDirectory());
} catch {
  console.log(`  cannot read ${TRANSCRIPTS}`);
}

const findings = [];
for (const dir of projectDirs) {
  const dirPath = path.join(TRANSCRIPTS, dir.name);
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dirPath, entry.name);
    const stat = fs.statSync(file);

    const entries = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        /* partial line */
      }
    }
    if (!entries.some((e) => e.isApiErrorMessage && (e.error === "rate_limit" || e.apiErrorStatus === 429))) {
      continue; // never hit the limit, not interesting here
    }

    // Same walk the extension does: is the limit error still the last thing?
    let verdict = "no limit error at the tail";
    let marker;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.isApiErrorMessage && (e.error === "rate_limit" || e.apiErrorStatus === 429)) {
        marker = e;
        verdict = "limit error is the last thing in the transcript";
        break;
      }
      if (e.isApiErrorMessage) continue;
      if (e.type === "user" || e.type === "assistant") {
        verdict = "work continued after the limit, so nothing to resume";
        break;
      }
    }

    const ageMs = now - stat.mtimeMs;
    const ageHours = (ageMs / 3600000).toFixed(1);
    const eligible = Boolean(marker) && ageMs <= MAX_AGE_MS;
    findings.push({
      file: path.relative(TRANSCRIPTS, file),
      cwd: marker?.cwd ?? entries.find((e) => e.cwd)?.cwd ?? "unknown",
      ageHours,
      verdict,
      tooOld: ageMs > MAX_AGE_MS,
      eligible,
    });
  }
}

if (findings.length === 0) {
  console.log("  no transcript on this machine has ever recorded a 5h limit error.");
  console.log("  Nothing to resume, so the feature has nothing to do.");
} else {
  for (const f of findings) {
    console.log(`  ${f.eligible ? "ELIGIBLE" : "skipped "}  ${f.file}`);
    console.log(`             cwd        : ${f.cwd}`);
    console.log(`             last write : ${f.ageHours}h ago${f.tooOld ? "  <-- older than the 12h cut" : ""}`);
    console.log(`             tail       : ${f.verdict}`);
  }
  console.log("\n  An ELIGIBLE session is still only resumed when its cwd is inside a folder");
  console.log("  open in the VS Code window, and the live 5h window is under 90% used.");
}

heading("4. Pings from the auto-start feature");
const pingDir = path.join(TRANSCRIPTS, "-tmp");
let pings = [];
try {
  pings = fs
    .readdirSync(pingDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => fs.statSync(path.join(pingDir, name)).mtime)
    .sort((a, b) => b - a);
} catch {
  /* no pings yet */
}
console.log(
  pings.length
    ? `  ${pings.length} session(s) under projects/-tmp, most recent ${pings[0].toISOString()}`
    : "  none, so the reset ping has never run here",
);
