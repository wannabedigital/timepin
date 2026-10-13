// Автоматический прогон S2 в установленных браузерах без участия человека:
// запускает сервер, по очереди открывает страницу теста в каждом найденном браузере с чистым профилем,
// ждёт файл результатов, закрывает браузер, в конце печатает сводку в Markdown и пишет out/summary.md.
//
// Использование:
//   node run-browser-matrix.mjs [--browsers chrome,edge,firefox,safari] [--mode frames|main|both|pausealign]
//                               [--variants имя1,имя2,...] [--timeout-min 30]
// Предусловие: видео созданы (gen-test-videos.sh, make-real-test.sh), в out/ есть *.truth.json.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, browserName } from './summarize-results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const mode = arg('mode', 'frames');
const wantBrowsers = arg('browsers', 'chrome,edge,firefox,safari').split(',');
const timeoutMs = Number(arg('timeout-min', '30')) * 60_000;
const DEFAULT_VARIANTS = 'cfr30-g30,cfr30-g250,cfr60-g60,ntsc2997-g30,iphone6s-cfr,iphone13-cfr,vfrmild30-g30,vfrmildzero30-g30,vfr30-g30';
const variants = arg('variants', DEFAULT_VARIANTS).split(',');
const PORT = 8765;
const base = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- проверка, что видео есть ----
const missing = variants.filter((v) => !fs.existsSync(path.join(outDir, `${v}.truth.json`)));
if (missing.length) {
  console.error(`Нет файлов истины для: ${missing.join(', ')}. Сначала ./gen-test-videos.sh и ./make-real-test.sh`);
  process.exit(2);
}

// ---- поиск браузеров ----
const env = process.env;
const exists = (p) => p && fs.existsSync(p);
function whichOnPath(names) {
  for (const n of names) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}
const pf = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
const found = {};
if (process.platform === 'win32') {
  found.chrome = pf.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(exists);
  found.edge = pf.map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(exists);
  found.firefox = pf.map((d) => path.join(d, 'Mozilla Firefox', 'firefox.exe')).find(exists);
} else if (process.platform === 'darwin') {
  found.chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(exists);
  found.edge = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(exists);
  found.firefox = ['/Applications/Firefox.app/Contents/MacOS/firefox'].find(exists);
  found.safari = exists('/Applications/Safari.app') ? 'safari' : undefined;
} else {
  found.chrome = whichOnPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  found.firefox = whichOnPath(['firefox']);
}
const todo = wantBrowsers.filter((b) => found[b]);
console.log('Найдены браузеры:', Object.entries(found).filter(([, v]) => v).map(([k, v]) => `${k} (${v})`).join('; ') || 'нет');
console.log('Будут прогнаны:', todo.join(', ') || 'ни одного');
if (!todo.length) process.exit(3);

// ---- сервер ----
const server = spawn(process.execPath, ['serve.mjs'], { cwd: here, stdio: 'ignore', env: { ...env, PORT: String(PORT) } });
async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + 'manifest.json')).ok) return; } catch { /* ещё не поднялся */ }
    await sleep(250);
  }
  throw new Error('сервер не поднялся');
}
await waitServer();

const resultFiles = () => fs.readdirSync(outDir).filter((f) => /^results-.*\.json$/.test(f));
const killTree = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
};

// Windows: убить дерево процессов Firefox с данным профилем (pid запускателя уже не существует).
function killByProfile(profile) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*-contentproc*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps]);
}

function urls() {
  const list = variants.join(',');
  const u = [];
  if (mode === 'frames' || mode === 'both') u.push(`${base}?mode=frames&auto=${list}`);
  if (mode === 'main' || mode === 'both') u.push(`${base}?auto=${list}`);
  if (mode === 'pausealign') u.push(`${base}?mode=pausealign&auto=${list}`);
  return u;
}

async function runOne(browser, url) {
  const before = new Set(resultFiles());
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `s2-${browser}-`));
  let child = null, cmd, args;
  if (browser === 'chrome' || browser === 'edge') {
    cmd = found[browser];
    args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--new-window', url];
  } else if (browser === 'firefox') {
    fs.writeFileSync(path.join(profile, 'user.js'),
      'user_pref("media.autoplay.default", 0);\nuser_pref("browser.shell.checkDefaultBrowser", false);\n' +
      'user_pref("browser.startup.homepage_override.mstone", "ignore");\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\n');
    cmd = found.firefox;
    args = ['-no-remote', '-profile', profile, url];
  } else if (browser === 'safari') {
    cmd = 'open'; args = ['-a', 'Safari', url];
  }
  console.log(`\n[${new Date().toLocaleTimeString()}] ${browser}: ${url}`);
  child = spawn(cmd, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  child.on('error', (e) => console.error(`${browser}: не удалось запустить: ${e.message}`));
  const t0 = Date.now();
  let file = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(5000);
    const fresh = resultFiles().filter((f) => !before.has(f));
    if (fresh.length) { file = fresh[0]; break; }
    // На Windows firefox.exe передаёт работу отдельному процессу и выходит с кодом 0: это не конец теста.
    const launcherExit = browser === 'firefox' && process.platform === 'win32';
    if (child.exitCode !== null && browser !== 'safari' && !launcherExit && Date.now() - t0 > 30_000) {
      console.error(`${browser}: процесс завершился без результата (код ${child.exitCode})`);
      break;
    }
  }
  if (browser === 'safari') spawnSync('osascript', ['-e', 'tell application "Safari" to close front window']);
  else {
    killTree(child);
    if (browser === 'firefox' && process.platform === 'win32') killByProfile(profile);
  }
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* профиль занят, пропустить */ }
  if (file) {
    const d = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
    console.log(`  результат: out/${file} (${browserName(d.userAgent)}, ${((Date.now() - t0) / 60000).toFixed(1)} мин)`);
  } else console.error(`  ${browser}: результат не получен за ${(timeoutMs / 60000)} мин`);
  return file;
}

const got = [];
try {
  for (const b of todo) for (const u of urls()) { const f = await runOne(b, u); if (f) got.push(path.join(outDir, f)); }
} finally {
  killTree(server);
}
const md = got.length ? summarize(got) : 'Результатов нет.';
fs.writeFileSync(path.join(outDir, 'summary.md'), md);
console.log('\n' + md + '\n\nСводка записана в out/summary.md');
