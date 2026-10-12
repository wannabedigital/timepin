#!/usr/bin/env bash
# Прокси из реального исходника и оценка качества VMAF.
# Использование: ./make-proxies-real.sh media/real-....mp4   (нужны ffmpeg с libvmaf и node)
# Аппаратный кодер VideoToolbox есть только на macOS: на других ОС этот вариант пропускается.
# Результат: out/real-results.csv (вариант, время, размер, VMAF среднее и 1-й процентиль)
set -euo pipefail
cd "$(dirname "$0")"
SRC=$1
BASE=$(basename "${SRC%.*}")
CSV=out/real-results.csv
[ -f "$CSV" ] || echo "source,variant,encode_s,size_mb,vmaf_mean,vmaf_p1,audio" > "$CSV"
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$SRC")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SRC")

now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

run() { # имя, аргументы видео...
  local name=$1; shift
  local out="out/$BASE--$name.mp4" t0 t1
  t0=$(now)
  # Явно: первая видеодорожка, первая звуковая, стерео. Без -map FFmpeg сам
  # выбирает звуковую дорожку с наибольшим числом каналов.
  ffmpeg -hide_banner -y -loglevel error -i "$SRC" -map 0:v:0 -map 0:a:0? \
    "$@" -c:a aac -b:a 128k -ac 2 -movflags +faststart "$out"
  t1=$(now)
  local dt mb vm
  dt=$(awk "BEGIN{printf \"%.1f\", $t1-$t0}")
  mb=$(awk "BEGIN{printf \"%.1f\", $(wc -c < "$out" | tr -d ' ')/1048576}")
  # VMAF: прокси масштабируется обратно до размера исходника, каждый 5-й кадр.
  ffmpeg -hide_banner -loglevel error -i "$out" -i "$SRC" -lavfi \
    "[0:v]scale=${W}:${H}:flags=bicubic,setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf=n_subsample=5:n_threads=10:log_fmt=json:log_path=out/vmaf.json" \
    -f null -
  vm=$(node -e '
const d=JSON.parse(require("fs").readFileSync("out/vmaf.json","utf8"));
const v=d.frames.map(f=>f.metrics.vmaf).sort((a,b)=>a-b);
const mean=v.reduce((a,b)=>a+b,0)/v.length;
console.log(mean.toFixed(1)+","+v[Math.max(0,Math.floor(v.length*0.01)-1)].toFixed(1));')
  local ach; ach=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,channels -of csv=p=0 "$out" | tr ',' ' ')
  echo "$BASE,$name,$dt,$mb,$vm,$ach" >> "$CSV"
  echo "$name: ${dt} s, ${mb} MB, VMAF(mean,p1)=${vm}, audio=${ach}"
}

X=(-c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p)
run x264-720p-crf23-g1s   -vf scale=-2:720 "${X[@]}" -crf 23 -g 30
run x264-720p-crf26-g1s   -vf scale=-2:720 "${X[@]}" -crf 26 -g 30
run x264-720p-crf23-gdef  -vf scale=-2:720 "${X[@]}" -crf 23
run x264-1080p-crf23-g1s                   "${X[@]}" -crf 23 -g 30
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  run vt-720p-2500k-g1s     -vf scale=-2:720 -c:v h264_videotoolbox -b:v 2500k -g 30 -profile:v high -pix_fmt yuv420p
fi
