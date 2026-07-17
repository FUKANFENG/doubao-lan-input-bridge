const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const WebSocket = require("ws");
const {
  deleteAppBinding,
  findAppBinding,
  normalizeAppBindings,
  resolveAutomaticMode,
  sanitizeForegroundInfo,
  updateAppBinding,
  upsertAppBinding
} = require("./app-rules.cjs");

const APP_NAME = "豆包语音输入桥";
const APP_VERSION = app.getVersion();
const DEFAULT_PORT = 8765;
const MAX_TEXT_LENGTH = 20000;
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
const MODES = new Set(["auto", "windows", "mac_remote"]);
const REMOTE_PROCESS_HINTS = [
  "rustdesk",
  "anydesk",
  "mstsc",
  "parsec",
  "gameviewer",
  "vnc",
  "teamviewer",
  "sunlogin",
  "todesk",
  "nomachine",
  "remotedesktop"
];

let mainWindow = null;
let server = null;
let currentPort = DEFAULT_PORT;
let settings = null;
let logs = [];
let helperProcess = null;
let helperPort = null;
let audioWss = null;
let audioClients = new Set();
let audioState = {
  capturing: false,
  sampleRate: null,
  bytesSent: 0,
  startedAt: null,
  lastChunkAt: null
};

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function userDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function loadSettings() {
  const settingsPath = userDataPath("settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      key: typeof parsed.key === "string" && parsed.key ? parsed.key : newKey(),
      mode: MODES.has(parsed.mode) ? parsed.mode : "auto",
      port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
      appBindings: normalizeAppBindings(parsed.appBindings)
    };
  } catch {
    return { key: newKey(), mode: "auto", port: DEFAULT_PORT, appBindings: [] };
  }
}

function saveSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userDataPath("settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

function newKey() {
  return crypto.randomBytes(18).toString("base64url");
}

function log(message) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`;
  logs.push(line);
  if (logs.length > 300) logs = logs.slice(-300);
  try {
    fs.appendFileSync(userDataPath("service.log"), line + "\n", "utf8");
  } catch {
    // best effort only
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:log", line);
  }
}

function audioStatusPayload() {
  return {
    type: "audio-status",
    capturing: audioState.capturing,
    sampleRate: audioState.sampleRate,
    bytesSent: audioState.bytesSent,
    startedAt: audioState.startedAt,
    lastChunkAt: audioState.lastChunkAt,
    clientCount: audioClients.size
  };
}

function broadcastAudioJson(data) {
  const payload = JSON.stringify(data);
  for (const client of audioClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastAudioChunk(buffer) {
  if (!audioClients.size) return;
  for (const client of audioClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buffer, { binary: true });
    }
  }
}

function sendAudioStatusToWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:audio-status", audioStatusPayload());
  }
}

function getLanAddresses() {
  const result = [];
  const nets = os.networkInterfaces();
  const virtualNamePattern =
    /virtual|vethernet|hyper-v|wsl|docker|vmware|virtualbox|loopback|bluetooth|tap|tailscale|zerotier/i;
  for (const [name, items] of Object.entries(nets)) {
    for (const item of items || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      const ip = item.address;
      const privateIp =
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
      if (!privateIp) continue;
      const virtual = virtualNamePattern.test(name);
      let score = 0;
      if (ip.startsWith("192.168.")) score += 300;
      else if (ip.startsWith("10.")) score += 200;
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score += 100;
      if (!virtual) score += 1000;
      result.push({ ip, name, score });
    }
  }
  return result
    .sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip))
    .map((item) => item.ip);
}

function urlsFor(port = currentPort) {
  const key = settings.key;
  const localUrl = `http://127.0.0.1:${port}/?key=${encodeURIComponent(key)}`;
  const phoneUrls = getLanAddresses().map(
    (ip) => `http://${ip}:${port}/?key=${encodeURIComponent(key)}`
  );
  return { localUrl, phoneUrls, primaryPhoneUrl: phoneUrls[0] || localUrl };
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Doubao-Bridge-Version": APP_VERSION
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Doubao-Bridge-Version": APP_VERSION
  });
  res.end(payload);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mobileHtml(host) {
  const safeKey = escapeHtml(settings.key);
  const safeHost = escapeHtml(host || "LAN service");
  const safeVersion = escapeHtml(APP_VERSION);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>豆包语音输入桥</title>
  <link rel="icon" href="data:,">
  <style>
    :root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#637083;--line:#d9e0ea;--accent:#0f766e;--danger:#b42318;--ok:#137333;--shadow:0 14px 40px rgba(22,32,51,.10);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);padding:max(18px,env(safe-area-inset-top)) 16px max(22px,env(safe-area-inset-bottom))}
    main{width:min(760px,100%);margin:0 auto;display:grid;gap:14px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:4px 2px 2px}
    h1{margin:0;font-size:24px;line-height:1.18;font-weight:750}.titleLine{display:flex;align-items:center;gap:8px}.versionTag{display:inline-flex;align-items:center;min-height:24px;padding:2px 7px;border:1px solid #b9d8d4;border-radius:7px;background:#eff8f7;color:var(--accent);font-size:12px;font-weight:750;white-space:nowrap}.server{margin-top:6px;color:var(--muted);font-size:13px;line-height:1.4;word-break:break-all}
    .status{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 2px 10px rgba(22,32,51,.05);color:var(--muted);font-size:13px;font-weight:650;white-space:nowrap}
    .dot{width:9px;height:9px;border-radius:50%;background:#9aa5b5}.status.ready{color:var(--ok)}.status.ready .dot{background:var(--ok)}
    section{background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:14px}
    textarea{width:100%;min-height:210px;resize:vertical;scroll-margin-top:150px;border:1px solid var(--line);border-radius:8px;padding:13px 14px;color:var(--text);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none;background:#fbfcfe}
    textarea:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(15,118,110,.14);background:#fff}
    .quickActions{position:sticky;top:max(8px,env(safe-area-inset-top));z-index:10;display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,auto);align-items:end;gap:10px 12px;margin:-2px -2px 12px;padding:10px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.96);box-shadow:0 8px 24px rgba(22,32,51,.12);backdrop-filter:blur(12px)}
    .targetControl{display:grid;gap:6px}.controlLabel{color:var(--muted);font-size:13px;font-weight:700}.modeButtons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px;border:1px solid var(--line);border-radius:8px;background:#eef2f6}.autoSummary{overflow:hidden;color:var(--accent);font-size:12px;font-weight:700;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.autoSummary[hidden]{display:none}
    button{display:inline-flex;align-items:center;justify-content:center;min-width:118px;min-height:44px;border:0;border-radius:8px;padding:0 18px;color:#fff;background:var(--accent);font-size:16px;font-weight:750;cursor:pointer}button:disabled{background:#95a3b4;cursor:not-allowed}
    button.modeButton{flex-direction:column;gap:1px;width:100%;min-width:0;min-height:44px;padding:4px 10px;border:1px solid transparent;background:transparent;color:var(--muted);font-size:14px;font-weight:750}button.modeButton small{font-size:11px;font-weight:600;color:inherit}button.modeButton[aria-pressed=true]{border-color:#b9d8d4;background:#fff;color:var(--accent);box-shadow:0 1px 4px rgba(22,32,51,.10)}button.modeButton:focus-visible{outline:3px solid rgba(15,118,110,.2);outline-offset:1px}
    .primarySend{min-width:180px;min-height:52px}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}.checks{display:flex;flex-wrap:wrap;gap:10px 14px;color:var(--muted);font-size:14px}
    label{display:inline-flex;align-items:center;gap:7px;user-select:none}input[type=checkbox]{width:18px;height:18px;accent-color:var(--accent)}input[type=number]{width:70px;min-height:34px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;color:var(--text);background:#fbfcfe;font:14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none}
    .meta{display:grid;gap:8px;color:var(--muted);font-size:13px;line-height:1.45}.meta strong{color:var(--text);font-weight:700}.message{grid-column:1/-1;min-height:20px;color:var(--muted);font-size:13px;line-height:1.4}.message:empty{display:none}.message.ok{color:var(--ok)}.message.err{color:var(--danger)}
    .historyPanel{display:grid;gap:10px}.historyHeader{display:flex;align-items:center;justify-content:space-between;gap:12px}.historyHeading{display:flex;align-items:baseline;gap:8px}.historyHeading h2{margin:0;font-size:16px;line-height:1.3}.historyCount{color:var(--muted);font-size:12px;font-weight:650}.quietButton{min-width:0;min-height:44px;padding:0 10px;border:1px solid var(--line);background:#f5f7fa;color:var(--muted);font-size:13px;font-weight:700}.quietButton:disabled{border-color:var(--line);background:#f5f7fa;color:#a5afbd}.historyEmpty{padding:18px 8px;color:var(--muted);font-size:14px;text-align:center}.historyEmpty[hidden]{display:none}.historyList{display:grid;gap:8px;margin:0;padding:0;list-style:none}.historyItem{display:grid;grid-template-columns:minmax(0,1fr) 76px;gap:8px;align-items:stretch}.historyRecall{display:grid;gap:5px;width:100%;min-width:0;min-height:62px;padding:9px 10px;border:1px solid var(--line);background:#fbfcfe;color:var(--text);text-align:left}.historyRecall:focus-visible,.historySend:focus-visible,.quietButton:focus-visible{outline:3px solid rgba(15,118,110,.18);outline-offset:1px}.historyPreview{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.45}.historyMeta{color:var(--muted);font-size:11px;font-weight:650}.historyMeta.sent{color:var(--ok)}.historyMeta.failed{color:var(--danger)}.historyMeta.pending{color:var(--accent)}.historySend{width:76px;min-width:76px;min-height:62px;padding:0 8px;font-size:14px}
    .automationPanel{display:grid;gap:11px}.sectionHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.sectionHeading{display:grid;gap:3px}.sectionHeading h2{margin:0;font-size:16px;line-height:1.3}.sectionHeading span{color:var(--muted);font-size:12px;line-height:1.4}.currentApp{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.appIdentity{display:grid;gap:3px;min-width:0}.appIdentity strong{overflow:hidden;font-size:15px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.appIdentity span{display:-webkit-box;overflow:hidden;color:var(--muted);font-size:12px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2;word-break:break-all}.modeBadge{display:inline-flex;align-items:center;min-height:30px;padding:4px 9px;border:1px solid #b9d8d4;border-radius:7px;background:#eff8f7;color:var(--accent);font-size:12px;font-weight:750;white-space:nowrap}.modeBadge.mac{border-color:#c9d2e1;background:#f0f3f8;color:#42526a}.automationHint{color:var(--muted);font-size:12px;line-height:1.45}.bindingActions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.bindingActions button{width:100%;min-width:0;min-height:44px;padding:0 9px;font-size:14px}.bindingActions .secondary{border:1px solid var(--line);background:#eef3f8;color:var(--text)}.bindingList{display:grid;gap:0;border-top:1px solid var(--line)}.bindingRow{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.bindingName{display:grid;gap:2px;min-width:0}.bindingName strong{overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.bindingName span{overflow:hidden;color:var(--muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.bindingControls{display:flex;align-items:center;gap:5px}.bindingControls button{min-width:0;min-height:34px;padding:0 8px;border:1px solid var(--line);background:#f5f7fa;color:var(--muted);font-size:12px}.bindingControls button.active{border-color:#b9d8d4;background:#eff8f7;color:var(--accent)}.bindingControls button.delete{color:var(--danger)}.bindingEmpty{padding:10px 0;color:var(--muted);font-size:13px;text-align:center}.bindingEmpty[hidden]{display:none}
    .audioPanel{display:grid;gap:12px}.audioLine{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:14px;line-height:1.45}.audioLine strong{display:block;color:var(--text);font-size:15px}.audioActions{display:flex;gap:10px;flex-wrap:wrap}.audioActions button{min-width:132px}.audioActions .secondary{background:#eef3f8;color:var(--text);border:1px solid var(--line)}.audioDot{width:12px;height:12px;border-radius:50%;background:#9aa5b5;flex:0 0 auto}.audioDot.live{background:var(--ok);box-shadow:0 0 0 5px rgba(19,115,51,.12)}
    @media(max-width:560px){body{padding:max(10px,env(safe-area-inset-top)) 10px max(18px,env(safe-area-inset-bottom))}main{gap:10px}header{align-items:center;padding:2px}.server{display:none}.status{min-height:32px;padding:6px 9px}h1{font-size:20px}.versionTag{min-height:22px;padding:1px 6px;font-size:11px}section{padding:10px}.quickActions{grid-template-columns:1fr;gap:8px;margin:-2px -2px 10px;padding:8px;top:max(6px,env(safe-area-inset-top))}.targetControl{grid-template-columns:1fr;align-items:stretch;gap:6px}.primarySend{width:100%;min-height:48px}.modeButton{width:100%}textarea{min-height:260px;font-size:18px}.toolbar{align-items:stretch}.checks{width:100%}.historyItem{grid-template-columns:minmax(0,1fr) 72px}.historySend{width:72px;min-width:72px}.bindingRow{grid-template-columns:1fr}.bindingControls{justify-content:flex-start}.audioLine{align-items:flex-start}.audioActions{width:100%}.audioActions button{width:100%;min-height:48px}}
  </style>
</head>
<body data-ui-version="${safeVersion}">
  <main>
    <header><div><div class="titleLine"><h1>豆包语音输入桥</h1><span class="versionTag">v${safeVersion}</span></div><div class="server">${safeHost}</div></div><div id="status" class="status"><span class="dot"></span><span>检测中</span></div></header>
    <section>
      <div class="quickActions">
        <div class="targetControl">
          <span id="targetLabel" class="controlLabel">目标系统</span>
          <div class="modeButtons" role="group" aria-labelledby="targetLabel">
            <button class="modeButton" type="button" data-paste-mode="auto" aria-pressed="true"><span>自动</span><small>按应用</small></button>
            <button class="modeButton" type="button" data-paste-mode="windows" aria-pressed="false"><span>Windows</span><small>Ctrl+V</small></button>
            <button class="modeButton" type="button" data-paste-mode="mac_remote" aria-pressed="false"><span>Mac</span><small>Win+V</small></button>
          </div>
          <input id="pasteMode" type="hidden" value="auto">
          <div id="autoSummary" class="autoSummary">正在识别电脑当前应用...</div>
        </div>
        <button id="send" class="primarySend" type="button">自动识别并发送</button>
        <div id="message" class="message" role="status" aria-live="polite"></div>
      </div>
      <textarea id="text" placeholder="点这里，用手机豆包输入法语音转文字，然后发送到电脑当前输入框。"></textarea>
      <div class="toolbar"><div class="checks">
        <label><input id="clearAfterSend" type="checkbox" checked>发送后清空</label>
        <label><input id="newline" type="checkbox">末尾加换行</label>
        <label><input id="pressEnter" type="checkbox">发送后回车</label>
        <label>回车延时 <input id="enterDelay" type="number" min="0" max="5" step="0.1" value="0.5"> 秒</label>
      </div></div>
    </section>
    <section class="automationPanel" aria-labelledby="automationTitle">
      <div class="sectionHeader">
        <div class="sectionHeading"><h2 id="automationTitle">应用自动匹配</h2><span id="automationSource">发送时按电脑前台应用选择粘贴方式</span></div>
        <button id="automationRefresh" class="quietButton" type="button">刷新</button>
      </div>
      <div class="currentApp">
        <div class="appIdentity"><strong id="currentAppName">正在识别...</strong><span id="currentAppTitle">请把电脑焦点放在目标应用</span></div>
        <span id="resolvedMode" class="modeBadge">Windows</span>
      </div>
      <div class="automationHint">手机绑定时不会改变电脑焦点。先在电脑上点一下目标应用，再在这里绑定；以后发送会自动匹配。</div>
      <div class="bindingActions">
        <button id="bindWindows" type="button">绑定为 Windows</button>
        <button id="bindMac" class="secondary" type="button">绑定为 Mac</button>
      </div>
      <div id="bindingMessage" class="message" role="status" aria-live="polite"></div>
      <div id="bindingEmpty" class="bindingEmpty">尚未保存应用绑定</div>
      <div id="bindingList" class="bindingList"></div>
    </section>
    <section class="historyPanel" aria-labelledby="historyTitle">
      <div class="historyHeader"><div class="historyHeading"><h2 id="historyTitle">最近输入</h2><span id="historyCount" class="historyCount">0/10</span></div><button id="clearHistory" class="quietButton" type="button" disabled>清空</button></div>
      <div id="historyEmpty" class="historyEmpty">暂无历史记录</div>
      <ol id="historyList" class="historyList"></ol>
    </section>
    <section class="audioPanel">
      <div class="audioLine"><span id="audioDot" class="audioDot"></span><div><strong id="audioTitle">电脑声音未连接</strong><span id="audioDetail">点击开始播放后，手机会连接电脑并等待音频流。</span></div></div>
      <div class="audioActions"><button id="audioStart" type="button">开始播放电脑声音</button><button id="audioStop" class="secondary" type="button" disabled>停止播放</button></div>
      <div id="audioMessage" class="message"></div>
    </section>
    <section class="meta"><div><strong>手机页面：</strong>v${safeVersion}</div><div><strong>电脑端：</strong><span id="target">自动识别模式</span></div><div><strong>提示：</strong>电脑上先点到目标输入框，再在手机上发送。自动模式按前台应用绑定选择 Windows 或 Mac 远程粘贴。</div></section>
  </main>
  <script>
    const ACCESS_KEY="${safeKey}";
    const HISTORY_KEY="doubaoInputHistoryV1";
    const DRAFT_KEY="doubaoInputDraftV1";
    const PASTE_MODE_KEY="doubaoPasteModeV2";
    const statusEl=document.getElementById("status"),statusText=statusEl.querySelector("span:last-child"),targetEl=document.getElementById("target"),textEl=document.getElementById("text"),sendBtn=document.getElementById("send"),messageEl=document.getElementById("message"),clearAfterSendEl=document.getElementById("clearAfterSend"),newlineEl=document.getElementById("newline"),pressEnterEl=document.getElementById("pressEnter"),enterDelayEl=document.getElementById("enterDelay"),pasteModeEl=document.getElementById("pasteMode"),pasteModeButtons=[...document.querySelectorAll("[data-paste-mode]")],autoSummaryEl=document.getElementById("autoSummary"),historyListEl=document.getElementById("historyList"),historyEmptyEl=document.getElementById("historyEmpty"),historyCountEl=document.getElementById("historyCount"),clearHistoryBtn=document.getElementById("clearHistory"),automationRefreshEl=document.getElementById("automationRefresh"),automationSourceEl=document.getElementById("automationSource"),currentAppNameEl=document.getElementById("currentAppName"),currentAppTitleEl=document.getElementById("currentAppTitle"),resolvedModeEl=document.getElementById("resolvedMode"),bindWindowsEl=document.getElementById("bindWindows"),bindMacEl=document.getElementById("bindMac"),bindingMessageEl=document.getElementById("bindingMessage"),bindingEmptyEl=document.getElementById("bindingEmpty"),bindingListEl=document.getElementById("bindingList"),audioStartEl=document.getElementById("audioStart"),audioStopEl=document.getElementById("audioStop"),audioTitleEl=document.getElementById("audioTitle"),audioDetailEl=document.getElementById("audioDetail"),audioMessageEl=document.getElementById("audioMessage"),audioDotEl=document.getElementById("audioDot");
    let audioCtx=null,audioWs=null,audioSampleRate=48000,nextAudioTime=0,audioPlaying=false,sendInFlight=false,bindingBusy=false,automationLoading=false,automationState=null;
    let history=loadHistory();
    let lastNonEmptyDraft=readStoredString(DRAFT_KEY);

    function readStoredString(key){try{return localStorage.getItem(key)||""}catch{return ""}}
    function normalizePasteMode(mode){return mode==="mac_remote"?"mac_remote":mode==="windows"?"windows":"auto"}
    function loadHistory(){try{const parsed=JSON.parse(localStorage.getItem(HISTORY_KEY)||"[]");if(!Array.isArray(parsed))return[];return parsed.filter((item)=>item&&typeof item.id==="string"&&typeof item.text==="string"&&item.text.trim()).map((item)=>({id:item.id,text:item.text,time:Number(item.time)||Date.now(),status:["saved","pending","sent","failed"].includes(item.status)?item.status:"saved",mode:normalizePasteMode(item.mode)})).slice(0,10)}catch{return[]}}
    function persistHistory(){try{localStorage.setItem(HISTORY_KEY,JSON.stringify(history))}catch{setMessage("历史记录保存空间不足。","err")}}
    function storeDraft(value){try{if(value)localStorage.setItem(DRAFT_KEY,value);else localStorage.removeItem(DRAFT_KEY)}catch{}}
    function historyStatusLabel(status){if(status==="sent")return"已发送";if(status==="failed")return"发送失败";if(status==="pending")return"发送中";return"已保存"}
    function historyModeLabel(mode){return mode==="mac_remote"?"Mac":mode==="auto"?"自动":"Windows"}
    function historyTimeLabel(value){const date=new Date(value),now=new Date(),time=date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false});return date.toDateString()===now.toDateString()?time:(date.getMonth()+1)+"/"+date.getDate()+" "+time}
    function renderHistory(){historyListEl.replaceChildren();historyCountEl.textContent=history.length+"/10";historyEmptyEl.hidden=history.length>0;clearHistoryBtn.disabled=history.length===0||sendInFlight;history.forEach((entry)=>{const item=document.createElement("li");item.className="historyItem";const recall=document.createElement("button");recall.type="button";recall.className="historyRecall";recall.setAttribute("aria-label","将这条历史记录填入文本框");const preview=document.createElement("span");preview.className="historyPreview";preview.textContent=entry.text;const meta=document.createElement("span");meta.className="historyMeta "+entry.status;meta.textContent=historyTimeLabel(entry.time)+" · "+historyStatusLabel(entry.status)+" · "+historyModeLabel(entry.mode);recall.append(preview,meta);recall.addEventListener("click",()=>recallHistory(entry));const resend=document.createElement("button");resend.type="button";resend.className="historySend";resend.textContent="发送";resend.disabled=sendInFlight;resend.setAttribute("aria-label","重新发送这条历史记录");resend.addEventListener("click",()=>sendText(entry.text));item.append(recall,resend);historyListEl.append(item)})}
    function upsertHistory(text,status,mode){const existing=history.find((item)=>item.text===text);const entry={id:existing?existing.id:String(Date.now())+"-"+Math.random().toString(36).slice(2,8),text,time:Date.now(),status,mode:normalizePasteMode(mode)};history=[entry,...history.filter((item)=>item.id!==entry.id)].slice(0,10);persistHistory();renderHistory();return entry.id}
    function updateHistory(id,changes){const index=history.findIndex((item)=>item.id===id);if(index<0)return;history[index]={...history[index],...changes};persistHistory();renderHistory()}
    function recallHistory(entry){textEl.value=entry.text;lastNonEmptyDraft=entry.text;storeDraft(entry.text);setMessage("已从历史记录填入。","ok");textEl.focus();textEl.setSelectionRange(entry.text.length,entry.text.length)}
    function modeName(mode){return mode==="mac_remote"?"Mac 远程":"Windows"}
    function sourceName(source){if(source==="app_binding")return"已绑定规则";if(source==="built_in_hint")return"远程工具提示";return"默认 Windows"}
    function sendButtonLabel(){return pasteModeEl.value==="auto"?"自动识别并发送":pasteModeEl.value==="mac_remote"?"发送到 Mac":"发送到 Windows"}
    function renderModeTarget(){const selected=pasteModeEl.value;if(selected==="auto"){const foreground=automationState&&automationState.foreground||{},resolution=automationState&&automationState.resolution||{},appName=foreground.process||"等待识别",resolvedName=modeName(resolution.mode);autoSummaryEl.hidden=false;autoSummaryEl.textContent=appName+" → "+resolvedName;targetEl.textContent="自动："+appName+" → "+resolvedName;return}autoSummaryEl.hidden=true;targetEl.textContent=selected==="mac_remote"?"手机选择：Mac 远程（Win+V → Command+V）":"手机选择：Windows（Ctrl+V）"}
    function setPasteMode(mode,persist=true){const resolved=normalizePasteMode(mode);pasteModeEl.value=resolved;pasteModeButtons.forEach((button)=>button.setAttribute("aria-pressed",String(button.dataset.pasteMode===resolved)));sendBtn.textContent=sendButtonLabel();renderModeTarget();if(persist)try{localStorage.setItem(PASTE_MODE_KEY,resolved)}catch{}if(resolved==="auto")refreshAutomation(true)}
    function setMessage(text,kind=""){messageEl.textContent=text;messageEl.className="message"+(kind?" "+kind:"")}
    function setBindingMessage(text,kind=""){bindingMessageEl.textContent=text;bindingMessageEl.className="message"+(kind?" "+kind:"")}
    function renderBindingList(bindings){bindingListEl.replaceChildren();bindingEmptyEl.hidden=bindings.length>0;bindings.forEach((binding)=>{const row=document.createElement("div");row.className="bindingRow";const identity=document.createElement("div");identity.className="bindingName";const name=document.createElement("strong");name.textContent=binding.process||binding.processKey;const detail=document.createElement("span");detail.textContent=binding.lastTitle||binding.processKey;identity.append(name,detail);const controls=document.createElement("div");controls.className="bindingControls";const winButton=document.createElement("button");winButton.type="button";winButton.textContent="Win";winButton.className=binding.mode==="windows"?"active":"";winButton.disabled=bindingBusy;winButton.setAttribute("aria-label","将 "+name.textContent+" 设为 Windows 模式");winButton.setAttribute("aria-pressed",String(binding.mode==="windows"));winButton.addEventListener("click",()=>updateBinding(binding.processKey,"windows"));const macButton=document.createElement("button");macButton.type="button";macButton.textContent="Mac";macButton.className=binding.mode==="mac_remote"?"active":"";macButton.disabled=bindingBusy;macButton.setAttribute("aria-label","将 "+name.textContent+" 设为 Mac 远程模式");macButton.setAttribute("aria-pressed",String(binding.mode==="mac_remote"));macButton.addEventListener("click",()=>updateBinding(binding.processKey,"mac_remote"));const deleteButton=document.createElement("button");deleteButton.type="button";deleteButton.textContent="删除";deleteButton.className="delete";deleteButton.disabled=bindingBusy;deleteButton.addEventListener("click",()=>deleteBinding(binding.processKey,name.textContent));controls.append(winButton,macButton,deleteButton);row.append(identity,controls);bindingListEl.append(row)})}
    function renderAutomation(data){if(data)automationState=data;const current=automationState||{},foreground=current.foreground||{},resolution=current.resolution||{},bindings=Array.isArray(current.bindings)?current.bindings:[];currentAppNameEl.textContent=foreground.process||"未识别前台应用";currentAppTitleEl.textContent=foreground.title||foreground.path||"请把电脑焦点放在目标应用后刷新";const resolved=resolution.mode==="mac_remote"?"mac_remote":"windows";resolvedModeEl.textContent=modeName(resolved);resolvedModeEl.className=resolved==="mac_remote"?"modeBadge mac":"modeBadge";automationSourceEl.textContent=sourceName(resolution.source)+" · "+bindings.length+" 条应用绑定";renderBindingList(bindings);renderModeTarget()}
    function setBindingBusy(value){bindingBusy=value;bindWindowsEl.disabled=value;bindMacEl.disabled=value;automationRefreshEl.disabled=value||automationLoading;if(automationState)renderBindingList(Array.isArray(automationState.bindings)?automationState.bindings:[])}
    async function postAutomation(path,payload){const res=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:ACCESS_KEY,...payload})});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||"操作失败");return data.result}
    async function refreshAutomation(silent=false){if(automationLoading)return;automationLoading=true;automationRefreshEl.disabled=true;try{const res=await fetch("/automation?key="+encodeURIComponent(ACCESS_KEY),{cache:"no-store"});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||"识别失败");renderAutomation(data.result);if(!silent)setBindingMessage("已刷新电脑当前应用。","ok")}catch(error){if(!silent)setBindingMessage(String(error.message||error),"err")}finally{automationLoading=false;automationRefreshEl.disabled=bindingBusy}}
    async function bindForeground(mode){if(bindingBusy)return;setBindingBusy(true);setBindingMessage("正在读取电脑当前前台应用...");try{const result=await postAutomation("/app-bindings",{mode});renderAutomation(result.automation);setBindingMessage("已绑定 "+result.binding.process+" → "+modeName(mode)+"。","ok")}catch(error){setBindingMessage(String(error.message||error),"err")}finally{setBindingBusy(false)}}
    async function updateBinding(processKey,mode){if(bindingBusy)return;setBindingBusy(true);try{await postAutomation("/app-bindings/update",{process_key:processKey,mode});await refreshAutomation(true);setBindingMessage("应用绑定已更新为 "+modeName(mode)+"。","ok")}catch(error){setBindingMessage(String(error.message||error),"err")}finally{setBindingBusy(false)}}
    async function deleteBinding(processKey,processName){if(bindingBusy||!window.confirm("删除 "+processName+" 的自动匹配规则？"))return;setBindingBusy(true);try{await postAutomation("/app-bindings/delete",{process_key:processKey});await refreshAutomation(true);setBindingMessage("应用绑定已删除。","ok")}catch(error){setBindingMessage(String(error.message||error),"err")}finally{setBindingBusy(false)}}
    function setAudioMessage(text,kind=""){audioMessageEl.textContent=text;audioMessageEl.className="message"+(kind?" "+kind:"")}
    function setAudioUi(title,detail,live=false){audioTitleEl.textContent=title;audioDetailEl.textContent=detail;audioDotEl.className=live?"audioDot live":"audioDot"}
    function wsUrl(){const protocol=location.protocol==="https:"?"wss:":"ws:";return protocol+"//"+location.host+"/audio?key="+encodeURIComponent(ACCESS_KEY)}
    function schedulePcm(arrayBuffer){if(!audioCtx||!audioPlaying)return;const input=new Int16Array(arrayBuffer);if(!input.length)return;const buffer=audioCtx.createBuffer(1,input.length,audioSampleRate);const data=buffer.getChannelData(0);for(let i=0;i<input.length;i++)data[i]=Math.max(-1,Math.min(1,input[i]/32768));const source=audioCtx.createBufferSource();source.buffer=buffer;source.connect(audioCtx.destination);const now=audioCtx.currentTime;const startAt=Math.max(now+0.08,nextAudioTime||0);source.start(startAt);nextAudioTime=startAt+buffer.duration;if(nextAudioTime-now>1.2)nextAudioTime=now+0.25}
    async function startAudioPlayback(){if(audioPlaying)return;audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)({latencyHint:"interactive"});await audioCtx.resume();audioPlaying=true;nextAudioTime=audioCtx.currentTime+0.12;audioWs=new WebSocket(wsUrl());audioWs.binaryType="arraybuffer";audioStartEl.disabled=true;audioStopEl.disabled=false;setAudioUi("正在连接电脑声音","等待桌面端开始采集。",false);setAudioMessage("已启用手机扬声器播放通道。","ok");audioWs.onopen=()=>setAudioUi("已连接电脑声音","如果还没有声音，请在电脑端点击“开始采集”。",true);audioWs.onmessage=(event)=>{if(typeof event.data==="string"){try{const data=JSON.parse(event.data);if(data.type==="audio-status"){audioSampleRate=data.sampleRate||audioSampleRate;const detail=data.capturing?"正在接收电脑声音。":"已连接，等待电脑端开始采集。";setAudioUi(data.capturing?"正在播放电脑声音":"已连接电脑声音",detail,true)}}catch{}return}schedulePcm(event.data)};audioWs.onerror=()=>setAudioMessage("音频连接出错，请确认电脑服务仍在运行。","err");audioWs.onclose=()=>{if(audioPlaying){setAudioMessage("音频连接已断开。","err")}audioPlaying=false;audioStartEl.disabled=false;audioStopEl.disabled=true;setAudioUi("电脑声音未连接","点击开始播放后，手机会连接电脑并等待音频流。",false)}}
    function stopAudioPlayback(){audioPlaying=false;if(audioWs){audioWs.close();audioWs=null}audioStartEl.disabled=false;audioStopEl.disabled=true;setAudioUi("电脑声音未连接","点击开始播放后，手机会连接电脑并等待音频流。",false);setAudioMessage("")}
    async function refreshStatus(){try{const res=await fetch("/health",{cache:"no-store"});const data=await res.json();if(res.ok&&data.ok){statusEl.className="status ready";statusText.textContent="服务在线";renderModeTarget()}}catch(err){statusEl.className="status blocked";statusText.textContent="服务离线";targetEl.textContent=String(err)}}
    async function sendText(textOverride){const fromHistory=typeof textOverride==="string";const text=fromHistory?textOverride:textEl.value;if(!text.trim()){setMessage("没有可发送的文字。","err");textEl.focus();return}if(sendInFlight)return;const selectedMode=pasteModeEl.value;sendInFlight=true;if(!fromHistory){lastNonEmptyDraft=text;storeDraft(text)}const historyId=upsertHistory(text,"pending",selectedMode);sendBtn.disabled=true;sendBtn.textContent="正在发送...";setMessage("");renderHistory();try{const res=await fetch("/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:ACCESS_KEY,text,paste_mode:selectedMode,add_newline:newlineEl.checked,press_enter:pressEnterEl.checked,enter_delay_sec:Number(enterDelayEl.value||0.5)})});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||"发送失败");const usedMode=data.result.mode_used==="mac_remote"?"mac_remote":"windows";updateHistory(historyId,{status:"sent",mode:usedMode,time:Date.now()});const suffix=data.result.enter_pressed?"，并已回车":"",appName=selectedMode==="auto"&&data.result.foreground&&data.result.foreground.process?data.result.foreground.process+" → ":"";setMessage("已发送 "+data.result.chars+" 个字符，"+appName+modeName(usedMode)+" 模式已粘贴"+suffix+"。","ok");if(clearAfterSendEl.checked&&!fromHistory){textEl.value="";lastNonEmptyDraft="";storeDraft("")}await refreshStatus();if(selectedMode==="auto")await refreshAutomation(true)}catch(err){updateHistory(historyId,{status:"failed",time:Date.now()});setMessage(String(err.message||err),"err")}finally{sendInFlight=false;sendBtn.disabled=false;sendBtn.textContent=sendButtonLabel();renderHistory();if(!fromHistory)textEl.focus()}}
    function handleTextInput(event){if(event&&event.isComposing)return;const value=textEl.value;if(value.trim()){lastNonEmptyDraft=value;storeDraft(value);return}if(lastNonEmptyDraft.trim())upsertHistory(lastNonEmptyDraft,"saved",pasteModeEl.value);lastNonEmptyDraft="";storeDraft("")}

    if(lastNonEmptyDraft.trim())textEl.value=lastNonEmptyDraft;
    setPasteMode(readStoredString(PASTE_MODE_KEY)||"auto",false);
    pasteModeButtons.forEach((button)=>button.addEventListener("click",()=>setPasteMode(button.dataset.pasteMode)));
    sendBtn.addEventListener("click",()=>sendText());
    automationRefreshEl.addEventListener("click",()=>refreshAutomation(false));
    bindWindowsEl.addEventListener("click",()=>bindForeground("windows"));
    bindMacEl.addEventListener("click",()=>bindForeground("mac_remote"));
    clearHistoryBtn.addEventListener("click",()=>{if(!history.length||!window.confirm("清空最近 10 条输入记录？"))return;history=[];persistHistory();renderHistory();setMessage("历史记录已清空。")});
    audioStartEl.addEventListener("click",()=>startAudioPlayback().catch((error)=>setAudioMessage(String(error.message||error),"err")));
    audioStopEl.addEventListener("click",stopAudioPlayback);
    textEl.addEventListener("input",handleTextInput);
    textEl.addEventListener("compositionend",handleTextInput);
    textEl.addEventListener("keydown",(event)=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();sendText()}});
    document.addEventListener("visibilitychange",()=>{if(!document.hidden&&pasteModeEl.value==="auto")refreshAutomation(true)});
    renderHistory();refreshStatus();refreshAutomation(true);setInterval(refreshStatus,5000);setInterval(()=>{if(!document.hidden&&pasteModeEl.value==="auto")refreshAutomation(true)},3000);textEl.focus();
  </script>
</body>
</html>`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function setupAudioWebSocket(instance) {
  audioWss = new WebSocket.Server({ noServer: true });
  audioWss.on("connection", (ws, req) => {
    audioClients.add(ws);
    const remote = req.socket.remoteAddress || "unknown";
    log(`audio client connected: ${remote}, clients=${audioClients.size}`);
    ws.send(JSON.stringify(audioStatusPayload()));
    sendAudioStatusToWindow();

    ws.on("close", () => {
      audioClients.delete(ws);
      log(`audio client disconnected, clients=${audioClients.size}`);
      sendAudioStatusToWindow();
    });
  });

  instance.on("upgrade", (req, socket, head) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (parsed.pathname !== "/audio") {
      socket.destroy();
      return;
    }
    if (parsed.searchParams.get("key") !== settings.key) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    audioWss.handleUpgrade(req, socket, head, (ws) => {
      audioWss.emit("connection", ws, req);
    });
  });
}

function closeAudioWebSocket() {
  for (const client of audioClients) {
    try {
      client.close();
    } catch {
      // best effort only
    }
  }
  audioClients.clear();
  if (audioWss) {
    audioWss.close();
    audioWss = null;
  }
  sendAudioStatusToWindow();
}

function runPowerShell(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || stdout || error.message).trim()));
        else resolve(stdout.trim());
      }
    );
  });
}

async function foregroundInfoPowerShell() {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinInfo {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$hwnd=[WinInfo]::GetForegroundWindow()
$sb=New-Object System.Text.StringBuilder 512
[void][WinInfo]::GetWindowText($hwnd,$sb,$sb.Capacity)
$pidNum=0
[void][WinInfo]::GetWindowThreadProcessId($hwnd,[ref]$pidNum)
$p=Get-Process -Id $pidNum -ErrorAction SilentlyContinue
[pscustomobject]@{ process=($p.ProcessName); title=$sb.ToString() } | ConvertTo-Json -Compress
`;
  try {
    const raw = await runPowerShell(script, 2500);
    return sanitizeForegroundInfo(JSON.parse(raw || "{}"));
  } catch {
    return sanitizeForegroundInfo();
  }
}

async function foregroundInfo() {
  try {
    const info = sanitizeForegroundInfo(
      await requestKeyHelper("/foreground", { method: "GET", timeoutMs: 2000 })
    );
    if (info.processKey) return info;
  } catch {
    // Fall back to PowerShell when an older helper is still running during development.
  }
  return foregroundInfoPowerShell();
}

async function resolvePasteMode(requestedMode) {
  if (requestedMode === "windows" || requestedMode === "mac_remote") {
    return { mode: requestedMode, source: "phone_override", foreground: null, binding: null };
  }
  if (requestedMode !== "auto" && (settings.mode === "windows" || settings.mode === "mac_remote")) {
    return { mode: settings.mode, source: "desktop_override", foreground: null, binding: null };
  }
  const info = await foregroundInfo();
  return resolveAutomaticMode(info, settings.appBindings, REMOTE_PROCESS_HINTS);
}

async function pasteText(text, options) {
  const resolution = await resolvePasteMode(options.mode);
  const helperResult = await callKeyHelper({
    text,
    mode: resolution.mode,
    add_newline: Boolean(options.addNewline),
    press_enter: Boolean(options.pressEnter),
    enter_delay_sec: options.enterDelaySec
  });
  const foreground = resolution.foreground
    ? {
        pid: resolution.foreground.pid,
        process: resolution.foreground.process,
        process_key: resolution.foreground.processKey,
        title: resolution.foreground.title
      }
    : null;
  const matchedBinding = resolution.binding
    ? {
        process_key: resolution.binding.processKey,
        process: resolution.binding.process,
        mode: resolution.binding.mode
      }
    : null;
  return {
    ...helperResult,
    mode_used: resolution.mode,
    mode_source: resolution.source,
    foreground,
    matched_binding: matchedBinding
  };
}

function helperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "helper", "key_helper.exe");
  }
  return path.join(__dirname, "..", "helper-dist", "key_helper.exe");
}

function startKeyHelper() {
  return new Promise((resolve, reject) => {
    if (helperPort && helperProcess) {
      resolve(helperPort);
      return;
    }
    const exe = helperPath();
    if (!fs.existsSync(exe)) {
      reject(new Error(`key helper not found: ${exe}`));
      return;
    }
    const child = execFile(exe, ["--server", "0"], { windowsHide: true }, (error, stdout, stderr) => {
      if (helperProcess === child) {
        helperProcess = null;
        helperPort = null;
      }
      if (error) log(`key helper exited: ${(stderr || stdout || error.message).trim()}`);
    });
    helperProcess = child;
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("key helper start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split(/\r?\n/).find(Boolean);
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ok && parsed.port) {
          clearTimeout(timer);
          helperPort = parsed.port;
          log(`key helper started on 127.0.0.1:${helperPort}`);
          resolve(helperPort);
        }
      } catch (error) {
        clearTimeout(timer);
        reject(new Error(`invalid key helper response: ${line}`));
      }
    });
    child.stderr.on("data", (chunk) => log(`key helper stderr: ${chunk.toString("utf8").trim()}`));
  });
}

function stopKeyHelper() {
  if (helperProcess) {
    helperProcess.kill();
    helperProcess = null;
    helperPort = null;
  }
}

async function requestKeyHelper(requestPath, options = {}) {
  const port = await startKeyHelper();
  return new Promise((resolve, reject) => {
    const method = options.method || "GET";
    const body = options.payload ? Buffer.from(JSON.stringify(options.payload), "utf8") : Buffer.alloc(0);
    const headers = {};
    if (body.length) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = body.length;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers,
        timeout: options.timeoutMs || 10000
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data || "{}");
            if (!res.statusCode || res.statusCode >= 400 || !parsed.ok) {
              reject(new Error(parsed.error || `key helper HTTP ${res.statusCode}`));
            } else {
              resolve(parsed.result);
            }
          } catch (error) {
            reject(new Error(`invalid key helper response: ${data || error.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("key helper request timeout")));
    if (body.length) req.write(body);
    req.end();
  });
}

async function callKeyHelper(payload) {
  return requestKeyHelper("/paste", { method: "POST", payload, timeoutMs: 10000 });
}

function publicAutomationPayload(foreground) {
  const resolution = resolveAutomaticMode(foreground, settings.appBindings, REMOTE_PROCESS_HINTS);
  return {
    foreground: resolution.foreground,
    resolution: {
      mode: resolution.mode,
      source: resolution.source,
      binding: resolution.binding
    },
    bindings: settings.appBindings
  };
}

async function automationPayload() {
  return publicAutomationPayload(await foregroundInfo());
}

async function bindCurrentApp(mode) {
  if (mode !== "windows" && mode !== "mac_remote") throw new Error("invalid binding mode");
  const foreground = await foregroundInfo();
  settings.appBindings = upsertAppBinding(settings.appBindings, foreground, mode);
  saveSettings();
  const binding = findAppBinding(foreground, settings.appBindings);
  log(`app binding saved: ${binding.processKey} -> ${mode}`);
  return { binding, automation: publicAutomationPayload(foreground), status: statusPayload() };
}

function changeAppBinding(processKey, mode) {
  settings.appBindings = updateAppBinding(settings.appBindings, processKey, mode);
  saveSettings();
  log(`app binding changed: ${processKey} -> ${mode}`);
  return statusPayload();
}

function removeAppBinding(processKey) {
  const before = settings.appBindings.length;
  settings.appBindings = deleteAppBinding(settings.appBindings, processKey);
  if (settings.appBindings.length === before) throw new Error("binding not found");
  saveSettings();
  log(`app binding removed: ${processKey}`);
  return statusPayload();
}

function modeLabel(mode = settings.mode) {
  if (mode === "windows") return "Windows 模式：Ctrl+V";
  if (mode === "mac_remote") return "Mac 远程模式：Command+V 映射";
  return "自动模式：优先使用应用绑定，再尝试识别远程工具";
}

function statusPayload() {
  return {
    running: Boolean(server),
    port: currentPort,
    key: settings.key,
    version: APP_VERSION,
    mode: settings.mode,
    modeLabel: modeLabel(),
    appBindings: settings.appBindings,
    urls: urlsFor(),
    audio: audioStatusPayload(),
    logs,
    userData: app.getPath("userData")
  };
}

function createServer(port) {
  const instance = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && parsed.pathname === "/") {
      if (parsed.searchParams.get("key") !== settings.key) {
        sendText(res, 401, "Missing or invalid key. Open the URL shown in the desktop app.", "text/plain; charset=utf-8");
        return;
      }
      sendText(res, 200, mobileHtml(req.headers.host), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && parsed.pathname === "/health") {
      sendJson(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION, mode: settings.mode, mode_label: modeLabel(), binding_count: settings.appBindings.length });
      return;
    }
    if (req.method === "GET" && parsed.pathname === "/automation") {
      if (parsed.searchParams.get("key") !== settings.key) {
        sendJson(res, 401, { ok: false, error: "invalid key" });
        return;
      }
      try {
        sendJson(res, 200, { ok: true, result: await automationPayload() });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && parsed.pathname === "/app-bindings") {
      try {
        const data = await parseBody(req);
        if (data.key !== settings.key) {
          sendJson(res, 401, { ok: false, error: "invalid key" });
          return;
        }
        sendJson(res, 200, { ok: true, result: await bindCurrentApp(data.mode) });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && parsed.pathname === "/app-bindings/update") {
      try {
        const data = await parseBody(req);
        if (data.key !== settings.key) {
          sendJson(res, 401, { ok: false, error: "invalid key" });
          return;
        }
        sendJson(res, 200, { ok: true, result: changeAppBinding(data.process_key, data.mode) });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && parsed.pathname === "/app-bindings/delete") {
      try {
        const data = await parseBody(req);
        if (data.key !== settings.key) {
          sendJson(res, 401, { ok: false, error: "invalid key" });
          return;
        }
        sendJson(res, 200, { ok: true, result: removeAppBinding(data.process_key) });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && parsed.pathname === "/send") {
      try {
        const data = await parseBody(req);
        if (data.key !== settings.key) {
          sendJson(res, 401, { ok: false, error: "invalid key" });
          return;
        }
        const text = String(data.text || "");
        if (!text.trim()) {
          sendJson(res, 400, { ok: false, error: "empty text" });
          return;
        }
        if (text.length > MAX_TEXT_LENGTH) {
          sendJson(res, 400, { ok: false, error: `text is too long; max ${MAX_TEXT_LENGTH} chars` });
          return;
        }
        const result = await pasteText(text, {
          mode: data.paste_mode,
          addNewline: Boolean(data.add_newline),
          pressEnter: Boolean(data.press_enter),
          enterDelaySec: data.enter_delay_sec
        });
        log(`pasted ${result.chars} chars, enter=${result.enter_pressed}, mode=${result.mode_used}, source=${result.mode_source}, app=${result.foreground?.process || "manual"}`);
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        log(`paste failed: ${error.message}`);
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
    sendText(res, 404, "Not found", "text/plain; charset=utf-8");
  });
  setupAudioWebSocket(instance);
  return instance;
}

function startServer(port = settings.port || DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(statusPayload());
      return;
    }
    const instance = createServer(port);
    instance.once("error", reject);
    instance.listen(port, "0.0.0.0", () => {
      server = instance;
      currentPort = port;
      settings.port = port;
      saveSettings();
      log(`service started on 0.0.0.0:${port}`);
      resolve(statusPayload());
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve(statusPayload());
      return;
    }
    const instance = server;
    server = null;
    closeAudioWebSocket();
    instance.close(() => {
      log("service stopped");
      resolve(statusPayload());
    });
  });
}

function configureDisplayMediaCapture() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (!sources.length) {
          log("audio capture denied: no screen source found");
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      })
      .catch((error) => {
        log(`audio capture source failed: ${error.message}`);
        callback({});
      });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#f6f7fb",
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

ipcMain.handle("bridge:get-status", () => statusPayload());
ipcMain.handle("bridge:start", async (_event, port) => startServer(Number(port) || DEFAULT_PORT));
ipcMain.handle("bridge:stop", () => stopServer());
ipcMain.handle("bridge:set-mode", (_event, mode) => {
  if (!MODES.has(mode)) throw new Error("invalid mode");
  settings.mode = mode;
  saveSettings();
  log(`mode changed to ${mode}`);
  return statusPayload();
});
ipcMain.handle("bridge:get-automation", () => automationPayload());
ipcMain.handle("bridge:capture-app-binding", async (_event, mode, delayMs) => {
  const waitMs = Math.max(1000, Math.min(10000, Number(delayMs) || 3000));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return bindCurrentApp(mode);
});
ipcMain.handle("bridge:update-app-binding", (_event, processKey, mode) => changeAppBinding(processKey, mode));
ipcMain.handle("bridge:delete-app-binding", (_event, processKey) => removeAppBinding(processKey));
ipcMain.handle("bridge:regenerate-key", () => {
  settings.key = newKey();
  saveSettings();
  log("access key regenerated");
  return statusPayload();
});
ipcMain.handle("bridge:open-url", (_event, url) => shell.openExternal(url));
ipcMain.handle("bridge:copy-text", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
ipcMain.handle("bridge:set-audio-state", (_event, nextState) => {
  const capturing = Boolean(nextState && nextState.capturing);
  audioState = {
    ...audioState,
    capturing,
    sampleRate: Number(nextState && nextState.sampleRate) || audioState.sampleRate,
    startedAt: capturing ? audioState.startedAt || Date.now() : null,
    lastChunkAt: capturing ? audioState.lastChunkAt : null,
    bytesSent: capturing ? audioState.bytesSent : 0
  };
  broadcastAudioJson(audioStatusPayload());
  sendAudioStatusToWindow();
  log(capturing ? `audio capture started, sampleRate=${audioState.sampleRate || "unknown"}` : "audio capture stopped");
  return statusPayload();
});
ipcMain.on("bridge:audio-chunk", (_event, chunk) => {
  if (!audioState.capturing || !chunk) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : chunk instanceof ArrayBuffer
        ? Buffer.from(chunk)
        : null;
  if (!buffer || !buffer.length || buffer.length > MAX_AUDIO_CHUNK_BYTES) return;
  audioState.bytesSent += buffer.length;
  audioState.lastChunkAt = Date.now();
  broadcastAudioChunk(buffer);
});

app.whenReady().then(async () => {
  settings = loadSettings();
  configureDisplayMediaCapture();
  const cliPort = Number(argValue("--port"));
  if (Number.isInteger(cliPort) && cliPort > 0 && cliPort <= 65535) {
    settings.port = cliPort;
  }
  saveSettings();
  const serverOnly = process.argv.includes("--server-only");
  if (!serverOnly) createWindow();
  try {
    await startKeyHelper();
    await startServer(settings.port || DEFAULT_PORT);
    if (serverOnly) {
      const urls = urlsFor(settings.port || DEFAULT_PORT);
      console.log(`Local URL: ${urls.localUrl}`);
      for (const url of urls.phoneUrls) console.log(`Phone URL: ${url}`);
    }
  } catch (error) {
    log(`auto start failed: ${error.message}`);
    if (serverOnly) {
      console.error(error.message);
      app.quit();
    }
  }
});

process.on("SIGTERM", async () => {
  await stopServer();
  app.quit();
});

process.on("SIGINT", async () => {
  await stopServer();
  app.quit();
});

app.on("window-all-closed", async () => {
  await stopServer();
  stopKeyHelper();
  if (process.platform !== "darwin") app.quit();
});
