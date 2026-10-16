import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import captureWorkletSource from "./audio-capture-worklet.js?raw";
import "./styles.css";

const modeCopy = {
  auto: {
    title: "自动",
    detail: "优先匹配已绑定应用，其次识别常见远程工具，最后使用 Windows。"
  },
  windows: {
    title: "Windows",
    detail: "发送后模拟 Ctrl+V，适合本机 Windows 或远程 Windows。"
  },
  mac_remote: {
    title: "Mac 远程",
    detail: "发送后模拟 Windows 键+V，常见远程工具会映射为 macOS Command+V。"
  }
};

export default function App() {
  const [status, setStatus] = useState(null);
  const [portInput, setPortInput] = useState("8765");
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [audioCapture, setAudioCapture] = useState({ active: false, error: "" });
  const [bindingAction, setBindingAction] = useState({ busy: false, message: "", error: false });
  const captureRef = useRef(null);

  const primaryUrl = status?.urls?.primaryPhoneUrl || "";
  const allUrlsText = useMemo(() => {
    if (!status?.urls) return "";
    const lines = ["本机测试地址：", status.urls.localUrl, "", "手机访问地址："];
    if (status.urls.phoneUrls.length) lines.push(...status.urls.phoneUrls);
    else lines.push("未检测到局域网 IPv4 地址");
    return lines.join("\n");
  }, [status]);

  async function refresh() {
    const next = await window.bridgeApi.getStatus();
    setStatus(next);
    setPortInput(String(next.port || 8765));
  }

  useEffect(() => {
    refresh();
    const off = window.bridgeApi.onLog(() => refresh());
    const offAudio = window.bridgeApi.onAudioStatus((audio) => {
      setStatus((current) => (current ? { ...current, audio } : current));
    });
    const timer = setInterval(refresh, 3000);
    return () => {
      off();
      offAudio();
      clearInterval(timer);
      stopAudioCapture(false);
    };
  }, []);

  useEffect(() => {
    if (!primaryUrl) {
      setQr("");
      return;
    }
    QRCode.toDataURL(primaryUrl, {
      width: 256,
      margin: 1,
      color: { dark: "#172033", light: "#ffffff" }
    }).then(setQr);
  }, [primaryUrl]);

  async function runAction(action) {
    setBusy(true);
    try {
      const next = await action();
      setStatus(next);
    } finally {
      setBusy(false);
    }
  }

  async function captureBinding(mode) {
    setBindingAction({ busy: true, message: "请在 3 秒内切换到需要绑定的目标应用...", error: false });
    try {
      const result = await window.bridgeApi.captureAppBinding(mode, 3000);
      setStatus(result.status);
      setBindingAction({
        busy: false,
        message: `已绑定 ${result.binding.process} → ${mode === "mac_remote" ? "Mac 远程" : "Windows"}`,
        error: false
      });
    } catch (error) {
      setBindingAction({ busy: false, message: error.message || String(error), error: true });
    }
  }

  async function changeBinding(processKey, mode) {
    try {
      const next = await window.bridgeApi.updateAppBinding(processKey, mode);
      setStatus(next);
      setBindingAction({ busy: false, message: "应用绑定已更新。", error: false });
    } catch (error) {
      setBindingAction({ busy: false, message: error.message || String(error), error: true });
    }
  }

  async function removeBinding(processKey) {
    try {
      const next = await window.bridgeApi.deleteAppBinding(processKey);
      setStatus(next);
      setBindingAction({ busy: false, message: "应用绑定已删除。", error: false });
    } catch (error) {
      setBindingAction({ busy: false, message: error.message || String(error), error: true });
    }
  }

  function cleanupAudioCapture() {
    const current = captureRef.current;
    captureRef.current = null;
    if (!current) return;
    try {
      if (current.processor) {
        current.processor.port.onmessage = null;
        current.processor.port.close();
        current.processor.disconnect();
      }
      current.source?.disconnect();
      current.silentGain?.disconnect();
    } catch {
      // best effort only
    }
    for (const track of current.stream?.getTracks() || []) {
      track.stop();
    }
    current.audioContext?.close().catch(() => {});
  }

  async function stopAudioCapture(updateBridge = true) {
    cleanupAudioCapture();
    setAudioCapture({ active: false, error: "" });
    if (updateBridge) {
      const next = await window.bridgeApi.setAudioState({ capturing: false });
      setStatus(next);
    }
  }

  async function startAudioCapture() {
    if (captureRef.current) return;
    const current = {};
    captureRef.current = current;
    setAudioCapture({ active: false, starting: true, error: "" });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      if (captureRef.current !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      if (!stream.getAudioTracks().length) {
        throw new Error("没有捕获到系统音频。请确认当前是 Windows，并允许屏幕/系统音频采集。");
      }

      const audioContext = new AudioContext({ latencyHint: "interactive" });
      current.audioContext = audioContext;
      if (!audioContext.audioWorklet) throw new Error("当前桌面运行环境不支持 AudioWorklet。");
      const moduleUrl = URL.createObjectURL(new Blob([captureWorkletSource], { type: "text/javascript" }));
      try { await audioContext.audioWorklet.addModule(moduleUrl); }
      finally { URL.revokeObjectURL(moduleUrl); }
      if (captureRef.current !== current) return;
      await audioContext.resume();
      if (captureRef.current !== current) return;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(audioContext, "pcm-capture", { outputChannelCount: [1] });
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      Object.assign(current, { source, processor, silentGain });

      processor.port.onmessage = (event) => {
        if (captureRef.current !== current) return;
        const chunk = event.data;
        const duration = chunk.pcm.byteLength / 2 / audioContext.sampleRate;
        window.bridgeApi.sendAudioChunk({ ...chunk, sentAt: Date.now(),
          deliveryMs: Math.max(0, (audioContext.currentTime - chunk.capturedAt - duration) * 1000) })
          .then(() => { if (captureRef.current === current) processor.port.postMessage("ack"); })
          .catch(() => {
            if (captureRef.current !== current) return;
            stopAudioCapture().catch(() => {});
            setAudioCapture({ active: false, error: "音频传输失败，请重新开始采集。" });
          });
      };
      processor.onprocessorerror = () => {
        if (captureRef.current !== current) return;
        stopAudioCapture().catch(() => {});
        setAudioCapture({ active: false, error: "音频线程异常，请重新开始采集。" });
      };
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (captureRef.current === current) stopAudioCapture().catch(() => {});
        }, { once: true });
      }

      const next = await window.bridgeApi.setAudioState({
        capturing: true,
        sampleRate: audioContext.sampleRate
      });
      if (captureRef.current !== current) return;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      setStatus(next);
      setAudioCapture({ active: true, error: "" });
    } catch (error) {
      if (captureRef.current !== current) return;
      cleanupAudioCapture();
      await window.bridgeApi.setAudioState({ capturing: false }).catch(() => {});
      setAudioCapture({ active: false, error: error.message || String(error) });
    }
  }

  if (!status) {
    return <main className="loading">正在启动...</main>;
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <div className="titleLine">
            <h1>豆包语音输入桥</h1>
            <span className="versionTag">v{status.version}</span>
          </div>
          <p>手机端语音输入，桌面端自动粘贴。支持 Windows 本机和远程 Mac 输入模式。</p>
        </div>
        <div className={status.running ? "pill ok" : "pill"}>
          <span />
          {status.running ? `运行中 :${status.port}` : "已停止"}
        </div>
      </section>

      <section className="grid">
        <div className="panel qrPanel">
          <div className="panelHead">
            <h2>扫码打开手机页面</h2>
            <button type="button" onClick={() => window.bridgeApi.openUrl(primaryUrl)} disabled={!primaryUrl}>
              本机打开
            </button>
          </div>
          <div className="qrBox">
            {qr ? <img src={qr} alt="手机访问二维码" /> : <div className="qrEmpty">暂无地址</div>}
          </div>
          <div className="urlLine">{primaryUrl || "未检测到可用地址"}</div>
          <div className="buttonRow">
            <button type="button" onClick={() => window.bridgeApi.copyText(primaryUrl)} disabled={!primaryUrl}>
              复制手机地址
            </button>
            <button type="button" onClick={() => window.bridgeApi.copyText(allUrlsText)}>
              复制全部地址
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panelHead">
            <h2>服务控制</h2>
          </div>
          <label className="field">
            <span>端口</span>
            <input value={portInput} onChange={(event) => setPortInput(event.target.value)} />
          </label>
          <div className="buttonRow">
            <button
              type="button"
              disabled={busy || status.running}
              onClick={() => runAction(() => window.bridgeApi.start(Number(portInput)))}
            >
              启动
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !status.running}
              onClick={() => runAction(() => window.bridgeApi.stop())}
            >
              停止
            </button>
          </div>

          <label className="field">
            <span>访问密钥</span>
            <input value={status.key} readOnly />
          </label>
          <div className="buttonRow">
            <button type="button" className="secondary" onClick={() => window.bridgeApi.copyText(status.key)}>
              复制密钥
            </button>
            <button
              type="button"
              className="secondary"
              disabled={status.running}
              onClick={() => runAction(() => window.bridgeApi.regenerateKey())}
            >
              重新生成
            </button>
          </div>
        </div>
      </section>

      <section className="panel audioPanel">
        <div className="panelHead">
          <h2>电脑声音到手机</h2>
          <span className="hint">
            {status.audio?.clientCount || 0} 台手机已连接
            {status.audio?.capturing ? ` · ${status.audio.sampleRate || "?"} Hz` : ""}
          </span>
        </div>
        <div className="audioStatus">
          <div className={status.audio?.capturing ? "meter live" : "meter"} />
          <div>
            <strong>{status.audio?.capturing ? "正在推送电脑声音" : "未采集电脑声音"}</strong>
            <span>
              AudioWorklet · 采集额外间隔 {status.audio?.captureGapMs || 0} ms · 发送积压 {status.audio?.sendQueueMs || 0} ms
            </span>
          </div>
        </div>
        <div className="buttonRow">
          <button type="button" disabled={audioCapture.active || audioCapture.starting || !status.running} onClick={startAudioCapture}>
            {audioCapture.starting ? "正在启动" : "开始采集"}
          </button>
          <button type="button" className="secondary" disabled={!audioCapture.active && !audioCapture.starting} onClick={() => stopAudioCapture()}>
            停止采集
          </button>
        </div>
        {audioCapture.error ? <p className="notice error">{audioCapture.error}</p> : null}
      </section>

      <section className="panel">
        <div className="panelHead">
          <h2>粘贴模式</h2>
          <span className="hint">{status.modeLabel}</span>
        </div>
        <div className="modes">
          {Object.entries(modeCopy).map(([mode, copy]) => (
            <button
              key={mode}
              type="button"
              className={status.mode === mode ? "mode active" : "mode"}
              aria-pressed={status.mode === mode}
              onClick={() => runAction(() => window.bridgeApi.setMode(mode))}
            >
              <strong>{copy.title}</strong>
              <span>{copy.detail}</span>
            </button>
          ))}
        </div>
        <p className="notice">
          Mac 远程模式依赖远程控制工具把 Windows 键转成 macOS Command。不同远程工具设置不同，无法百分百自动识别远端系统；如果自动模式误判，直接手动切换。
        </p>
      </section>

      <section className="panel bindingPanel">
        <div className="panelHead">
          <h2>应用自动匹配</h2>
          <span className="hint">{status.appBindings?.length || 0} 条规则</span>
        </div>
        <div className="captureBar">
          <strong>捕获前台应用</strong>
          <div className="buttonRow compact">
            <button
              type="button"
              disabled={bindingAction.busy}
              onClick={() => captureBinding("windows")}
            >
              3 秒后绑定 Windows
            </button>
            <button
              type="button"
              className="secondary"
              disabled={bindingAction.busy}
              onClick={() => captureBinding("mac_remote")}
            >
              3 秒后绑定 Mac
            </button>
          </div>
        </div>
        {bindingAction.message ? (
          <p className={bindingAction.error ? "notice error" : "notice"}>{bindingAction.message}</p>
        ) : null}
        <div className="bindingList">
          {(status.appBindings || []).map((binding) => (
            <div className="bindingRow" key={binding.processKey}>
              <div className="bindingIdentity">
                <strong>{binding.process}</strong>
                <span>{binding.lastTitle || binding.path || binding.processKey}</span>
              </div>
              <div className="bindingControls" role="group" aria-label={`${binding.process} 粘贴模式`}>
                <button
                  type="button"
                  className={binding.mode === "windows" ? "ruleMode active" : "ruleMode"}
                  aria-pressed={binding.mode === "windows"}
                  onClick={() => changeBinding(binding.processKey, "windows")}
                >
                  Windows
                </button>
                <button
                  type="button"
                  className={binding.mode === "mac_remote" ? "ruleMode active" : "ruleMode"}
                  aria-pressed={binding.mode === "mac_remote"}
                  onClick={() => changeBinding(binding.processKey, "mac_remote")}
                >
                  Mac
                </button>
                <button type="button" className="deleteButton" onClick={() => removeBinding(binding.processKey)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {!status.appBindings?.length ? <div className="bindingEmpty">暂无应用绑定</div> : null}
        </div>
      </section>

      <section className="panel logPanel">
        <div className="panelHead">
          <h2>运行日志</h2>
          <span className="hint">{status.userData}</span>
        </div>
        <pre>{(status.logs || []).slice(-80).join("\n") || "暂无日志"}</pre>
      </section>
    </main>
  );
}
