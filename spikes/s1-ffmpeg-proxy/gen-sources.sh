#!/usr/bin/env bash
# Генерирует синтетические исходники для S1 (docs/04-spikes.md).
# Синтетика сжимается иначе, чем реальная съёмка: цифры времени и размера
# по ней не переносятся на реальные видео, нужен ещё реальный исходник.
set -euo pipefail
cd "$(dirname "$0")/media"

# 1. Главный исходник: 10 минут (предел D-005), 1080p, 30 к/с, звук.
ffmpeg -hide_banner -y -loglevel error \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=600" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=600" \
  -c:v libx264 -preset veryfast -crf 18 -g 60 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest src-1080p30-10min.mp4

# 2. Нецелая частота кадров 23.976 (кино), 1 минута.
ffmpeg -hide_banner -y -loglevel error \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24000/1001:duration=60" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest src-1080p23976-1min.mp4

# 3. Переменная частота кадров (как у съёмки на телефон): из 30 к/с
#    нерегулярно выбрасываются кадры, исходные метки времени сохраняются.
ffmpeg -hide_banner -y -loglevel error \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=60" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=60" \
  -vf "select='not(mod(n\,7))+lt(mod(n\,5)\,3)'" -fps_mode vfr \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest src-vfr-1min.mp4

# 4. 4K, HEVC 10 бит (типичный файл с современной камеры или iPhone), 1 минута.
# На macOS используется аппаратный кодер, на остальных ОС программный libx265.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_videotoolbox; then
  HEVC=(-c:v hevc_videotoolbox -profile:v main10 -pix_fmt p010le -b:v 40M -tag:v hvc1)
else
  HEVC=(-c:v libx265 -preset veryfast -crf 20 -pix_fmt yuv420p10le -tag:v hvc1)
fi
ffmpeg -hide_banner -y -loglevel error \
  -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=60" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=60" \
  "${HEVC[@]}" \
  -c:a aac -b:a 192k -shortest src-4k-hevc10-1min.mov

ls -lh
