#!/usr/bin/env bash
# Полный прогон оставшихся проверок S1 и S2 на новой ОС (Windows) без участия человека.
# Запускать из Git Bash в корне репозитория:  ./spikes/run-windows-checks.sh
# Всё пишется в spikes/_run-logs/ (в git не попадает). Код выхода 0 — все шаги прошли.
# Подробности и что делать с результатами: spikes/RUNBOOK-WINDOWS.md
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/spikes/_run-logs"
mkdir -p "$LOG" "$ROOT/spikes/s1-ffmpeg-proxy/out" "$ROOT/spikes/s2-player-seek/out"
FAIL=0
step() { echo; echo "=== [$(date +%H:%M:%S)] $*"; }
run() { # имя команда...   (вывод в лог и на экран; ошибка не прерывает прогон)
  local name=$1; shift
  step "$name"
  "$@" 2>&1 | tee "$LOG/$name.log"
  local rc=${PIPESTATUS[0]}
  echo "$name: код выхода $rc" | tee -a "$LOG/status.txt"
  [ "$rc" -eq 0 ] || FAIL=1
  return 0
}

: > "$LOG/status.txt"

# --- S1 ---
cd "$ROOT/spikes/s1-ffmpeg-proxy"
run env-check        node env-check.mjs
run hdr-compare      ./hdr-compare.sh media/real-iphone13pro-4k-dv-hlg-60.mov

# --- S2: подготовка видео ---
cd "$ROOT/spikes/s2-player-seek"
if ! ./gen-test-videos.sh > "$LOG/gen-test-videos.log" 2>&1; then
  echo "gen-test-videos: ошибка, повтор без текста (NO_TEXT=1)" | tee -a "$LOG/status.txt"
  NO_TEXT=1 ./gen-test-videos.sh > "$LOG/gen-test-videos.log" 2>&1
fi
echo "gen-test-videos: код выхода $?" | tee -a "$LOG/status.txt"
run make-real-test   ./make-real-test.sh

# --- S2: браузеры (frames — способы хранить момент; main — задержка и шаг) ---
run browser-matrix   node run-browser-matrix.mjs --mode frames --timeout-min 40
run browser-main     node run-browser-matrix.mjs --mode main --variants cfr30-g30,cfr30-g250,cfr60-g60,ntsc2997-g30,vfr30-g30,iphone13-cfr --timeout-min 20
run browser-pausealign node run-browser-matrix.mjs --mode pausealign --variants cfr30-g30,cfr60-g60,ntsc2997-g30,iphone6s-cfr,iphone13-cfr --timeout-min 20

node summarize-results.mjs > out/summary-all.md 2>>"$LOG/summarize.log" || true
step "ГОТОВО (ошибки: $FAIL). Логи: spikes/_run-logs/, сводка по всем браузерам: spikes/s2-player-seek/out/summary-all.md"
cat "$LOG/status.txt"
exit $FAIL
