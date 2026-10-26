#!/bin/bash
# 5秒周期の GPU 上昇が ~/Documents/wallpaper.py（5秒ごとの壁紙書き換え）由来かを A/B で確定する。
#   A: wallpaper.py を動かしたまま T 秒計測
#   B: wallpaper.py を SIGSTOP で一時停止して T 秒計測（終了時・中断時は必ず SIGCONT で再開）
# 使い方: tools/perf/wallpaper-ab.sh [秒数=30] [サンプル間隔=0.25]
# 計測中はマウス・キーボードに触らず、端末の出力が流れ続けるもの（Claude Code 等）も止めておくこと。
T=${1:-30}
DT=${2:-0.25}
GPU=/sys/class/drm/card1/device/gpu_busy_percent
PID=$(pgrep -f 'python[^ ]* [^ ]*Documents/wallpaper\.py' | head -1)
[ -z "$PID" ] && { echo "wallpaper.py が見つからない（既に止まっている）"; exit 1; }
trap 'kill -CONT '"$PID"' 2>/dev/null; echo "[restore] wallpaper.py (pid '"$PID"') を再開しました"' EXIT INT TERM

sample() { # $1=label
  local end=$(( $(date +%s) + T )) vals=()
  while [ "$(date +%s)" -lt "$end" ]; do vals+=("$(cat $GPU)"); sleep "$DT"; done
  printf '%s\n' "${vals[@]}" | awk -v L="$1" -v dt="$DT" '
    { v[NR]=$1; s+=$1; if($1>mx)mx=$1 }
    END {
      n=asort(v,w); med=w[int(n/2)+1]; p95=w[int(n*0.95)];
      for(i=1;i<=NR;i++) if (v[i] >= med+5 && (i==1 || v[i-1] < med+5)) peaks++;
      printf "%-22s n=%d mean=%.1f%% median=%d%% p95=%d%% max=%d%%  山(中央値+5pt超の立ち上がり)=%d回 / %ds\n",
             L, n, s/n, med, p95, mx, peaks, n*dt
    }'
}
echo "wallpaper.py pid=$PID, ${T}s × 2 フェーズ, 間隔 ${DT}s"
sample "A: 壁紙ローテーションあり"
kill -STOP "$PID"
sleep 6   # 直前の切り替えのクロスフェードとGPUの平滑化が抜けるのを待つ
sample "B: 壁紙ローテーション停止"
