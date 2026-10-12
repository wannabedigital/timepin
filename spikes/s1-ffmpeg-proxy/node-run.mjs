// Запуск FFmpeg из Node.js, как это будет в main-процессе Electron.
// Проверяет: прогресс в процентах, мягкую отмену ('q'), жёсткую отмену (SIGKILL), ошибку.
// Использование: node node-run.mjs progress|cancel-soft|cancel-hard|error
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync, rmSync, mkdirSync } from 'node:fs';

mkdirSync('out', { recursive: true });

const SRC = 'media/src-1080p30-10min.mp4';
const mode = process.argv[2] ?? 'progress';

function durationSec(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file]).toString();
  return parseFloat(out);
}

function makeProxy(src, dst, onProgress) {
  const args = ['-hide_banner', '-y', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
    '-i', src, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const total = existsSync(src) ? durationSec(src) : NaN;
  let buf = '', stderr = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const [k, v] = line.split('=');
      // Ключи out_time_us и out_time_ms оба в микросекундах — проверяем это здесь.
      if (k === 'out_time_us' || k === 'out_time_ms') onProgress({ key: k, raw: Number(v), total });
      if (k === 'progress' && v === 'end') onProgress({ key: 'end' });
    }
  });
  proc.stderr.on('data', (c) => { stderr += c; });
  const done = new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal, stderr })));
  return { proc, done };
}

const dst = `out/node-${mode}.mp4`;
if (existsSync(dst)) rmSync(dst);
let lastPct = -10, seen = {};
const t0 = Date.now();
const { proc, done } = makeProxy(mode === 'error' ? 'media/no-such-file.mp4' : SRC, dst, (p) => {
  if (p.key === 'end') return console.log('progress=end');
  seen[p.key] = p.raw;
  if (p.key !== 'out_time_us') return;
  const pct = Math.floor((p.raw / 1e6 / p.total) * 100);
  if (pct >= lastPct + 10) { lastPct = pct; console.log(`${pct}%  (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
});

if (mode === 'cancel-soft') setTimeout(() => { console.log('-> отправляю q'); proc.stdin.write('q'); }, 5000);
if (mode === 'cancel-hard') setTimeout(() => { console.log('-> SIGKILL'); proc.kill('SIGKILL'); }, 5000);

const r = await done;
console.log(`exit code=${r.code} signal=${r.signal} time=${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`out_time_us=${seen.out_time_us} out_time_ms=${seen.out_time_ms} (одинаковые единицы?)`);
if (r.stderr.trim()) console.log('stderr:', r.stderr.trim().split('\n').slice(-2).join(' | '));
if (existsSync(dst)) {
  console.log(`файл: ${(statSync(dst).size / 1048576).toFixed(1)} MB`);
  try {
    const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst]).toString().trim();
    console.log(`ffprobe читает файл, длительность ${d} s`);
  } catch { console.log('ffprobe не может прочитать файл (битый)'); }
} else console.log('файла нет');
