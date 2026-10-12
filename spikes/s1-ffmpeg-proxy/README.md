# S1. FFmpeg: создание прокси

Одноразовая проверка, код не переносится в продукт. Результаты и выводы — в `docs/04-spikes.md`, раздел S1.

Требуется: FFmpeg и ffprobe (Homebrew: `brew install ffmpeg`), Node.js.

| Файл | Что делает |
|---|---|
| `gen-sources.sh` | Генерирует синтетические исходники в `media/` (около 1 ГБ, ~1 мин) |
| `probe.sh` | Сводка по видео: кодек, размер кадра, частоты кадров, число кадров и ключевых кадров, длительность, признак VFR |
| `make-proxies.sh` | Делает варианты прокси в `out/`, время пишет в `out/timings.csv` |
| `make-proxies-real.sh` | Прокси из реального исходника + качество VMAF: `./make-proxies-real.sh media/real-....mp4`, результаты в `out/real-results.csv` |
| `hdr-compare.sh` | Сравнение способов перевода HDR в SDR с эталоном Apple; нужен `ffmpeg-full` |
| `node-run.mjs` | Запуск FFmpeg из Node.js: `progress`, `cancel-soft`, `cancel-hard`, `error` |

Порядок запуска:

```bash
./gen-sources.sh
./make-proxies.sh
./probe.sh media/* out/*.mp4
node node-run.mjs progress
```

Папки `media/` и `out/` не хранятся в репозитории (`spikes/.gitignore`).
