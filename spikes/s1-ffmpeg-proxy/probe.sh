#!/usr/bin/env bash
# Краткие сведения о видео через ffprobe: кодек, размер, частоты кадров,
# число кадров и ключевых кадров, длительность, признак VFR.
# Использование: ./probe.sh файл [файл ...]
set -euo pipefail
printf "%-34s %-5s %-11s %-9s %-11s %-11s %6s %5s %9s %8s %s\n" \
  file codec pix_fmt size r_fps avg_fps frames keys dur_s MB vfr
for f in "$@"; do
  read -r codec w h pix rfr afr < <(ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate \
    -of csv=p=0 "$f" | tr ',' ' ')
  frames=$(ffprobe -v error -select_streams v:0 -count_packets \
    -show_entries stream=nb_read_packets -of csv=p=0 "$f")
  keys=$(ffprobe -v error -select_streams v:0 -show_entries packet=flags \
    -of csv=p=0 "$f" | grep -c K || true)
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  mb=$(awk "BEGIN{printf \"%.1f\", $(wc -c < "$f" | tr -d ' ')/1048576}")
  # VFR: разброс длительностей кадров больше 1 мс
  vfr=$(ffprobe -v error -select_streams v:0 -show_entries packet=duration_time \
    -of csv=p=0 "$f" | sort -u | awk 'NF{n++; if(min==""||$1<min)min=$1; if($1>max)max=$1}
      END{print ((max-min)>0.001 ? "yes" : "no")}')
  printf "%-34s %-5s %-11s %-9s %-11s %-11s %6s %5s %9.3f %8s %s\n" \
    "$(basename "$f")" "$codec" "$pix" "${w}x${h}" "$rfr" "$afr" "$frames" "$keys" "$dur" "$mb" "$vfr"
done
