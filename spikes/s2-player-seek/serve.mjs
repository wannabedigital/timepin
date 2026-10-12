// Небольшой сервер для S2: страница теста + видео с поддержкой диапазонов байт (Range).
// Запуск: node serve.mjs   (порт 8765, PORT=... переопределяет)
// POST /result сохраняет JSON с результатами в out/results-<время>.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'POST' && url.pathname === '/result') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const file = path.join(root, 'out', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, Buffer.concat(chunks));
      res.end(path.basename(file));
      console.log('результат сохранён:', file);
    });
    return;
  }

  if (url.pathname === '/manifest.json') {
    const names = fs.readdirSync(path.join(root, 'out')).filter((f) => f.endsWith('.truth.json')).map((f) => f.replace('.truth.json', '')).sort();
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(names));
  }

  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('not found'); }

  const size = fs.statSync(file).size;
  res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m) {
    const start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
