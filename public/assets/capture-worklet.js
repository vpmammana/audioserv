/* Continuous mono PCM capture. Each emitted buffer is independently wrapped as WAV. */
class ChunkCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.rate = 16000;
    this.maxFrames = Math.round(Math.min(15, Math.max(1, o.chunkSeconds || 10)) * this.rate);
    this.minFrames = Math.min(this.maxFrames, 6 * this.rate);
    this.pcm = new Int16Array(this.maxFrames);
    this.length = 0;
    this.total = 0;
    this.sequence = 0;
    this.quietFrames = 0;
    this.ratio = sampleRate / this.rate;
    this.weightLeft = this.ratio;
    this.sum = 0;
    this.budget = Math.max(0, o.budgetBytes || 0);
    this.unacknowledged = new Map();
    this.running = true;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') this.stop('released');
      if (data.type === 'budget') {
        this.budget = Math.max(0, Number(data.bytes) || 0);
        for (const n of this.unacknowledged.keys()) if (n <= data.ack) this.unacknowledged.delete(n);
        if (this.length * 2 + 44 >= this.available()) this.stop('limit');
      }
    };
  }
  available() {
    let bytes = this.budget;
    for (const size of this.unacknowledged.values()) bytes -= size;
    return Math.max(0, bytes);
  }
  emit() {
    if (this.length < 1600) { this.length = 0; return; }
    const samples = this.pcm.slice(0, this.length);
    const sequence = ++this.sequence;
    this.unacknowledged.set(sequence, samples.byteLength + 44);
    this.port.postMessage({ type: 'chunk', sequence, samples: samples.buffer }, [samples.buffer]);
    this.length = 0;
    this.quietFrames = 0;
  }
  stop(reason) {
    if (!this.running) return;
    this.running = false;
    this.emit();
    this.port.postMessage({ type: 'stopped', reason });
  }
  append(sample, quiet) {
    if (this.length * 2 + 46 > this.available()) { this.stop('limit'); return; }
    const value = Math.max(-1, Math.min(1, sample));
    this.pcm[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767));
    this.total++;
    this.quietFrames = quiet ? this.quietFrames + 1 : 0;
    if (this.length >= this.maxFrames || (this.length >= this.minFrames && this.quietFrames >= 5600)) this.emit();
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const frames = channels[0].length;
    let power = 0;
    for (const sample of channels[0]) power += sample * sample;
    const level = Math.sqrt(power / frames);
    for (let i = 0; i < frames && this.running; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      value /= channels.length;
      let weight = 1;
      while (weight > 1e-7 && this.running) {
        const portion = Math.min(weight, this.weightLeft);
        this.sum += value * portion;
        weight -= portion;
        this.weightLeft -= portion;
        if (this.weightLeft < 1e-7) {
          this.append(this.sum / this.ratio, level < 0.008);
          this.sum = 0;
          this.weightLeft = this.ratio;
        }
      }
    }
    if (Math.floor(this.total / 1600) !== this.lastProgress) {
      this.lastProgress = Math.floor(this.total / 1600);
      this.port.postMessage({ type: 'progress', frames: this.total, bufferedBytes: this.length * 2 + 44, level });
    }
    return this.running;
  }
}
registerProcessor('chunk-capture', ChunkCapture);
