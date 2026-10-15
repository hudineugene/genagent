/** Разбор WAV для распознавания голоса из мини-приложения: npx tsx scripts/test-wav.ts */
import { decodeWav } from "@/lib/asr";

function wav(rate: number, channels: number, seconds: number) {
  const frames = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + frames * channels * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + frames * channels * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) buf.writeInt16LE(Math.round(Math.sin(i / 10) * 12000), 44 + (i * channels + c) * 2);
  return new Uint8Array(buf);
}

const stereo = decodeWav(wav(44100, 2, 0.5));
const mono16 = decodeWav(wav(16000, 1, 1));
let bad = false;
try { decodeWav(new Uint8Array(100)); } catch { bad = true; }
const checks = {
  "стерео 44,1 кГц → моно 16 кГц": Math.abs(stereo.length - 8000) <= 2,
  "моно 16 кГц как есть": mono16.length === 16000,
  "уровень сохранён": Math.max(...mono16) > 0.3 && Math.max(...mono16) < 0.4,
  "не WAV — ошибка": bad,
};
console.log(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
