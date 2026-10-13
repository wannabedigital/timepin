// Сводка результатов S2 в виде таблиц Markdown: по одному блоку на браузер.
// Использование: node summarize-results.mjs [файл ...]   (по умолчанию все out/results-*.json)
// Если один браузер прогонялся несколько раз, берётся последний результат по каждому видео.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function browserName(ua) {
  if (/Edg\//.test(ua)) return 'Edge ' + (ua.match(/Edg\/([\d.]+)/) ?? [])[1];
  if (/Firefox\//.test(ua)) return 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/) ?? [])[1];
  if (/Electron\//.test(ua)) return 'Electron ' + (ua.match(/Electron\/([\d.]+)/) ?? [])[1];
  if (/Chrome\//.test(ua)) return 'Chromium/Chrome ' + (ua.match(/Chrome\/([\d.]+)/) ?? [])[1];
  if (/Safari\//.test(ua)) return 'Safari ' + (ua.match(/Version\/([\d.]+)/) ?? [])[1];
  return ua.slice(0, 40);
}
const osName = (ua, platform) => (/Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : platform);

export function summarize(files) {
  const byBrowser = new Map();
  for (const f of files.sort()) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const key = `${browserName(d.userAgent)} (${osName(d.userAgent, d.platform)})`;
    const rec = byBrowser.get(key) ?? { rvfc: d.requestVideoFrameCallback, frames: new Map(), main: new Map(), pa: new Map() };
    rec.rvfc = d.requestVideoFrameCallback;
    for (const r of d.results) (d.kind === 'frames' ? rec.frames : d.kind === 'pausealign' ? rec.pa : rec.main).set(r.variant, r);
    byBrowser.set(key, rec);
  }
  const out = [];
  const M = ['ms-round', 'ms-floor', 'ms-ceil', 'frame-start', 'frame-mid'];
  for (const [name, rec] of byBrowser) {
    out.push(`### ${name}`, '', `requestVideoFrameCallback: ${rec.rvfc ? 'есть' : 'нет'}`, '');
    if (rec.frames.size) {
      out.push('Способы хранить момент (верно из 123), шаг на кадр, пауза:', '',
        '| Видео | к/с | мс до ближайшей | мс вниз | мс вверх | начало кадра | середина кадра | шаг впер. / назад | пауза mediaTime | пауза currentTime (вниз / ближайшей) |',
        '|---|---|---|---|---|---|---|---|---|---|');
      for (const r of [...rec.frames.values()].sort((a, b) => a.variant.localeCompare(b.variant))) {
        const s = (m) => `${r.seek[m].ok}`;
        const p = r.pause;
        out.push(`| ${r.variant} | ${r.fps.toFixed(3)} | ${M.slice(0, 3).map(s).join(' | ')} | ${s('frame-start')} | **${s('frame-mid')}** | ` +
          `${r.step.fwdOk}/${r.step.total} · ${r.step.backOk}/${r.step.total} | ` +
          `${p.error ? 'play: ' + p.error : p.noMeta === p.trials ? 'нет meta' : `${p.byMediaTimeRound}/${p.trials}`} | ${p.byCurrentTimeFloor ?? 0} / ${p.byCurrentTimeRound ?? 0} |`);
      }
      out.push('');
    }
    if (rec.pa.size) {
      out.push('Пауза с выравниванием (вариант A): совпало с сохранённым номером, сдвиг при выравнивании в кадрах (число случаев):', '',
        '| Видео | к/с | совпало | нет mediaTime | сдвиг, кадров: случаи | макс. сдвиг |', '|---|---|---|---|---|---|');
      for (const r of [...rec.pa.values()].sort((a, b) => a.variant.localeCompare(b.variant))) {
        const j = Object.entries(r.jump).sort((a, b) => a[0] - b[0]).map(([k, c]) => `${k > 0 ? '+' : ''}${k}: ${c}`).join(', ');
        out.push(`| ${r.variant} | ${r.fps.toFixed(3)} | ${r.alignedOk}/${r.trials}${r.playFailed ? ' (play: ' + r.playFailed + ')' : ''} | ${r.noMeta} | ${j} | ${r.jumpAbsMax} |`);
      }
      out.push('');
    }
    if (rec.main.size) {
      out.push('Перемотка, задержка и шаг (основной тест):', '',
        '| Видео | к/с | точно из 123 | макс. ошибка, кадров | задержка med, мс | шаг +1/fps | шаг pts | шаг mid | воспр. несовп. |', '|---|---|---|---|---|---|---|---|---|');
      for (const r of [...rec.main.values()].sort((a, b) => a.variant.localeCompare(b.variant))) {
        out.push(`| ${r.variant} | ${r.fps.toFixed(3)} | ${r.seeks.exact} | ${r.seeks.maxAbsErr} | ${r.seeks.latencyMedian.toFixed(0)} | ` +
          `${r.step['plus-1/fps']} | ${r.step['pts-next']} | ${r.step['pts-mid']} | ${r.play.mismatches}/${r.play.frames} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('summarize-results.mjs')) {
  const dir = path.join(here, 'out');
  const files = process.argv.length > 2 ? process.argv.slice(2)
    : fs.readdirSync(dir).filter((f) => f.startsWith('results-') && f.endsWith('.json')).map((f) => path.join(dir, f));
  console.log(summarize(files));
}
