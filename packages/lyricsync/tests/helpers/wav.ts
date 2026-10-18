// packages/lyricsync/tests/helpers/wav.ts
// Builds 16-bit mono PCM WAV bytes from float samples, for tests that need a real audio file.

export function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(data.buffer);
  const tag = (o: number, s: string): void => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return data;
}
