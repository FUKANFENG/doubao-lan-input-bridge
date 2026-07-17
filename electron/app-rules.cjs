const path = require("node:path");

const BINDING_MODES = new Set(["windows", "mac_remote"]);
const MAX_BINDINGS = 50;

function clampText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeProcessKey(value) {
  const raw = clampText(value, 1024);
  if (!raw) return "";
  return path.win32.basename(raw).replace(/\.exe$/i, "").trim().toLowerCase();
}

function sanitizeForegroundInfo(value = {}) {
  const executablePath = clampText(value.path, 1024);
  const process = clampText(value.process, 160) || path.win32.basename(executablePath);
  return {
    pid: Number.isInteger(Number(value.pid)) ? Number(value.pid) : 0,
    process,
    processKey: normalizeProcessKey(value.processKey || process || executablePath),
    title: clampText(value.title, 500),
    path: executablePath
  };
}

function normalizeBinding(value = {}) {
  const processKey = normalizeProcessKey(value.processKey || value.process || value.path);
  const mode = BINDING_MODES.has(value.mode) ? value.mode : "";
  if (!processKey || !mode) return null;
  return {
    processKey,
    process: clampText(value.process, 160) || processKey,
    path: clampText(value.path, 1024),
    lastTitle: clampText(value.lastTitle || value.title, 500),
    mode,
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

function normalizeAppBindings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const bindings = [];
  for (const item of value) {
    const binding = normalizeBinding(item);
    if (!binding || seen.has(binding.processKey)) continue;
    seen.add(binding.processKey);
    bindings.push(binding);
    if (bindings.length >= MAX_BINDINGS) break;
  }
  return bindings;
}

function findAppBinding(foreground, bindings) {
  const info = sanitizeForegroundInfo(foreground);
  if (!info.processKey) return null;
  return normalizeAppBindings(bindings).find((item) => item.processKey === info.processKey) || null;
}

function resolveAutomaticMode(foreground, bindings, remoteHints = []) {
  const info = sanitizeForegroundInfo(foreground);
  const binding = findAppBinding(info, bindings);
  if (binding) {
    return { mode: binding.mode, source: "app_binding", foreground: info, binding };
  }

  const haystack = `${info.processKey} ${info.process} ${info.title}`.toLowerCase();
  const remoteHint = remoteHints.some((item) => haystack.includes(String(item).toLowerCase()));
  const macHint = /mac|darwin|osx|os x/.test(haystack);
  return {
    mode: remoteHint || macHint ? "mac_remote" : "windows",
    source: remoteHint || macHint ? "built_in_hint" : "windows_default",
    foreground: info,
    binding: null
  };
}

function upsertAppBinding(bindings, foreground, mode) {
  if (!BINDING_MODES.has(mode)) throw new Error("invalid binding mode");
  const info = sanitizeForegroundInfo(foreground);
  if (!info.processKey) throw new Error("无法识别当前前台应用，请保持目标应用在电脑前台后重试");
  const existing = findAppBinding(info, bindings);
  const binding = {
    processKey: info.processKey,
    process: info.process || existing?.process || info.processKey,
    path: info.path || existing?.path || "",
    lastTitle: info.title || existing?.lastTitle || "",
    mode,
    updatedAt: Date.now()
  };
  return [binding, ...normalizeAppBindings(bindings).filter((item) => item.processKey !== info.processKey)].slice(
    0,
    MAX_BINDINGS
  );
}

function updateAppBinding(bindings, processKey, mode) {
  if (!BINDING_MODES.has(mode)) throw new Error("invalid binding mode");
  const key = normalizeProcessKey(processKey);
  const current = normalizeAppBindings(bindings);
  if (!current.some((item) => item.processKey === key)) throw new Error("binding not found");
  return current.map((item) =>
    item.processKey === key ? { ...item, mode, updatedAt: Date.now() } : item
  );
}

function deleteAppBinding(bindings, processKey) {
  const key = normalizeProcessKey(processKey);
  return normalizeAppBindings(bindings).filter((item) => item.processKey !== key);
}

module.exports = {
  deleteAppBinding,
  findAppBinding,
  normalizeAppBindings,
  normalizeProcessKey,
  resolveAutomaticMode,
  sanitizeForegroundInfo,
  updateAppBinding,
  upsertAppBinding
};
