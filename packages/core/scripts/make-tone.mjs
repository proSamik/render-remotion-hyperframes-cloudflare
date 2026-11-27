#!/usr/bin/env node
/**
 * Writes a test sound as a WAV file, so no audio file has to live in the repository.
 *   node make-tone.mjs <out.wav> [seconds=10]
 * A steady 220 Hz tone with a short 880 Hz beep at the start of every second. The steady tone makes a bad join
 * audible (a click or a gap); the beeps line up with the flash in the example compositions, which shows A/V sync.
 * Both frequencies complete whole cycles per second, so the file loops without a click.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [out = 'tone.wav', secondsText = '10'] = process.argv.slice(2);
const rate = 48000;
const seconds = Number(secondsText);
const samples = rate * seconds;
const data = Buffer.alloc(samples * 2);
for (let index = 0; index < samples; index += 1) {
  const t = index / rate;
  const inSecond = t % 1;
  const beep = inSecond < 0.08 ? Math.sin(2 * Math.PI * 880 * t) * 0.5 * Math.min(1, inSecond / 0.005, (0.08 - inSecond) / 0.005) : 0;
  const tone = Math.sin(2 * Math.PI * 220 * t) * 0.12;
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tone + beep)) * 32767), index * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), Buffer.concat([header, data]));
console.log(`${out}: ${seconds} s, ${rate} Hz mono`);
