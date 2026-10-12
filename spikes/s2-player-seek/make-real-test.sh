#!/usr/bin/env bash
# Проверка на РЕАЛЬНЫХ роликах iPhone (S2, docs/04-spikes.md): в картинку зашивается номер исходного кадра,
# затем делаются два прокси: с сохранением переменных меток времени (vfr) и приведённый к постоянной
# номинальной частоте одним проходом (cfr). Истина считается по содержимому готового файла: номер кадра
# читается с картинки каждого кадра. Дополнительно печатается сдвиг содержимого относительно исходной шкалы.
# Использование: ./make-real-test.sh   (клипы берутся из ../s1-ffmpeg-proxy/media/)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
FF=${FFMPEG_FULL:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}
[ -x "$FF" ] || FF=ffmpeg
M=../s1-ffmpeg-proxy/media

BITS="drawbox=x=0:y=0:w=384:h=24:color=black:t=fill"
for i in $(seq 0 15); do
  BITS+=",drawbox=x=$((24*i)):y=0:w=24:h=24:color=white:t=fill:enable='mod(floor(n/$((1<<i))),2)'"
done
HDR="zscale=t=linear:npl=200,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"

# имя исходник цепочка_приведения номинальная_частота(числ/знам) gop
build() {
  local name=$1 src=$2 pre=$3 nominal=$4 gop=$5
  echo "== $name-vfr / $name-cfr"
  "$FF" -hide_banner -y -loglevel error -i "$src" -map 0:v:0 -vf "$pre,$BITS" -fps_mode passthrough \
    -c:v libx264 -preset veryfast -crf 18 -g "$gop" -keyint_min "$gop" -sc_threshold 0 -pix_fmt yuv420p -an \
    -movflags +faststart "out/$name-vfr.mp4"
  "$FF" -hide_banner -y -loglevel error -i "$src" -map 0:v:0 -vf "$pre,$BITS,fps=$nominal" -fps_mode cfr \
    -c:v libx264 -preset veryfast -crf 18 -g "$gop" -keyint_min "$gop" -sc_threshold 0 -pix_fmt yuv420p -an \
    -movflags +faststart "out/$name-cfr.mp4"
  for v in vfr cfr; do node real-truth.mjs "out/$name-$v.mp4" "$src" "$nominal" "out/$name-$v.truth.json"; done
}

build iphone6s  "$M/real-iphone6s-4k-h264-2997.mov"   "scale=1280:720"        30000/1001 30
build iphone13  "$M/real-iphone13pro-4k-dv-hlg-60.mov" "scale=1280:720,$HDR"  60/1       60
