#!/bin/bash
# gnome-shell メインスレッドの CPU と GPU を、診断系設定 ON/OFF で A/B 比較する。
#   A: 現在の設定のまま     B: output-logs=false, glass-debug-diagnostics=false
# 終了・中断時は必ず元の値に戻す。
#
# CPU は次の 4 つを出す。マシン全体（全コア）で見ると、拡張の負荷と他のアプリの
# 負荷を混同しないで済む。
#   main /core    メインスレッドが 1 コアの何 % を使ったか
#   main /machine 同じ値を全コアに対する割合にしたもの
#   other /machine 他プロセスが使った割合（= system busy − main）
#   system busy   全コアのうち動いていた割合
#
# 使い方: tools/perf/diag-cpu-ab.sh [各フェーズ秒数=15]
T=${1:-15}
EXT=$(cd "$(dirname "$0")/../../liquid-glass@thinkingcoding1231.gmail.com" && pwd)
UUID=$(node -p "require('$EXT/metadata.json').uuid")
S=org.gnome.shell.extensions.$UUID
G="gsettings --schemadir $EXT/schemas"
P=$(pgrep -x gnome-shell | head -1); HZ=$(getconf CLK_TCK); N=$(getconf _NPROCESSORS_ONLN)
# amdgpu reports a busy percentage; Intel reports its current GT frequency.
GPU_BUSY=/sys/class/drm/card1/device/gpu_busy_percent
GPU_FREQ=/sys/class/drm/card1/gt_act_freq_mhz
OL=$($G get $S output-logs); DG=$($G get $S glass-debug-diagnostics)
trap '$G set $S output-logs '"$OL"'; $G set $S glass-debug-diagnostics '"$DG"'; echo "[restore] output-logs='"$OL"' glass-debug-diagnostics='"$DG"'"' EXIT INT TERM

phase() { # $1=label
  local c0 c1 cs=0 n=0 s t0 i0 t1 i1
  read -r t0 i0 <<< "$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)"
  c0=$(awk '{print $14+$15}' /proc/$P/task/$P/stat)
  local end=$(( $(date +%s) + T ))
  while [ "$(date +%s)" -lt "$end" ]; do
    if [ -r "$GPU_BUSY" ]; then cs=$((cs + $(cat $GPU_BUSY))); n=$((n+1))
    elif [ -r "$GPU_FREQ" ]; then cs=$((cs + $(cat $GPU_FREQ))); n=$((n+1)); fi
    sleep 0.25
  done
  c1=$(awk '{print $14+$15}' /proc/$P/task/$P/stat)
  read -r t1 i1 <<< "$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)"
  local gpu="-"
  if [ "$n" -gt 0 ]; then
    if [ -r "$GPU_BUSY" ]; then gpu="busy $(echo "scale=2; $cs/$n" | bc)%"
    else gpu="$(echo "scale=0; $cs/$n" | bc)MHz"; fi
  fi
  awk -v label="$1" -v d="$((c1-c0))" -v dt="$((t1-t0))" -v di="$((i1-i0))" -v t="$T" -v cores="$N" -v gpu="$gpu" 'BEGIN{
    main = d * 100 / t / 100;
    share = (dt > 0) ? d * 100 / dt : 0;
    busy = (dt > 0) ? (dt - di) * 100 / dt : 0;
    printf "%-34s main %5.1f%%/core  %4.1f%%/machine  other %4.1f%%/machine  system busy %4.1f%%  GPU %s\n",
      label, main, share, busy - share, busy, gpu}'
}
echo "gnome-shell pid=$P  ${T}s × 2  cores=$N"
phase "A: logs=$OL diag=$DG"
$G set $S output-logs false; $G set $S glass-debug-diagnostics false; sleep 2
phase "B: logs=false diag=false"
