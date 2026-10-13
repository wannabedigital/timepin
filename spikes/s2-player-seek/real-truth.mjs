// Истина для видео с зашитым номером кадра: время показа и ключевые кадры по ffprobe,
// номера кадров читаются с картинки готового файла. Сдвиг считается относительно меток времени исходника.
// Использование: node real-truth.mjs готовый.mp4 исходник.mov частота(числ/знам) выход.truth.json
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
const [, , out, src, rate, dst] = process.argv;
const FF = fs.existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg';
const [num, den = 1] = rate.split('/').map(Number);
const fps = num / den;

const framesJson = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'frame=pts_time,key_frame', '-of', 'json', f], { maxBuffer: 1 << 28 }).toString()).frames
  .map((x) => ({ t: Number(x.pts_time), k: x.key_frame === 1 })).sort((a, b) => a.t - b.t);
const fr = framesJson(out);
const srcPts = src === '-' ? null : framesJson(src).map((x) => x.t);   // '-' — без сравнения с исходником

// номера кадров с картинки: полоса 384x24 в левом верхнем углу, 1 байт на пиксель
const W = 384, H = 24;
const r = spawnSync(FF, ['-v', 'error', '-i', out, '-fps_mode', 'passthrough', '-vf', `crop=${W}:${H}:0:0,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
  { maxBuffer: 1 << 30 });
if (r.status !== 0) throw new Error(String(r.stderr));
const buf = r.stdout, per = W * H, n = buf.length / per;
if (n !== fr.length) throw new Error(`кадров по ffprobe ${fr.length}, по картинке ${n}`);
const nIdx = [];
for (let k = 0; k < n; k++) {
  let v = 0;
  for (let i = 0; i < 16; i++) if (buf[k * per + 12 * W + i * 24 + 12] > 128) v |= 1 << i;
  nIdx.push(v);
}

// сдвиг: разница между временем показа кадра в файле и временем исходного кадра, в кадрах
if (srcPts) {
  let min = Infinity, max = -Infinity, dup = 0, lost = 0, back = 0;
  for (let k = 0; k < n; k++) {
    const d = (fr[k].t - srcPts[nIdx[k]]) * fps;
    if (d < min) min = d;
    if (d > max) max = d;
    if (k > 0) { if (nIdx[k] === nIdx[k - 1]) dup++; if (nIdx[k] < nIdx[k - 1]) back++; }
  }
  const used = new Set(nIdx);
  lost = srcPts.length - used.size;
  console.log(`${out.split('/').pop()}: кадров ${n}, исходных ${srcPts.length}, дубликатов ${dup}, потеряно исходных ${lost}, ` +
    `сдвиг содержимого от ${min.toFixed(2)} до ${max.toFixed(2)} кадра, возвратов номера назад ${back}`);
} else console.log(`${out.split('/').pop()}: кадров ${n}, начало ${fr[0].t.toFixed(4)} с`);

fs.writeFileSync(dst, JSON.stringify({ srcFpsNum: num, srcFpsDen: den, pts: fr.map((x) => x.t), keys: fr.filter((x) => x.k).map((x) => x.t), nIdx }));
