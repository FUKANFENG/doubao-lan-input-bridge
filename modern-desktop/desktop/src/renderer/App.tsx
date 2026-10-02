import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import type { BridgeState } from "../shared/types";

const emptyState: BridgeState = {
  status: "stopped",
  port: 8765,
  accessKey: "",
  localUrl: "",
  phoneUrl: "",
  selectedAddress: "127.0.0.1",
  addresses: [],
  message: "正在读取服务状态"
};

export function App() {
  const [state, setState] = useState<BridgeState>(emptyState);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const statusText = useMemo(() => {
    if (state.status === "running") return "运行中";
    if (state.status === "starting") return "启动中";
    if (state.status === "error") return "异常";
    return "已停止";
  }, [state.status]);

  useEffect(() => {
    void window.bridge.getState().then(setState);
    const unsubscribe = window.bridge.onStateChanged(setState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!state.phoneUrl) {
      setQrDataUrl("");
      return;
    }
    void QRCode.toDataURL(state.phoneUrl, {
      width: 360,
      margin: 1,
      color: {
        dark: "#132033",
        light: "#ffffff"
      }
    }).then(setQrDataUrl);
  }, [state.phoneUrl]);

  async function runAction(action: () => Promise<BridgeState | void>, message: string) {
    setBusy(true);
    setNotice("");
    try {
      const next = await action();
      if (next) setState(next);
      setNotice(message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>豆包局域网输入桥</h1>
          <p>手机扫码打开输入页，文字会粘贴到电脑当前焦点位置。</p>
        </div>
        <div className={`status-pill ${state.status}`}>
          <span />
          {statusText}
        </div>
      </section>

      <section className="dashboard">
        <div className="qr-panel">
          <div className="qr-card">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="手机访问二维码" />
            ) : (
              <div className="qr-empty">等待服务地址</div>
            )}
          </div>
          <div className="phone-url">
            <span>手机访问地址</span>
            <strong>{state.phoneUrl || "暂无可用地址"}</strong>
          </div>
          <div className="primary-actions">
            <button
              type="button"
              disabled={!state.phoneUrl || busy}
              onClick={() => runAction(() => window.bridge.copyText(state.phoneUrl), "手机地址已复制")}
            >
              复制手机地址
            </button>
            <button
              type="button"
              disabled={!state.localUrl || busy}
              onClick={() => runAction(() => window.bridge.openUrl(state.localUrl), "已打开本机页面")}
            >
              打开本机页面
            </button>
          </div>
        </div>

        <div className="control-panel">
          <div className="panel-header">
            <h2>服务控制</h2>
            <p>{state.message}</p>
          </div>

          <div className="details-grid">
            <Info label="端口" value={String(state.port)} />
            <Info label="当前 IP" value={state.selectedAddress} />
            <Info label="访问密钥" value={state.accessKey || "未生成"} mono />
            <Info label="本机地址" value={state.localUrl || "暂无"} mono />
          </div>

          <label className="field">
            <span>局域网地址</span>
            <select
              value={state.selectedAddress}
              disabled={busy || state.addresses.length === 0}
              onChange={(event) =>
                runAction(
                  () => window.bridge.selectAddress(event.currentTarget.value),
                  "局域网地址已切换"
                )
              }
            >
              {state.addresses.length === 0 ? (
                <option value={state.selectedAddress}>{state.selectedAddress}</option>
              ) : (
                state.addresses.map((address) => (
                  <option key={`${address.interfaceName}-${address.address}`} value={address.address}>
                    {address.address} - {address.interfaceName}
                    {address.isVirtual ? "（备用）" : ""}
                  </option>
                ))
              )}
            </select>
          </label>

          <div className="button-grid">
            <button
              type="button"
              disabled={busy || state.status === "running" || state.status === "starting"}
              onClick={() => runAction(() => window.bridge.start(), "服务已启动")}
            >
              启动服务
            </button>
            <button
              type="button"
              disabled={busy || state.status !== "running"}
              onClick={() => runAction(() => window.bridge.stop(), "服务已停止")}
            >
              停止服务
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => window.bridge.refresh(), "网络地址已刷新")}
            >
              刷新网络地址
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => window.bridge.regenerateKey(), "访问密钥已重新生成")}
            >
              重新生成密钥
            </button>
          </div>

          {notice ? <div className="notice">{notice}</div> : null}

          <div className="hint">
            手机和电脑需要连接同一个局域网。第一次运行时如果 Windows 防火墙弹窗，请允许专用网络访问。
          </div>
        </div>
      </section>
    </main>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}
