(() => {
  const workletUrl = document.currentScript.dataset.worklet;
  window.ContinuousCapture = class {
    constructor(options) {
      this.options = options;
      this.sequence = 0;
      this.cancelled = false;
      this.finished = false;
      this.bufferedBytes = 0;
    }
    async start() {
      try {
        try { this.context = new AudioContext({ sampleRate: 16000 }); }
        catch { this.context = new AudioContext(); }
        await this.context.resume();
        if (this.cancelled) return;
        await this.context.audioWorklet.addModule(workletUrl);
        if (this.cancelled) return;
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
        if (this.cancelled) { this.stream.getTracks().forEach((t) => t.stop()); return; }
        this.node = new AudioWorkletNode(this.context, 'chunk-capture', {
          channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
          processorOptions: { chunkSeconds: this.options.chunkSeconds, budgetBytes: this.options.budget() },
        });
        this.node.port.onmessage = ({ data }) => {
          if (this.finished) return;
          if (data.type === 'chunk') {
            this.sequence = data.sequence;
            this.bufferedBytes = 0;
            this.options.onChunk(this.wav(data.samples), data.sequence);
            this.setBudget();
          }
          if (data.type === 'progress') { this.bufferedBytes = data.bufferedBytes; this.options.onProgress(data); }
          if (data.type === 'stopped') this.finish(data.reason);
        };
        this.node.onprocessorerror = () => { this.options.onError(new Error('A captura de áudio foi interrompida.')); this.finish('error'); };
        this.input = this.context.createMediaStreamSource(this.stream);
        this.input.connect(this.node);
        this.node.connect(this.context.destination); // Processor outputs silence, never microphone feedback.
        this.stream.getTracks().forEach((t) => { t.onended = () => this.stop(); });
        this.context.onstatechange = () => {
          if (!this.cancelled && this.context.state === 'suspended') this.stop();
        };
        this.options.onStarted();
      } catch (error) {
        if (!this.cancelled) this.options.onError(error);
        this.finish('error');
      }
    }
    setBudget() { this.node?.port.postMessage({ type: 'budget', bytes: this.options.budget(), ack: this.sequence }); }
    stop() {
      if (this.cancelled) return;
      this.cancelled = true;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.input?.disconnect();
      if (this.node && this.context.state === 'running') {
        this.node.port.postMessage({ type: 'stop' });
        this.stopTimer = setTimeout(() => this.finish('released'), 1500);
      } else this.finish('released');
    }
    finish(reason) {
      if (this.finished) return;
      this.finished = this.cancelled = true;
      clearTimeout(this.stopTimer);
      this.stream?.getTracks().forEach((t) => t.stop());
      this.input?.disconnect();
      this.node?.disconnect();
      this.context?.close().catch(() => {});
      this.bufferedBytes = 0;
      this.options.onStopped(reason);
    }
    wav(buffer) {
      const samples = new Int16Array(buffer);
      const bytes = new ArrayBuffer(44 + buffer.byteLength);
      const data = new DataView(bytes);
      const word = (offset, value) => { for (let i = 0; i < value.length; i++) data.setUint8(offset + i, value.charCodeAt(i)); };
      word(0, 'RIFF'); data.setUint32(4, bytes.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
      data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
      data.setUint32(24, 16000, true); data.setUint32(28, 32000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
      word(36, 'data'); data.setUint32(40, buffer.byteLength, true);
      for (let i = 0; i < samples.length; i++) data.setInt16(44 + i * 2, samples[i], true);
      return new Blob([bytes], { type: 'audio/wav' });
    }
  };
})();
