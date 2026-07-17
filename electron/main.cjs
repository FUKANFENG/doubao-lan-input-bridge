const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const WebSocket = require("ws");

const APP_NAME = "豆包语音输入桥";
const DEFAULT_PORT = 8765;
const MAX_TEXT_LENGTH = 20000;
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;
const MODES = new Set(["auto", "windows", "mac_remote"]);
const REMOTE_PROCESS_HINTS = [
  "rustdesk",
  "anydesk",
  "mstsc",
  "parsec",
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
      port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT
    };
  } catch {
    return { key: newKey(), mode: "auto", port: DEFAULT_PORT };
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
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store"
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
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>豆包语音输入桥</title>
  <style>
    :root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#637083;--line:#d9e0ea;--accent:#0f766e;--danger:#b42318;--ok:#137333;--shadow:0 14px 40px rgba(22,32,51,.10);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);padding:max(18px,env(safe-area-inset-top)) 16px max(22px,env(safe-area-inset-bottom))}
    main{width:min(760px,100%);margin:0 auto;display:grid;gap:14px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:4px 2px 2px}
    h1{margin:0;font-size:24px;line-height:1.18;font-weight:750}.server{margin-top:6px;color:var(--muted);font-size:13px;line-height:1.4;word-break:break-all}
    .status{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 2px 10px rgba(22,32,51,.05);color:var(--muted);font-size:13px;font-weight:650;white-space:nowrap}
    .dot{width:9px;height:9px;border-radius:50%;background:#9aa5b5}.status.ready{color:var(--ok)}.status.ready .dot{background:var(--ok)}
    section{background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:14px}
    textarea{width:100%;min-height:210px;resize:vertical;scroll-margin-top:150px;border:1px solid var(--line);border-radius:8px;padding:13px 14px;color:var(--text);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none;background:#fbfcfe}
    textarea:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(15,118,110,.14);background:#fff}
    .quickActions{position:sticky;top:max(8px,env(safe-area-inset-top));z-index:10;display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,auto);align-items:end;gap:10px 12px;margin:-2px -2px 12px;padding:10px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.96);box-shadow:0 8px 24px rgba(22,32,51,.12);backdrop-filter:blur(12px)}
    .targetControl{display:grid;gap:6px}.controlLabel{color:var(--muted);font-size:13px;font-weight:700}.modeButtons{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:4px;border:1px solid var(--line);border-radius:8px;background:#eef2f6}
    button{display:inline-flex;align-items:center;justify-content:center;min-width:118px;min-height:44px;border:0;border-radius:8px;padding:0 18px;color:#fff;background:var(--accent);font-size:16px;font-weight:750;cursor:pointer}button:disabled{background:#95a3b4;cursor:not-allowed}
    button.modeButton{flex-direction:column;gap:1px;width:100%;min-width:0;min-height:44px;padding:4px 10px;border:1px solid transparent;background:transparent;color:var(--muted);font-size:14px;font-weight:750}button.modeButton small{font-size:11px;font-weight:600;color:inherit}button.modeButton[aria-pressed=true]{border-color:#b9d8d4;background:#fff;color:var(--accent);box-shadow:0 1px 4px rgba(22,32,51,.10)}button.modeButton:focus-visible{outline:3px solid rgba(15,118,110,.2);outline-offset:1px}
    .primarySend{min-width:180px;min-height:52px}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}.checks{display:flex;flex-wrap:wrap;gap:10px 14px;color:var(--muted);font-size:14px}
    label{display:inline-flex;align-items:center;gap:7px;user-select:none}input[type=checkbox]{width:18px;height:18px;accent-color:var(--accent)}input[type=number]{width:70px;min-height:34px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;color:var(--text);background:#fbfcfe;font:14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none}
    .meta{display:grid;gap:8px;color:var(--muted);font-size:13px;line-height:1.45}.meta strong{color:var(--text);font-weight:700}.message{grid-column:1/-1;min-height:20px;color:var(--muted);font-size:13px;line-height:1.4}.message:empty{display:none}.message.ok{color:var(--ok)}.message.err{color:var(--danger)}
    .audioPanel{display:grid;gap:12px}.audioLine{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:14px;line-height:1.45}.audioLine strong{display:block;color:var(--text);font-size:15px}.audioActions{display:flex;gap:10px;flex-wrap:wrap}.audioActions button{min-width:132px}.audioActions .secondary{background:#eef3f8;color:var(--text);border:1px solid var(--line)}.audioDot{width:12px;height:12px;border-radius:50%;background:#9aa5b5;flex:0 0 auto}.audioDot.live{background:var(--ok);box-shadow:0 0 0 5px rgba(19,115,51,.12)}
    @media(max-width:560px){body{padding:max(10px,env(safe-area-inset-top)) 10px max(18px,env(safe-area-inset-bottom))}main{gap:10px}header{align-items:center;padding:2px}.server{display:none}.status{min-height:32px;padding:6px 9px}h1{font-size:20px}section{padding:10px}.quickActions{grid-template-columns:1fr;gap:8px;margin:-2px -2px 10px;padding:8px;top:max(6px,env(safe-area-inset-top))}.targetControl{grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px}.controlLabel{white-space:nowrap}.primarySend{width:100%;min-height:48px}.modeButton{width:100%}textarea{min-height:260px;font-size:18px}.toolbar{align-items:stretch}.checks{width:100%}.audioLine{align-items:flex-start}.audioActions{width:100%}.audioActions button{width:100%;min-height:48px}}
  </style>
</head>
<body>
  <main>
    <header><div><h1>豆包语音输入桥</h1><div class="server">${safeHost}</div></div><div id="status" class="status"><span class="dot"></span><span>检测中</span></div></header>
    <section>
      <div class="quickActions">
        <div class="targetControl">
          <span id="targetLabel" class="controlLabel">目标系统</span>
          <div class="modeButtons" role="group" aria-labelledby="targetLabel">
            <button class="modeButton" type="button" data-paste-mode="windows" aria-pressed="true"><span>Windows</span><small>Ctrl+V</small></button>
            <button class="modeButton" type="button" data-paste-mode="mac_remote" aria-pressed="false"><span>Mac</span><small>Win+V</small></button>
          </div>
          <input id="pasteMode" type="hidden" value="windows">
        </div>
        <button id="send" class="primarySend" type="button">发送到 Windows</button>
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
    <section class="audioPanel">
      <div class="audioLine"><span id="audioDot" class="audioDot"></span><div><strong id="audioTitle">电脑声音未连接</strong><span id="audioDetail">点击开始播放后，手机会连接电脑并等待音频流。</span></div></div>
      <div class="audioActions"><button id="audioStart" type="button">开始播放电脑声音</button><button id="audioStop" class="secondary" type="button" disabled>停止播放</button></div>
      <div id="audioMessage" class="message"></div>
    </section>
    <section class="meta"><div><strong>电脑端：</strong><span id="target">直接粘贴模式</span></div><div><strong>提示：</strong>电脑上先点到目标输入框，再在手机上发送。桌面端可选择 Windows 或 Mac 远程粘贴模式。</div></section>
  </main>
  <script>
    const ACCESS_KEY="${safeKey}";
    const statusEl=document.getElementById("status"),statusText=statusEl.querySelector("span:last-child"),targetEl=document.getElementById("target"),textEl=document.getElementById("text"),sendBtn=document.getElementById("send"),messageEl=document.getElementById("message"),clearAfterSendEl=document.getElementById("clearAfterSend"),newlineEl=document.getElementById("newline"),pressEnterEl=document.getElementById("pressEnter"),enterDelayEl=document.getElementById("enterDelay"),pasteModeEl=document.getElementById("pasteMode"),pasteModeButtons=[...document.querySelectorAll("[data-paste-mode]")],audioStartEl=document.getElementById("audioStart"),audioStopEl=document.getElementById("audioStop"),audioTitleEl=document.getElementById("audioTitle"),audioDetailEl=document.getElementById("audioDetail"),audioMessageEl=document.getElementById("audioMessage"),audioDotEl=document.getElementById("audioDot");
    let audioCtx=null,audioWs=null,audioSampleRate=48000,nextAudioTime=0,audioPlaying=false;
    function setPasteMode(mode,persist=true){const resolved=mode==="mac_remote"?"mac_remote":"windows";pasteModeEl.value=resolved;pasteModeButtons.forEach((button)=>button.setAttribute("aria-pressed",String(button.dataset.pasteMode===resolved)));sendBtn.textContent=resolved==="mac_remote"?"发送到 Mac":"发送到 Windows";targetEl.textContent=resolved==="mac_remote"?"手机选择：Mac 远程（Win+V → Command+V）":"手机选择：Windows（Ctrl+V）";if(persist)localStorage.setItem("doubaoPasteMode",resolved)}
    setPasteMode(localStorage.getItem("doubaoPasteMode")||"windows",false);pasteModeButtons.forEach((button)=>button.addEventListener("click",()=>setPasteMode(button.dataset.pasteMode)));
    function setMessage(text,kind=""){messageEl.textContent=text;messageEl.className="message"+(kind?" "+kind:"")}
    function setAudioMessage(text,kind=""){audioMessageEl.textContent=text;audioMessageEl.className="message"+(kind?" "+kind:"")}
    function setAudioUi(title,detail,live=false){audioTitleEl.textContent=title;audioDetailEl.textContent=detail;audioDotEl.className=live?"audioDot live":"audioDot"}
    function wsUrl(){const protocol=location.protocol==="https:"?"wss:":"ws:";return protocol+"//"+location.host+"/audio?key="+encodeURIComponent(ACCESS_KEY)}
    function schedulePcm(arrayBuffer){if(!audioCtx||!audioPlaying)return;const input=new Int16Array(arrayBuffer);if(!input.length)return;const buffer=audioCtx.createBuffer(1,input.length,audioSampleRate);const data=buffer.getChannelData(0);for(let i=0;i<input.length;i++)data[i]=Math.max(-1,Math.min(1,input[i]/32768));const source=audioCtx.createBufferSource();source.buffer=buffer;source.connect(audioCtx.destination);const now=audioCtx.currentTime;const startAt=Math.max(now+0.08,nextAudioTime||0);source.start(startAt);nextAudioTime=startAt+buffer.duration;if(nextAudioTime-now>1.2)nextAudioTime=now+0.25}
    async function startAudioPlayback(){if(audioPlaying)return;audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)({latencyHint:"interactive"});await audioCtx.resume();audioPlaying=true;nextAudioTime=audioCtx.currentTime+0.12;audioWs=new WebSocket(wsUrl());audioWs.binaryType="arraybuffer";audioStartEl.disabled=true;audioStopEl.disabled=false;setAudioUi("正在连接电脑声音","等待桌面端开始采集。",false);setAudioMessage("已启用手机扬声器播放通道。","ok");audioWs.onopen=()=>setAudioUi("已连接电脑声音","如果还没有声音，请在电脑端点击“开始采集”。",true);audioWs.onmessage=(event)=>{if(typeof event.data==="string"){try{const data=JSON.parse(event.data);if(data.type==="audio-status"){audioSampleRate=data.sampleRate||audioSampleRate;const detail=data.capturing?"正在接收电脑声音。":"已连接，等待电脑端开始采集。";setAudioUi(data.capturing?"正在播放电脑声音":"已连接电脑声音",detail,true)}}catch{}return}schedulePcm(event.data)};audioWs.onerror=()=>setAudioMessage("音频连接出错，请确认电脑服务仍在运行。","err");audioWs.onclose=()=>{if(audioPlaying){setAudioMessage("音频连接已断开。","err")}audioPlaying=false;audioStartEl.disabled=false;audioStopEl.disabled=true;setAudioUi("电脑声音未连接","点击开始播放后，手机会连接电脑并等待音频流。",false)}}
    function stopAudioPlayback(){audioPlaying=false;if(audioWs){audioWs.close();audioWs=null}audioStartEl.disabled=false;audioStopEl.disabled=true;setAudioUi("电脑声音未连接","点击开始播放后，手机会连接电脑并等待音频流。",false);setAudioMessage("")}
    async function refreshStatus(){try{const res=await fetch("/health",{cache:"no-store"});const data=await res.json();if(res.ok&&data.ok){statusEl.className="status ready";statusText.textContent="服务在线";targetEl.textContent=pasteModeEl.value==="mac_remote"?"手机选择：Mac 远程（Win+V → Command+V）":"手机选择：Windows（Ctrl+V）"}}catch(err){statusEl.className="status blocked";statusText.textContent="服务离线";targetEl.textContent=String(err)}}
    async function sendText(){const text=textEl.value;if(!text.trim()){setMessage("没有可发送的文字。","err");textEl.focus();return}const selectedMode=pasteModeEl.value;sendBtn.disabled=true;sendBtn.textContent="正在发送...";setMessage("");try{const res=await fetch("/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:ACCESS_KEY,text,paste_mode:selectedMode,add_newline:newlineEl.checked,press_enter:pressEnterEl.checked,enter_delay_sec:Number(enterDelayEl.value||0.5)})});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||"发送失败");const modeText=data.result.mode_used==="mac_remote"?"Mac 远程":"Windows";const suffix=data.result.enter_pressed?"，并已回车":"";setMessage("已发送 "+data.result.chars+" 个字符，已按 "+modeText+" 模式粘贴"+suffix+"。","ok");if(clearAfterSendEl.checked)textEl.value="";await refreshStatus()}catch(err){setMessage(String(err.message||err),"err")}finally{sendBtn.disabled=false;sendBtn.textContent=pasteModeEl.value==="mac_remote"?"发送到 Mac":"发送到 Windows";textEl.focus()}}
    sendBtn.addEventListener("click",sendText);audioStartEl.addEventListener("click",()=>startAudioPlayback().catch((error)=>setAudioMessage(String(error.message||error),"err")));audioStopEl.addEventListener("click",stopAudioPlayback);textEl.addEventListener("keydown",(event)=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();sendText()}});refreshStatus();setInterval(refreshStatus,5000);textEl.focus();
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

async function foregroundInfo() {
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
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function resolvePasteMode(requestedMode) {
  if (requestedMode === "windows" || requestedMode === "mac_remote") return requestedMode;
  if (settings.mode === "windows" || settings.mode === "mac_remote") return settings.mode;
  const info = await foregroundInfo();
  const haystack = `${info.process || ""} ${info.title || ""}`.toLowerCase();
  const remoteHint = REMOTE_PROCESS_HINTS.some((item) => haystack.includes(item));
  const macHint = /mac|darwin|osx|os x/.test(haystack);
  return remoteHint || macHint ? "mac_remote" : "windows";
}

async function pasteText(text, options) {
  const mode = await resolvePasteMode(options.mode);
  const helperResult = await callKeyHelper({
    text,
    mode,
    add_newline: Boolean(options.addNewline),
    press_enter: Boolean(options.pressEnter),
    enter_delay_sec: options.enterDelaySec
  });
  return { ...helperResult, mode_used: mode };
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

async function callKeyHelper(payload) {
  const port = await startKeyHelper();
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/paste",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length
        },
        timeout: 10000
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
    req.write(body);
    req.end();
  });
}

function modeLabel(mode = settings.mode) {
  if (mode === "windows") return "Windows 模式：Ctrl+V";
  if (mode === "mac_remote") return "Mac 远程模式：Command+V 映射";
  return "自动模式：根据前台窗口尝试选择";
}

function statusPayload() {
  return {
    running: Boolean(server),
    port: currentPort,
    key: settings.key,
    mode: settings.mode,
    modeLabel: modeLabel(),
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
      sendJson(res, 200, { ok: true, app: APP_NAME, mode: settings.mode, mode_label: modeLabel() });
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
        log(`pasted ${result.chars} chars, enter=${result.enter_pressed}, mode=${result.mode_used}`);
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
