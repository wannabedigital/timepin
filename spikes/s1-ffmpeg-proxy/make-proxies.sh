#!/usr/bin/env bash
# Создаёт варианты прокси и записывает время в out/timings.csv.
# Общие параметры для всех вариантов (совместимость с браузерами):
#   H.264 High, yuv420p (8 бит), AAC 128k, MP4 с faststart.
set -euo pipefail
cd "$(dirname "$0")"
SRC=media/src-1080p30-10min.mp4
CSV=out/timings.csv
echo "variant,source,seconds" > "$CSV"

COMMON_A=(-c:a aac -b:a 128k -movflags +faststart)

run() { # имя, исходник, аргументы видео...
  local name=$1 src=$2; shift 2
  local t0 t1
  t0=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  ffmpeg -hide_banner -y -loglevel error -i "$src" "$@" "${COMMON_A[@]}" "out/$name.mp4"
  t1=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  local dt; dt=$(awk "BEGIN{printf \"%.1f\", $t1-$t0}")
  echo "$name,$(basename "$src"),$dt" >> "$CSV"
  echo "$name: ${dt} s"
}

# Ключевой кадр каждую секунду (g=30 при 30 к/с) — для точной перемотки (S2).
run A-x264-720p-g1s   "$SRC" -vf scale=-2:720  -c:v libx264 -preset veryfast -crf 23 -g 30 -profile:v high -pix_fmt yuv420p
run B-x264-1080p-g1s  "$SRC"                   -c:v libx264 -preset veryfast -crf 23 -g 30 -profile:v high -pix_fmt yuv420p
run C-vt-720p-g1s     "$SRC" -vf scale=-2:720  -c:v h264_videotoolbox -b:v 2500k -g 30 -profile:v high -pix_fmt yuv420p
run D-vt-1080p-g1s    "$SRC"                   -c:v h264_videotoolbox -b:v 5000k -g 30 -profile:v high -pix_fmt yuv420p
# Ключевые кадры по умолчанию x264 (до 250 кадров) — чтобы увидеть цену частых ключевых кадров.
run E-x264-720p-gdef  "$SRC" -vf scale=-2:720  -c:v libx264 -preset veryfast -crf 23 -profile:v high -pix_fmt yuv420p

# Особые исходники с вариантом A (частота кадров берётся из исходника).
G=(-c:v libx264 -preset veryfast -crf 23 -profile:v high -pix_fmt yuv420p)
run F-23976-720p      media/src-1080p23976-1min.mp4 -vf scale=-2:720 "${G[@]}" -g 24
run G-vfr-passthrough media/src-vfr-1min.mp4        -vf scale=-2:720 "${G[@]}" -g 30 -fps_mode passthrough
run H-vfr-to-cfr30    media/src-vfr-1min.mp4        -vf scale=-2:720 "${G[@]}" -g 30 -fps_mode cfr -r 30
run I-4k-hevc10-720p  media/src-4k-hevc10-1min.mov  -vf scale=-2:720 "${G[@]}" -g 30
