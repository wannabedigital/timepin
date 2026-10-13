#!/usr/bin/env bash
# Тестовые видео для S2 (docs/04-spikes.md): в каждый кадр зашит его номер двоичным кодом
# (16 блоков 24x24 px в левом верхнем углу), страница читает номер сама и сравнивает с ожидаемым.
# Рядом с каждым видео создаётся <имя>.truth.json: время показа и ключевые кадры по ffprobe.
# Использование: ./gen-test-videos.sh   (нужен ffmpeg; для текста с номером кадра — со сборкой drawtext)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out

# Сборка с drawtext (ffmpeg-full на macOS); иначе ffmpeg из PATH. Переменная FFMPEG_FULL переопределяет.
FF=${FFMPEG_FULL:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}
[ -x "$FF" ] || FF=ffmpeg
DUR=120; SIZE=1280x720

# Шрифт для читаемого номера кадра (необязателен: номер читается и по блокам).
FONT=""
case "$(uname -s)" in
  Darwin) [ -f /System/Library/Fonts/Supplemental/Arial.ttf ] && FONT="/System/Library/Fonts/Supplemental/Arial.ttf" ;;
  MINGW*|MSYS*|CYGWIN*) [ -f /c/Windows/Fonts/arial.ttf ] && FONT="C\\:/Windows/Fonts/arial.ttf" ;;
  Linux) FONT=$(fc-match -f '%{file}' sans 2>/dev/null || true) ;;
esac
# Если drawtext падает (например, из-за пути к шрифту на Windows), запустить с NO_TEXT=1: номер читается и по блокам.
[ "${NO_TEXT:-0}" = 1 ] && FONT=""
HAS_DRAWTEXT=0
"$FF" -hide_banner -filters 2>/dev/null | grep -q " drawtext " && HAS_DRAWTEXT=1

BITS="drawbox=x=0:y=0:w=384:h=24:color=black:t=fill"
for i in $(seq 0 15); do
  BITS+=",drawbox=x=$((24*i)):y=0:w=24:h=24:color=white:t=fill:enable='mod(floor(n/$((1<<i))),2)'"
done
TEXT=""
if [ -n "$FONT" ] && [ $HAS_DRAWTEXT = 1 ]; then
  TEXT=",drawtext=fontfile='$FONT':text='%{frame_num}':start_number=0:x=400:y=0:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7"
fi

# make имя частота интервал_ключевых_кадров [vfr|mild|filled]
#   vfr  — сильно неравномерно выбрасываем кадры (треть и более), метки времени исходные
#   mild — выбрасываем каждый 60-й кадр (слабая переменная частота, как у iPhone)
#   filled — как vfr, но пропуски заполнены повтором кадра (постоянная частота, одним проходом)
#   mildzero — как mild, но начало файла приведено к нулю (start_time=0)
make() {
  local name=$1 rate=$2 gop=$3 vfr=${4:-}
  local vf="$BITS$TEXT" extra=()
  if [ "$vfr" = vfr ]; then
    vf="$vf,select='not(mod(n\,7))+lt(mod(n\,5)\,3)'"; extra=(-fps_mode vfr)
  elif [ "$vfr" = mild ]; then
    vf="$vf,select='mod(n\,60)'"; extra=(-fps_mode vfr)
  elif [ "$vfr" = mildzero ]; then
    # Как mild, но начало приведено к нулю (первый кадр отброшен фильтром, поэтому без сдвига он был бы 1/30 с).
    vf="$vf,select='mod(n\,60)',setpts=PTS-STARTPTS"; extra=(-fps_mode vfr)
  elif [ "$vfr" = filled ]; then
    # Те же пропуски, но заполненные повтором предыдущего кадра в той же цепочке (постоянная частота).
    vf="$vf,select='not(mod(n\,7))+lt(mod(n\,5)\,3)',fps=30"; extra=(-fps_mode cfr)
  fi
  echo "== $name"
  "$FF" -hide_banner -y -loglevel error -f lavfi -i "testsrc2=size=$SIZE:rate=$rate:duration=$DUR" \
    -vf "$vf" ${extra[@]+"${extra[@]}"} -c:v libx264 -preset veryfast -crf 18 -g "$gop" -keyint_min "$gop" \
    -sc_threshold 0 -pix_fmt yuv420p -an -movflags +faststart "out/$name.mp4"
  # Истина: время показа каждого кадра и ключевые кадры (отсортированы по времени показа).
  ffprobe -v error -select_streams v:0 -show_entries frame=pts_time,key_frame -of json "out/$name.mp4" |
    node -e '
const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
const fr=j.frames.map(f=>({t:Number(f.pts_time),k:f.key_frame===1})).sort((a,b)=>a.t-b.t);
const [num,den]=process.argv[1].split("/").map(Number);
console.log(JSON.stringify({srcFpsNum:num,srcFpsDen:den||1,pts:fr.map(f=>f.t),keys:fr.filter(f=>f.k).map(f=>f.t)}));
' "$rate" > "out/$name.truth.json"
  echo "   кадров: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).pts.length)' "out/$name.truth.json"), $(du -h "out/$name.mp4" | cut -f1)"
}

# Выбор вариантов: ONLY=vfrmild30-g30,vfr2cfr30-g30 ./gen-test-videos.sh
want() { [ -z "${ONLY:-}" ] || [[ ",$ONLY," == *",$1,"* ]]; }

want cfr30-g30    && make cfr30-g30     30/1        30
want cfr30-g250   && make cfr30-g250    30/1        250
want cfr30-g1     && make cfr30-g1      30/1        1
want ntsc2997-g30 && make ntsc2997-g30  30000/1001  30
want vfr30-g30    && make vfr30-g30     30/1        30  vfr
want vfrmild30-g30 && make vfrmild30-g30 30/1       30  mild
want cfr60-g60     && make cfr60-g60      60/1        60
want pal25-g25     && make pal25-g25      25/1        25
want film23976-g24 && make film23976-g24  24000/1001  24

want vfrfilled30-g30 && make vfrfilled30-g30 30/1 30 filled

# Начало файла приведено к нулю (setpts=PTS-STARTPTS). Номера кадров в файле смещены относительно времени,
# поэтому истина (номера) читается с картинки готового файла.
if want vfrmildzero30-g30; then
  make vfrmildzero30-g30 30/1 30 mildzero
  node real-truth.mjs out/vfrmildzero30-g30.mp4 - 30/1 out/vfrmildzero30-g30.truth.json
fi

# Для заполненного варианта номер на дубликатах — номер последнего исходного кадра (берём из истины vfr30-g30).
if want vfrfilled30-g30; then
  node -e '
const fs=require("fs");
const t=JSON.parse(fs.readFileSync("out/vfrfilled30-g30.truth.json","utf8"));
const src=JSON.parse(fs.readFileSync("out/vfr30-g30.truth.json","utf8")).pts;
let j=0; t.nIdx=t.pts.map(x=>{ while(j+1<src.length && src[j+1]<=x+1e-4) j++; return Math.round(src[j]*30); });
fs.writeFileSync("out/vfrfilled30-g30.truth.json", JSON.stringify(t));'
fi
ls -lh out/*.mp4
