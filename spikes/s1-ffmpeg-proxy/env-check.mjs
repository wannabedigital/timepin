// Проверка окружения для спайков: что установлено и чем располагает сборка FFmpeg.
// Запуск на любой ОС: node env-check.mjs
// Результат вставить в docs/04-spikes.md (S1, проверка на новой ОС).
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.error ? null : (r.stdout + r.stderr);
};

console.log(`ОС: ${os.type()} ${os.release()} (${os.arch()}), ядер: ${os.cpus().length}, ${os.cpus()[0].model}`);
console.log(`Node.js: ${process.version}`);

const ver = run('ffmpeg', ['-hide_banner', '-version']);
if (!ver) { console.log('ffmpeg: НЕ НАЙДЕН в PATH'); process.exit(1); }
console.log('ffmpeg:', ver.split('\n')[0]);
console.log('ffprobe:', (run('ffprobe', ['-hide_banner', '-version']) ?? 'НЕ НАЙДЕН').split('\n')[0]);
const conf = (ver.match(/configuration: (.*)/) ?? [])[1] ?? '';
console.log('GPL-сборка:', /--enable-gpl/.test(conf) ? 'да (--enable-gpl)' : 'нет');

const check = (label, out, names) => {
  for (const n of names) {
    const re = new RegExp(`\\s${n}\\s`);
    console.log(`${label} ${n.padEnd(20)}`, re.test(out) ? 'есть' : 'нет');
  }
};
check('кодер ', run('ffmpeg', ['-hide_banner', '-encoders']) ?? '',
  ['libx264', 'libx265', 'aac', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']);
check('фильтр', run('ffmpeg', ['-hide_banner', '-filters']) ?? '',
  ['zscale', 'tonemap', 'drawtext', 'libvmaf', 'libplacebo', 'geq']);
console.log('Обязательно для S1: libx264, aac. Для HDR: zscale. Для S2: drawtext или geq. Для качества: libvmaf.');
