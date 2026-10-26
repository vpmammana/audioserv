const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const code = fs.readFileSync('public/assets/capture-worklet.js', 'utf8');
function capture(rate, budget = 4194304, chunkSeconds = 1) {
  let Processor;
  const messages = [];
  class Base { constructor() { this.port = { postMessage: (m) => messages.push(m), onmessage: null }; } }
  vm.runInNewContext(code, { AudioWorkletProcessor: Base, sampleRate: rate, registerProcessor: (_, c) => { Processor = c; }, Int16Array, Math, Map, Number });
  return { processor: new Processor({ processorOptions: { chunkSeconds, budgetBytes: budget } }), messages };
}
for (const rate of [16000, 44100, 48000]) {
  const { processor, messages } = capture(rate);
  const expected = 3.25 * rate;
  for (let i = 0; i < expected; i += 128) {
    const frames = new Float32Array(Math.min(128, expected - i)).fill(.2);
    processor.process([[frames]], [[new Float32Array(frames.length)]]);
  }
  processor.stop('released');
  const chunks = messages.filter((m) => m.type === 'chunk');
  const samples = chunks.reduce((n, c) => n + c.samples.byteLength / 2, 0);
  assert.ok(Math.abs(samples - Math.floor(expected * 16000 / rate)) <= 1, `${rate}: missing samples`);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((c) => c.sequence), [1, 2, 3, 4]);
  assert.equal(messages.at(-1).reason, 'released');
}
const limited = capture(16000, 35000, 10);
for (let i = 0; i < 500; i++) limited.processor.process([[new Float32Array(128).fill(.2)]], [[new Float32Array(128)]]);
assert.equal(limited.messages.at(-1).reason, 'limit');
assert.ok(limited.messages.filter((m) => m.type === 'chunk').reduce((n, c) => n + c.samples.byteLength + 44, 0) <= 35000);
assert.equal(limited.processor.running, false);
const blocked = capture(16000, 70000, 1);
for (let i = 0; i < 1000; i++) blocked.processor.process([[new Float32Array(128).fill(.2)]], [[new Float32Array(128)]]);
assert.equal(blocked.messages.at(-1).reason, 'limit');
assert.ok(blocked.messages.filter((m) => m.type === 'chunk').reduce((n, c) => n + c.samples.byteLength + 44, 0) <= 70000);
console.log('PASS: continuous samples at 16/44.1/48 kHz, independent segments, final partial, hard byte limit, bounded buffering when UI stalls');
