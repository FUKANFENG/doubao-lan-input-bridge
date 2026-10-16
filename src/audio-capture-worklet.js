class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 2048;
    this.samples = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.startFrame = 0;
    this.unacknowledged = 0;
    this.maxInFlight = 8;
    this.dropped = 0;
    this.port.onmessage = (event) => {
      if (event.data === "ack") this.unacknowledged = Math.max(0, this.unacknowledged - 1);
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.offset === 0) this.startFrame = currentFrame + i;
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.samples[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === this.chunkSize) {
        if (this.unacknowledged < this.maxInFlight) {
          this.port.postMessage({ pcm: this.samples.buffer, capturedAt: this.startFrame / sampleRate,
            dropped: this.dropped }, [this.samples.buffer]);
          this.unacknowledged++;
          this.samples = new Int16Array(this.chunkSize);
        } else {
          this.dropped++;
        }
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
