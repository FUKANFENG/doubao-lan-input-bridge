import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
import time
from urllib import request as urllib_request


IS_WINDOWS = os.name == "nt"

if IS_WINDOWS:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    KEYEVENTF_KEYUP = 0x0002

    ULONG_PTR = wintypes.WPARAM
    INPUT_KEYBOARD = 1

    VK_CONTROL = 0x11
    VK_LWIN = 0x5B
    VK_V = 0x56
    VK_RETURN = 0x0D

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]

    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ULONG_PTR]
    user32.keybd_event.restype = None
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT

    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL


def win_error(prefix):
    return ctypes.WinError(ctypes.get_last_error(), prefix)


def set_clipboard_text(text, retries=10):
    payload = (text + "\0").encode("utf-16-le")
    last_error = None
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


def keyboard_input(vk, flags=0):
    item = INPUT()
    item.type = INPUT_KEYBOARD
    item.union.ki = KEYBDINPUT(vk, 0, flags, 0, 0)
    return item


def send_keys(sequence):
    events = (INPUT * len(sequence))(*[keyboard_input(vk, flags) for vk, flags in sequence])
    sent = user32.SendInput(len(sequence), events, ctypes.sizeof(INPUT))
    if sent != len(sequence):
        raise win_error("SendInput failed")


def send_modified_v(mode):
    modifier = VK_LWIN if mode == "mac_remote" else VK_CONTROL
    send_keys([
        (modifier, 0),
        (VK_V, 0),
        (VK_V, KEYEVENTF_KEYUP),
        (modifier, KEYEVENTF_KEYUP),
    ])


def send_enter():
    send_keys([(VK_RETURN, 0), (VK_RETURN, KEYEVENTF_KEYUP)])


def main():
    if not IS_WINDOWS:
        raise RuntimeError("key helper only supports Windows")
    raw = sys.stdin.read()
    data = json.loads(raw or "{}")
    text = str(data.get("text", ""))
    mode = data.get("mode", "windows")
    add_newline = bool(data.get("add_newline", False))
    press_enter = bool(data.get("press_enter", False))
    try:
        enter_delay_sec = float(data.get("enter_delay_sec", 0.5))
    except (TypeError, ValueError):
        enter_delay_sec = 0.5
    enter_delay_sec = max(0.0, min(5.0, enter_delay_sec))

    payload = text + ("\n" if add_newline else "")
    set_clipboard_text(payload)
    time.sleep(0.08)
    send_modified_v(mode)
    enter_pressed = False
    if press_enter:
        time.sleep(enter_delay_sec)
        send_enter()
        enter_pressed = True
    print(json.dumps({"chars": len(payload), "sent_at": int(time.time() * 1000), "enter_pressed": enter_pressed}))


def json_response(handler, status, data):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


class HelperHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path == "/health":
            json_response(self, 200, {"ok": True})
            return
        json_response(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/paste":
            json_response(self, 404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(data.get("text", ""))
            mode = data.get("mode", "windows")
            add_newline = bool(data.get("add_newline", False))
            press_enter = bool(data.get("press_enter", False))
            try:
                enter_delay_sec = float(data.get("enter_delay_sec", 0.5))
            except (TypeError, ValueError):
                enter_delay_sec = 0.5
            enter_delay_sec = max(0.0, min(5.0, enter_delay_sec))
            payload = text + ("\n" if add_newline else "")
            set_clipboard_text(payload)
            time.sleep(0.08)
            send_modified_v(mode)
            enter_pressed = False
            if press_enter:
                time.sleep(enter_delay_sec)
                send_enter()
                enter_pressed = True
            json_response(
                self,
                200,
                {"ok": True, "result": {"chars": len(payload), "sent_at": int(time.time() * 1000), "enter_pressed": enter_pressed}},
            )
        except Exception as exc:
            json_response(self, 500, {"ok": False, "error": str(exc)})


def run_server(port):
    server = ThreadingHTTPServer(("127.0.0.1", port), HelperHandler)
    actual_port = server.server_address[1]
    print(json.dumps({"ok": True, "port": actual_port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        if "--server" in sys.argv:
            idx = sys.argv.index("--server")
            port = int(sys.argv[idx + 1]) if len(sys.argv) > idx + 1 else 0
            run_server(port)
        else:
            main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise
