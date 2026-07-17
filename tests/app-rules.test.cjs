const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deleteAppBinding,
  normalizeAppBindings,
  normalizeProcessKey,
  resolveAutomaticMode,
  updateAppBinding,
  upsertAppBinding
} = require("../electron/app-rules.cjs");

const remoteHints = ["anydesk", "rustdesk", "vnc"];

test("normalizes executable names and Windows paths", () => {
  assert.equal(normalizeProcessKey("Codex.exe"), "codex");
  assert.equal(normalizeProcessKey("C:\\Tools\\AnyDesk.exe"), "anydesk");
});

test("uses a saved application binding before built-in remote hints", () => {
  const bindings = upsertAppBinding([], { process: "AnyDesk.exe", title: "Remote Mac" }, "windows");
  const result = resolveAutomaticMode({ process: "AnyDesk.exe", title: "Remote Mac" }, bindings, remoteHints);
  assert.equal(result.mode, "windows");
  assert.equal(result.source, "app_binding");
});

test("uses built-in hints when no user binding exists", () => {
  const result = resolveAutomaticMode({ process: "AnyDesk.exe", title: "Session" }, [], remoteHints);
  assert.equal(result.mode, "mac_remote");
  assert.equal(result.source, "built_in_hint");
});

test("falls back to Windows for ordinary local applications", () => {
  const result = resolveAutomaticMode({ process: "Codex.exe", title: "Codex" }, [], remoteHints);
  assert.equal(result.mode, "windows");
  assert.equal(result.source, "windows_default");
});

test("upserts, updates and removes one rule per process", () => {
  let bindings = upsertAppBinding([], { process: "Codex.exe", title: "First" }, "windows");
  bindings = upsertAppBinding(bindings, { process: "CODEX.EXE", title: "Second" }, "mac_remote");
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].lastTitle, "Second");
  assert.equal(bindings[0].mode, "mac_remote");

  bindings = updateAppBinding(bindings, "codex", "windows");
  assert.equal(bindings[0].mode, "windows");
  assert.deepEqual(deleteAppBinding(bindings, "Codex.exe"), []);
});

test("drops invalid and duplicate persisted bindings", () => {
  const bindings = normalizeAppBindings([
    { processKey: "codex", process: "Codex.exe", mode: "windows" },
    { processKey: "CODEX", process: "Codex.exe", mode: "mac_remote" },
    { processKey: "broken", mode: "auto" }
  ]);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].mode, "windows");
});
