#!/usr/bin/env bash
# Сравнение способов перевода HDR (HLG/PQ) в SDR с эталоном Apple (avconvert, только macOS).
# Нужен ffmpeg-full (фильтр zscale): brew install ffmpeg-full
# Использование: ./hdr-compare.sh media/real-iphone13pro-4k-dv-hlg-60.mov
set -euo pipefail
cd "$(dirname "$0")"
SRC=$1; mkdir -p out/hdr
# Путь к ffmpeg с фильтром zscale: переменная FFMPEG_FULL или ffmpeg-full из Homebrew, иначе ffmpeg из PATH.
FFULL=${FFMPEG_FULL:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}
[ -x "$FFULL" ] || FFULL=ffmpeg
HAVE_REF=0
if command -v avconvert >/dev/null 2>&1; then   # эталон есть только на macOS
  avconvert -s "$SRC" -p Preset1280x720 -o out/hdr/apple-ref.mp4 --replace >/dev/null && HAVE_REF=1
fi
# Масштабирование до 720p стоит ПЕРЕД переводом цвета: так цвет считается на 720p, а не на 4K (в 2 раза быстрее).
TM() { echo "scale=-2:720,zscale=t=linear:npl=$1,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=$2:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"; }
VARIANTS=(
  "naive|scale=-2:720"
  "zscale-direct|zscale=t=bt709:p=bt709:m=bt709:r=tv:npl=100,format=yuv420p,scale=-2:720"
  "mobius|$(TM 100 mobius)"
  "hable-npl100|$(TM 100 hable)"
  "hable-npl200|$(TM 200 hable)"
)
stat_avg() { ffmpeg -hide_banner -i "$1" -vf "select='between(t,2,18)',signalstats,metadata=print:key=lavfi.signalstats.$2:file=-" -f null - 2>/dev/null | awk -F= -v k=$2 '$0~k{s+=$2;n++} END{printf "%.1f", s/n}'; }
for v in "${VARIANTS[@]}"; do
  k=${v%%|*}; vf=${v#*|}; f=out/hdr/$k.mp4
  $FFULL -hide_banner -y -loglevel error -i "$SRC" -map 0:v:0 -vf "$vf" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -an "$f"
  ss="(нет эталона)"
  if [ $HAVE_REF = 1 ]; then
    ss=$(ffmpeg -hide_banner -i "$f" -i out/hdr/apple-ref.mp4 -lavfi '[0:v]trim=2:18,setpts=PTS-STARTPTS[a];[1:v]trim=2:18,setpts=PTS-STARTPTS[b];[a][b]ssim' -f null - 2>&1 | grep -o 'All:[0-9.]*')
  fi
  echo "$k: SATAVG=$(stat_avg "$f" SATAVG) YAVG=$(stat_avg "$f" YAVG) SSIM $ss"
done
[ $HAVE_REF = 1 ] && echo "apple-ref: SATAVG=$(stat_avg out/hdr/apple-ref.mp4 SATAVG) YAVG=$(stat_avg out/hdr/apple-ref.mp4 YAVG)" || true
