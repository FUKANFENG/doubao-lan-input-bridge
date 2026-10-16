(function (root) {
  "use strict";

  class AudioLink {
    constructor({ url, onPacket, onStatus, onState, socketFactory = url => new WebSocket(url),
      now = () => Date.now(), later = (fn, delay) => setTimeout(fn, delay), cancel = id => clearTimeout(id) }) {
      Object.assign(this, { url, onPacket, onStatus, onState, socketFactory, now, later, cancel });
      this.enabled = false;
      this.socket = null;
      this.attempt = 0;
      this.reconnects = 0;
      this.receiveGapMs = 0;
      this.maxReceiveGapMs = 0;
      this.timer = null;
      this.watchdog = null;
    }

    start() {
      if (this.enabled) return;
      this.enabled = true;
      this.connect();
    }

    disposeSocket() {
      const ws = this.socket;
      this.socket = null;
      this.cancel(this.watchdog);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      }
    }

    connect() {
      if (!this.enabled) return;
      this.cancel(this.timer);
      this.disposeSocket();
      this.onState("connecting");
      this.lastSeen = this.now();
      this.lastPacket = null;
      let ws;
      try { ws = this.socketFactory(this.url()); } catch { this.retry(); return; }
      this.socket = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { if (this.socket === ws) this.onState("connected"); };
      ws.onmessage = event => {
        if (this.socket !== ws) return;
        this.lastSeen = this.now();
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "audio-status") this.onStatus(data);
          } catch { /* invalid control message */ }
        } else {
          this.attempt = 0;
          this.onPacket(event.data);
        }
      };
      ws.onclose = ws.onerror = () => { if (this.socket === ws) this.retry(); };
      const watch = () => {
        if (this.socket !== ws || !this.enabled) return;
        if (this.now() - this.lastSeen > 10000) { this.retry(); return; }
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: "ping" })); } catch { this.retry(); return; }
        }
        this.watchdog = this.later(watch, 2000);
      };
      this.watchdog = this.later(watch, 2000);
    }

    notePacket(durationMs) {
      const now = this.now();
      this.receiveGapMs = this.lastPacket === null ? 0 : Math.round(Math.max(0, now - this.lastPacket - durationMs));
      this.maxReceiveGapMs = Math.max(this.maxReceiveGapMs, this.receiveGapMs);
      this.lastPacket = now;
    }

    retry() {
      if (!this.enabled) return;
      this.disposeSocket();
      this.cancel(this.timer);
      this.reconnects++;
      const delay = Math.min(8000, 500 * 2 ** Math.min(this.attempt++, 4));
      this.onState("reconnecting", delay);
      this.timer = this.later(() => this.connect(), delay);
    }

    stop() {
      this.enabled = false;
      this.cancel(this.timer);
      this.disposeSocket();
      this.attempt = 0;
      this.onState("stopped");
    }
  }

  function init({ key }) {
    const el = id => document.getElementById(id);
    const start = el("audioStart"), stop = el("audioStop"), slider = el("audioBuffer"), output = el("audioBufferValue");
    const message = el("audioMessage"), title = el("audioTitle"), detail = el("audioDetail"), dot = el("audioDot");
    let context = null, player = null, wanted = false, generation = 0, serverStatus = null, sessionId = null;
    let connectionState = "stopped", receivedAt = 0, lastDiagnostic = 0;
    try { slider.value = String(Math.max(200, Math.min(600, Number(localStorage.getItem("doubaoAudioBufferMs")) || 300))); } catch { slider.value = "300"; }
    output.textContent = slider.value + " ms";
    const setMessage = (text, error = false) => { message.textContent = text; message.className = "message" + (error ? " err" : ""); };
    const link = new AudioLink({
      url: () => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/audio?protocol=2&key=" + encodeURIComponent(key),
      onState(state, delay) {
        connectionState = state;
        if (state !== "connected" && player) player.reset();
        if (state === "reconnecting") setMessage("连接中断，" + delay / 1000 + " 秒后重试。");
        if (state === "connected") setMessage("");
        render();
      },
      onStatus(status) {
        if (status.protocol !== 2) {
          stopPlayback();
          setMessage("电脑端版本不匹配，请升级后重新扫码。", true);
          return;
        }
        if (player && (status.sessionId !== sessionId || (serverStatus && status.capturing !== serverStatus.capturing))) player.reset();
        sessionId = status.sessionId;
        serverStatus = status;
        render();
      },
      onPacket(data) {
        const packet = root.BridgeAudio.decodePacket(data);
        if (!packet || !player || !serverStatus?.capturing) return;
        link.notePacket(packet.samples.length / packet.sampleRate * 1000);
        receivedAt = Date.now();
        player.enqueue(packet);
      }
    });

    function render() {
      const suspended = wanted && context && context.state !== "running";
      start.disabled = wanted && !suspended;
      start.textContent = suspended ? "继续播放" : "开始播放电脑声音";
      stop.disabled = !wanted;
      dot.className = connectionState === "connected" && !suspended ? "audioDot live" : "audioDot";
      title.textContent = !wanted ? "电脑声音未连接" : suspended ? "音频已暂停" :
        connectionState === "reconnecting" ? "正在重新连接" : connectionState !== "connected" ? "正在连接电脑声音" :
        !serverStatus?.capturing ? "等待电脑采集" : Date.now() - receivedAt > 2000 ? "等待音频数据" :
        player?.snapshot().buffering ? "正在缓冲" : "正在播放电脑声音";
      const stats = player?.snapshot();
      detail.textContent = stats && wanted ? "缓冲 " + stats.queuedMs + " / " + stats.targetMs + " ms" : "";
      el("audioDiagnostics").textContent = wanted && stats ?
        "播放断供 " + stats.underruns + " 次 · 队列重置 " + stats.overruns + " 次 · 音频间断 " + stats.sequenceGaps + " 次\n" +
        "收包额外间隔 " + link.receiveGapMs + " ms（最大 " + link.maxReceiveGapMs + "） · 重连 " + link.reconnects + " 次\n" +
        "采集额外间隔 " + (serverStatus?.captureGapMs || 0) + " ms（最大 " + (serverStatus?.maxCaptureGapMs || 0) + "）\n" +
        "采集交付 " + (serverStatus?.captureDeliveryMs || 0) + " ms · 发送积压 " + (serverStatus?.sendQueueMs || 0) + " ms\n" +
        "过期块 " + (serverStatus?.lateChunks || 0) + " · 采集丢弃 " + (serverStatus?.workletDropped || 0) + " · 慢连接重置 " + (serverStatus?.slowDisconnects || 0) : "暂无音频数据";
    }

    async function startPlayback() {
      const token = ++generation;
      start.disabled = true;
      setMessage("");
      try {
        context = context || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
        const activeContext = context;
        await activeContext.resume();
        if (token !== generation) return;
        if (activeContext.state !== "running") throw new Error("浏览器暂停了声音，请再次点击继续播放。");
        player = player || new root.BridgeAudio.PcmPlayer(activeContext, Number(slider.value));
        player.reset();
        activeContext.onstatechange = () => { if (context === activeContext) { player?.reset(); render(); } };
        wanted = true;
        if (link.enabled) link.connect(); else link.start();
        render();
      } catch (error) {
        if (token !== generation) return;
        stopPlayback();
        setMessage(error.message || String(error), true);
      }
    }

    function stopPlayback() {
      generation++;
      wanted = false;
      link.stop();
      player?.reset();
      player = null;
      if (context) { context.onstatechange = null; context.close().catch(() => {}); context = null; }
      serverStatus = null;
      sessionId = null;
      render();
    }

    start.addEventListener("click", startPlayback);
    stop.addEventListener("click", () => { stopPlayback(); setMessage(""); });
    slider.addEventListener("input", () => { output.textContent = slider.value + " ms"; });
    slider.addEventListener("change", () => {
      player?.setBufferMs(Number(slider.value));
      try { localStorage.setItem("doubaoAudioBufferMs", slider.value); } catch { /* storage unavailable */ }
      render();
    });
    window.addEventListener("online", () => { if (wanted) link.connect(); });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && wanted) {
        player?.reset();
        if (Date.now() - link.lastSeen > 10000) link.connect();
        render();
      }
    });
    const ticker = setInterval(() => {
      if (!wanted) return;
      player?.tick();
      if (Date.now() - lastDiagnostic > 500) { lastDiagnostic = Date.now(); render(); }
    }, 25);
    window.addEventListener("pagehide", () => { stopPlayback(); });
    window.addEventListener("unload", () => { clearInterval(ticker); });
    render();
    return { link, stop: stopPlayback };
  }

  if (typeof module === "object" && module.exports) module.exports = { AudioLink };
  else root.BridgeMobileAudio = { init };
})(typeof globalThis !== "undefined" ? globalThis : this);
