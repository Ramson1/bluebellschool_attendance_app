// Generates assets/beep.wav — a short, LOUD two-tone confirmation chirp
// played by the attendance app after every successful scan (see src/lib/sound.ts).
// Run: node scripts/gen-sounds.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'assets', 'beep.wav');

const RATE = 22050; // 16-bit mono PCM sample rate
const TOTAL = 0.42; // seconds: 880Hz blip, tiny gap, higher 1318Hz blip
const N = Math.round(RATE * TOTAL);
const pcm = Buffer.alloc(N * 2);

// Two-tone square-ish (soft-clipped sine) at full scale so it is clearly
// audible at a noisy school gate.
const tones = [
  { f: 880, a: 0, b: 0.16 },
  { f: 1318, a: 0.2, b: 0.42 },
];
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  let s = 0;
  for (const { f, a, b } of tones) {
    if (t >= a && t <= b) {
      const env = Math.min(1, (b - t) / 0.03) * Math.min(1, (t - a) / 0.008);
      const v = Math.sin(2 * Math.PI * f * t);
      s += env * Math.sign(v) * Math.min(1, Math.abs(v) * 2.5); // hard-ish clip = loud
    }
  }
  const clamp = Math.max(-1, Math.min(1, s));
  pcm.writeInt16LE(Math.round(clamp * 32767 * 0.95), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // format = PCM
header.writeUInt16LE(1, 22); // channels = mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`wrote ${out} (${(pcm.length + 44) / 1024} KB)`);
