export class WavRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private total = 0;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.ctx.audioWorklet.addModule("/recorder-worklet.js");
    this.node = new AudioWorkletNode(this.ctx, "rec-processor");
    this.node.port.onmessage = (e) => {
      const buf = e.data as Float32Array;
      this.chunks.push(buf);
      this.total += buf.length;
    };
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
  }

  async stop(): Promise<Blob> {
    try {
      this.node?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } finally {
      this.node = null;
      this.ctx = null;
      this.stream = null;
    }
    const merged = new Float32Array(this.total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.chunks = [];
    this.total = 0;
    return new Blob([encodeWav(merged, 16000)], { type: "audio/wav" });
  }
}

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
