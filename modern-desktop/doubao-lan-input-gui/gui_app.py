import argparse
import ctypes
import html
import json
import os
import queue
import secrets
import socket
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import tkinter as tk
from tkinter import messagebox, ttk


APP_NAME = "豆包语音输入桥"
APP_ID = "DoubaoLanInputBridge"
DEFAULT_PORT = 8765
MAX_TEXT_LENGTH = 20000

IS_WINDOWS = os.name == "nt"

if IS_WINDOWS:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    VK_CONTROL = 0x11
    VK_V = 0x56
    VK_RETURN = 0x0D
    KEYEVENTF_KEYUP = 0x0002

    ULONG_PTR = wintypes.WPARAM

    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ULONG_PTR]
    user32.keybd_event.restype = None

    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL


def app_data_dir() -> Path:
    if os.environ.get("APPDATA"):
        root = Path(os.environ["APPDATA"])
    else:
        root = Path.home() / "AppData" / "Roaming"
    path = root / APP_ID
    path.mkdir(parents=True, exist_ok=True)
    return path


DATA_DIR = app_data_dir()
KEY_FILE = DATA_DIR / "access_key.txt"
LOG_FILE = DATA_DIR / "service.log"


def now_ms() -> int:
    return int(time.time() * 1000)


def win_error(prefix: str) -> RuntimeError:
    return ctypes.WinError(ctypes.get_last_error(), prefix)


def read_or_create_access_key() -> str:
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = secrets.token_urlsafe(18)
    KEY_FILE.write_text(key + "\n", encoding="utf-8")
    return key


def write_new_access_key() -> str:
    key = secrets.token_urlsafe(18)
    KEY_FILE.write_text(key + "\n", encoding="utf-8")
    return key


def get_lan_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        hostname = socket.gethostname()
        for item in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = item[4][0]
            if not ip.startswith("127."):
                addresses.add(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if not ip.startswith("127."):
                addresses.add(ip)
    except OSError:
        pass

    private = [
        ip
        for ip in addresses
        if ip.startswith("10.")
        or ip.startswith("192.168.")
        or any(ip.startswith(f"172.{n}.") for n in range(16, 32))
    ]
    return sorted(private or addresses)


def set_clipboard_text(text: str, retries: int = 10) -> None:
    if not IS_WINDOWS:
        raise RuntimeError("Windows clipboard API is only available on Windows.")

    payload = (text + "\0").encode("utf-16-le")
    last_error: Exception | None = None

    for _ in range(retries):
        if user32.OpenClipboard(None):
            try:
                if not user32.EmptyClipboard():
                    raise win_error("EmptyClipboard failed")
                handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(payload))
                if not handle:
                    raise win_error("GlobalAlloc failed")
                pointer = kernel32.GlobalLock(handle)
                if not pointer:
                    raise win_error("GlobalLock failed")
                ctypes.memmove(pointer, payload, len(payload))
                kernel32.GlobalUnlock(handle)
                if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                    raise win_error("SetClipboardData failed")
                return
            finally:
                user32.CloseClipboard()
        last_error = win_error("OpenClipboard failed")
        time.sleep(0.05)

    raise RuntimeError(f"Could not open clipboard: {last_error}")


def send_ctrl_v() -> None:
    if not IS_WINDOWS:
        raise RuntimeError("Keyboard paste is only available on Windows.")
    user32.keybd_event(VK_CONTROL, 0, 0, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_V, 0, 0, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)


def send_enter() -> None:
    if not IS_WINDOWS:
        raise RuntimeError("Keyboard Enter is only available on Windows.")
    user32.keybd_event(VK_RETURN, 0, 0, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)


def paste_text(
    text: str,
    add_newline: bool = False,
    press_enter: bool = False,
    enter_delay_sec: float = 0.5,
) -> dict:
    payload = text + ("\n" if add_newline else "")
    set_clipboard_text(payload)
    time.sleep(0.08)
    send_ctrl_v()
    enter_pressed = False
    if press_enter:
        time.sleep(max(0.0, min(5.0, enter_delay_sec)))
        send_enter()
        enter_pressed = True
    return {"chars": len(payload), "sent_at": now_ms(), "enter_pressed": enter_pressed}


def json_response(handler: BaseHTTPRequestHandler, status: int, data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler: BaseHTTPRequestHandler, status: int, body: str, content_type: str) -> None:
    payload = body.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(payload)


def html_page(access_key: str, server_name: str) -> str:
    safe_key = html.escape(access_key, quote=True)
    safe_server = html.escape(server_name, quote=True)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>豆包语音输入桥</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #637083;
      --line: #d9e0ea;
      --accent: #0f766e;
      --danger: #b42318;
      --ok: #137333;
      --shadow: 0 14px 40px rgba(22, 32, 51, 0.10);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }}
    body {{ padding: max(18px, env(safe-area-inset-top)) 16px max(22px, env(safe-area-inset-bottom)); }}
    main {{ width: min(760px, 100%); margin: 0 auto; display: grid; gap: 14px; }}
    header {{ display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 4px 2px 2px; }}
    h1 {{ margin: 0; font-size: 24px; line-height: 1.18; font-weight: 750; letter-spacing: 0; }}
    .server {{ margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.4; word-break: break-all; }}
    .status {{
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px;
      min-height: 34px; padding: 7px 10px; border: 1px solid var(--line);
      border-radius: 8px; background: var(--panel); box-shadow: 0 2px 10px rgba(22, 32, 51, 0.05);
      color: var(--muted); font-size: 13px; font-weight: 650; white-space: nowrap;
    }}
    .dot {{ width: 9px; height: 9px; border-radius: 50%; background: #9aa5b5; }}
    .status.ready {{ color: var(--ok); }}
    .status.ready .dot {{ background: var(--ok); }}
    .status.blocked {{ color: var(--muted); }}
    section {{ background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 14px; }}
    textarea {{
      width: 100%; min-height: 210px; resize: vertical; border: 1px solid var(--line);
      border-radius: 8px; padding: 13px 14px; color: var(--text);
      font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      outline: none; background: #fbfcfe;
    }}
    textarea:focus {{ border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.14); background: #fff; }}
    .toolbar {{ display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }}
    .checks {{ display: flex; flex-wrap: wrap; gap: 10px 14px; color: var(--muted); font-size: 14px; }}
    label {{ display: inline-flex; align-items: center; gap: 7px; user-select: none; }}
    input[type="checkbox"] {{ width: 18px; height: 18px; accent-color: var(--accent); }}
    input[type="number"] {{
      width: 70px; min-height: 34px; border: 1px solid var(--line); border-radius: 8px;
      padding: 5px 8px; color: var(--text); background: #fbfcfe;
      font: 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; outline: none;
    }}
    button {{
      display: inline-flex; align-items: center; justify-content: center; min-width: 118px; min-height: 44px;
      border: 0; border-radius: 8px; padding: 0 18px; color: #fff; background: var(--accent);
      font-size: 16px; font-weight: 750; cursor: pointer;
    }}
    button:disabled {{ background: #95a3b4; cursor: not-allowed; }}
    .meta {{ display: grid; gap: 8px; color: var(--muted); font-size: 13px; line-height: 1.45; }}
    .meta strong {{ color: var(--text); font-weight: 700; }}
    .message {{ min-height: 22px; color: var(--muted); font-size: 14px; line-height: 1.45; }}
    .message.ok {{ color: var(--ok); }}
    .message.err {{ color: var(--danger); }}
    @media (max-width: 560px) {{
      body {{ padding-left: 12px; padding-right: 12px; }}
      header {{ flex-direction: column; }}
      .status {{ align-self: stretch; justify-content: center; }}
      h1 {{ font-size: 22px; }}
      section {{ padding: 12px; }}
      textarea {{ min-height: 260px; font-size: 18px; }}
      .toolbar {{ align-items: stretch; }}
      .checks {{ width: 100%; }}
      button {{ width: 100%; min-height: 48px; }}
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>豆包语音输入桥</h1>
        <div class="server">{safe_server}</div>
      </div>
      <div id="status" class="status"><span class="dot"></span><span>检测中</span></div>
    </header>

    <section>
      <textarea id="text" placeholder="点这里，用手机豆包输入法语音转文字，然后发送到电脑当前输入框。"></textarea>
      <div class="toolbar">
        <div class="checks">
          <label><input id="clearAfterSend" type="checkbox" checked>发送后清空</label>
          <label><input id="newline" type="checkbox">末尾加换行</label>
          <label><input id="pressEnter" type="checkbox">发送后回车</label>
          <label>回车延时 <input id="enterDelay" type="number" min="0" max="5" step="0.1" value="0.5"> 秒</label>
        </div>
        <button id="send">发送</button>
      </div>
      <div id="message" class="message"></div>
    </section>

    <section class="meta">
      <div><strong>电脑端：</strong><span id="target">直接粘贴模式</span></div>
      <div><strong>提示：</strong>电脑上先点到目标输入框，再在手机上发送。服务不会判断焦点类型，发送后会直接写入剪贴板并触发 Ctrl+V。</div>
    </section>
  </main>

  <script>
    const ACCESS_KEY = "{safe_key}";
    const statusEl = document.getElementById("status");
    const statusText = statusEl.querySelector("span:last-child");
    const targetEl = document.getElementById("target");
    const textEl = document.getElementById("text");
    const sendBtn = document.getElementById("send");
    const messageEl = document.getElementById("message");
    const clearAfterSendEl = document.getElementById("clearAfterSend");
    const newlineEl = document.getElementById("newline");
    const pressEnterEl = document.getElementById("pressEnter");
    const enterDelayEl = document.getElementById("enterDelay");

    function setMessage(text, kind = "") {{
      messageEl.textContent = text;
      messageEl.className = "message" + (kind ? " " + kind : "");
    }}

    async function refreshStatus() {{
      try {{
        const res = await fetch("/health", {{ cache: "no-store" }});
        const data = await res.json();
        if (res.ok && data.ok) {{
          statusEl.className = "status ready";
          statusText.textContent = "服务在线";
          targetEl.textContent = "直接写入剪贴板并触发 Ctrl+V";
        }}
      }} catch (err) {{
        statusEl.className = "status blocked";
        statusText.textContent = "服务离线";
        targetEl.textContent = String(err);
      }}
    }}

    async function sendText() {{
      const text = textEl.value;
      if (!text.trim()) {{
        setMessage("没有可发送的文字。", "err");
        textEl.focus();
        return;
      }}
      sendBtn.disabled = true;
      setMessage("发送中...");
      try {{
        const res = await fetch("/send", {{
          method: "POST",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify({{
            key: ACCESS_KEY,
            text,
            add_newline: newlineEl.checked,
            press_enter: pressEnterEl.checked,
            enter_delay_sec: Number(enterDelayEl.value || 0.5)
          }})
        }});
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "发送失败");
        const suffix = data.result.enter_pressed ? "，并已回车" : "";
        setMessage(`已发送 ${{data.result.chars}} 个字符，电脑已执行粘贴${{suffix}}。`, "ok");
        if (clearAfterSendEl.checked) textEl.value = "";
        await refreshStatus();
      }} catch (err) {{
        setMessage(String(err.message || err), "err");
      }} finally {{
        sendBtn.disabled = false;
        textEl.focus();
      }}
    }}

    sendBtn.addEventListener("click", sendText);
    textEl.addEventListener("keydown", (event) => {{
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {{
        event.preventDefault();
        sendText();
      }}
    }});
    refreshStatus();
    setInterval(refreshStatus, 5000);
    textEl.focus();
  </script>
</body>
</html>"""


class BridgeServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class, access_key: str, log_queue=None):
        super().__init__(server_address, handler_class)
        self.access_key = access_key
        self.log_queue = log_queue
        self.state = {
            "started_at": time.time(),
            "last_action": "waiting",
            "last_error": "",
            "last_sent_at": None,
        }
        self.state_lock = threading.Lock()

    def add_log(self, message: str) -> None:
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
        try:
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
        if self.log_queue is not None:
            self.log_queue.put(line)


class BridgeRequestHandler(BaseHTTPRequestHandler):
    server_version = "DoubaoInputBridgeGUI/1.0"

    def log_message(self, fmt: str, *args) -> None:
        self.server.add_log(f"{self.client_address[0]} {fmt % args}")

    def is_authorized(self, key: str) -> bool:
        return bool(key) and key == self.server.access_key

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            key = parse_qs(parsed.query).get("key", [""])[0]
            if not self.is_authorized(key):
                text_response(
                    self,
                    HTTPStatus.UNAUTHORIZED,
                    "Missing or invalid key. Open the URL shown in the desktop app.",
                    "text/plain; charset=utf-8",
                )
                return
            page = html_page(self.server.access_key, self.headers.get("Host", "LAN service"))
            text_response(self, HTTPStatus.OK, page, "text/html; charset=utf-8")
            return

        if parsed.path == "/health":
            json_response(self, HTTPStatus.OK, {"ok": True, "app": APP_NAME})
            return

        if parsed.path == "/status":
            key = parse_qs(parsed.query).get("key", [""])[0]
            if not self.is_authorized(key):
                json_response(self, HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "invalid key"})
                return
            with self.server.state_lock:
                state = dict(self.server.state)
            json_response(self, HTTPStatus.OK, {"ok": True, "state": state, "time": now_ms()})
            return

        text_response(self, HTTPStatus.NOT_FOUND, "Not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/send":
            json_response(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length)
            data = json.loads(raw_body.decode("utf-8"))
        except Exception:
            json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid JSON"})
            return

        if not self.is_authorized(str(data.get("key", ""))):
            json_response(self, HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "invalid key"})
            return

        text = str(data.get("text", ""))
        add_newline = bool(data.get("add_newline", False))
        press_enter = bool(data.get("press_enter", False))
        try:
            enter_delay_sec = float(data.get("enter_delay_sec", 0.5))
        except (TypeError, ValueError):
            enter_delay_sec = 0.5
        enter_delay_sec = max(0.0, min(5.0, enter_delay_sec))

        if not text.strip():
            json_response(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "empty text"})
            return
        if len(text) > MAX_TEXT_LENGTH:
            json_response(
                self,
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": f"text is too long; max {MAX_TEXT_LENGTH} chars"},
            )
            return

        try:
            result = paste_text(
                text,
                add_newline=add_newline,
                press_enter=press_enter,
                enter_delay_sec=enter_delay_sec,
            )
            with self.server.state_lock:
                self.server.state["last_sent_at"] = result["sent_at"]
                self.server.state["last_action"] = "pasted"
                self.server.state["last_error"] = ""
            self.server.add_log(
                f"pasted {result['chars']} chars, enter={result['enter_pressed']}"
            )
            json_response(self, HTTPStatus.OK, {"ok": True, "result": result})
        except Exception as exc:
            with self.server.state_lock:
                self.server.state["last_action"] = "paste failed"
                self.server.state["last_error"] = str(exc)
            self.server.add_log(f"paste failed: {exc}")
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})


class BridgeGui:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("760x560")
        self.root.minsize(680, 500)

        self.log_queue: queue.Queue[str] = queue.Queue()
        self.server: BridgeServer | None = None
        self.server_thread: threading.Thread | None = None
        self.access_key = read_or_create_access_key()

        self.port_var = tk.StringVar(value=str(DEFAULT_PORT))
        self.status_var = tk.StringVar(value="未启动")
        self.key_var = tk.StringVar(value=self.access_key)

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(200, self.start_server)
        self.root.after(250, self.drain_logs)

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(3, weight=1)

        header = ttk.Frame(self.root, padding=(14, 14, 14, 8))
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(1, weight=1)
        ttk.Label(header, text=APP_NAME, font=("Microsoft YaHei UI", 16, "bold")).grid(
            row=0, column=0, columnspan=4, sticky="w"
        )
        ttk.Label(header, text="手机网页输入，Windows 当前焦点直接粘贴。").grid(
            row=1, column=0, columnspan=4, sticky="w", pady=(4, 0)
        )

        controls = ttk.Frame(self.root, padding=(14, 4, 14, 8))
        controls.grid(row=1, column=0, sticky="ew")
        controls.columnconfigure(6, weight=1)

        ttk.Label(controls, text="端口").grid(row=0, column=0, sticky="w")
        ttk.Entry(controls, width=8, textvariable=self.port_var).grid(
            row=0, column=1, sticky="w", padx=(6, 14)
        )
        ttk.Button(controls, text="启动", command=self.start_server).grid(row=0, column=2, padx=4)
        ttk.Button(controls, text="停止", command=self.stop_server).grid(row=0, column=3, padx=4)
        ttk.Button(controls, text="打开本机页面", command=self.open_local_url).grid(
            row=0, column=4, padx=4
        )
        ttk.Button(controls, text="复制全部地址", command=self.copy_urls).grid(
            row=0, column=5, padx=4
        )
        ttk.Label(controls, textvariable=self.status_var).grid(row=0, column=6, sticky="e")

        key_frame = ttk.Frame(self.root, padding=(14, 0, 14, 8))
        key_frame.grid(row=2, column=0, sticky="ew")
        key_frame.columnconfigure(1, weight=1)
        ttk.Label(key_frame, text="访问密钥").grid(row=0, column=0, sticky="w")
        ttk.Entry(key_frame, textvariable=self.key_var, state="readonly").grid(
            row=0, column=1, sticky="ew", padx=8
        )
        ttk.Button(key_frame, text="复制密钥", command=self.copy_key).grid(row=0, column=2, padx=4)
        ttk.Button(key_frame, text="重新生成", command=self.regenerate_key).grid(row=0, column=3, padx=4)

        body = ttk.Frame(self.root, padding=(14, 0, 14, 14))
        body.grid(row=3, column=0, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.rowconfigure(1, weight=1)
        body.rowconfigure(3, weight=1)

        ttk.Label(body, text="手机访问地址").grid(row=0, column=0, sticky="w")
        self.urls_text = tk.Text(body, height=7, wrap="word", font=("Consolas", 10))
        self.urls_text.grid(row=1, column=0, sticky="nsew", pady=(4, 12))
        self.urls_text.configure(state="disabled")

        ttk.Label(body, text="运行日志").grid(row=2, column=0, sticky="w")
        self.log_text = tk.Text(body, height=9, wrap="word", font=("Consolas", 10))
        self.log_text.grid(row=3, column=0, sticky="nsew", pady=(4, 0))
        self.log_text.configure(state="disabled")

        footer = ttk.Label(
            self.root,
            text=f"配置和日志目录：{DATA_DIR}",
            padding=(14, 0, 14, 10),
        )
        footer.grid(row=4, column=0, sticky="ew")

    def run(self) -> None:
        self.root.mainloop()

    def log(self, message: str) -> None:
        self.log_queue.put(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}")

    def drain_logs(self) -> None:
        changed = False
        while True:
            try:
                line = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.log_text.configure(state="normal")
            self.log_text.insert("end", line + "\n")
            self.log_text.see("end")
            self.log_text.configure(state="disabled")
            changed = True
        if changed:
            self.update_urls()
        self.root.after(250, self.drain_logs)

    def start_server(self) -> None:
        if self.server is not None:
            return
        try:
            port = int(self.port_var.get().strip())
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            messagebox.showerror(APP_NAME, "端口必须是 1 到 65535 之间的数字。")
            return

        self.access_key = self.key_var.get().strip() or read_or_create_access_key()
        try:
            server = BridgeServer(("0.0.0.0", port), BridgeRequestHandler, self.access_key, self.log_queue)
        except OSError as exc:
            self.status_var.set("启动失败")
            messagebox.showerror(APP_NAME, f"无法监听端口 {port}：\n{exc}")
            return

        self.server = server
        self.server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        self.server_thread.start()
        self.status_var.set(f"运行中：0.0.0.0:{port}")
        self.log(f"service started on 0.0.0.0:{port}")
        self.update_urls()

    def stop_server(self) -> None:
        if self.server is None:
            return
        server = self.server
        self.server = None
        self.status_var.set("正在停止")
        threading.Thread(target=self._shutdown_server, args=(server,), daemon=True).start()

    def _shutdown_server(self, server: BridgeServer) -> None:
        server.shutdown()
        server.server_close()
        self.log("service stopped")
        self.root.after(0, lambda: self.status_var.set("已停止"))
        self.root.after(0, self.update_urls)

    def current_port(self) -> int:
        try:
            return int(self.port_var.get().strip())
        except ValueError:
            return DEFAULT_PORT

    def make_urls(self) -> list[str]:
        port = self.current_port()
        key = self.key_var.get().strip()
        urls = [f"http://127.0.0.1:{port}/?key={key}"]
        for ip in get_lan_ipv4_addresses():
            urls.append(f"http://{ip}:{port}/?key={key}")
        return urls

    def update_urls(self) -> None:
        urls = self.make_urls()
        lines = ["本机测试地址：", urls[0], "", "手机访问地址：", *urls[1:]]
        if len(urls) == 1:
            lines.append("未检测到局域网 IPv4 地址，请确认网络连接。")
        self.urls_text.configure(state="normal")
        self.urls_text.delete("1.0", "end")
        self.urls_text.insert("1.0", "\n".join(lines))
        self.urls_text.configure(state="disabled")

    def copy_urls(self) -> None:
        text = self.urls_text.get("1.0", "end-1c")
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.log("URLs copied to clipboard")

    def copy_key(self) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(self.key_var.get())
        self.log("access key copied to clipboard")

    def regenerate_key(self) -> None:
        if self.server is not None:
            messagebox.showinfo(APP_NAME, "请先停止服务，再重新生成访问密钥。")
            return
        self.access_key = write_new_access_key()
        self.key_var.set(self.access_key)
        self.update_urls()
        self.log("access key regenerated")

    def open_local_url(self) -> None:
        webbrowser.open(self.make_urls()[0])

    def on_close(self) -> None:
        if self.server is not None:
            server = self.server
            self.server = None
            server.shutdown()
            server.server_close()
        self.root.destroy()


def run_server_only(port: int) -> int:
    key = read_or_create_access_key()
    server = BridgeServer(("0.0.0.0", port), BridgeRequestHandler, key)
    print(f"{APP_NAME} server-only mode on 0.0.0.0:{port}")
    print(f"Local URL: http://127.0.0.1:{port}/?key={key}")
    for ip in get_lan_ipv4_addresses():
        print(f"Phone URL: http://{ip}:{port}/?key={key}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--server-only", action="store_true")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    if args.server_only:
        return run_server_only(args.port)

    if not IS_WINDOWS:
        messagebox.showerror(APP_NAME, "这个程序需要在 Windows 上运行。")
        return 1

    BridgeGui().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
