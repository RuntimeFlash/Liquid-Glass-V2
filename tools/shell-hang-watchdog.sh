#!/usr/bin/env bash
# Watches gnome-shell's D-Bus responsiveness and, on a sustained hang,
# captures thread state (and a best-effort gdb backtrace) BEFORE the user
# has to REISUB. Written after the 2026-09-23 07:25 freeze investigation —
# see memo.md addendum for context. This script only observes; it never
# kills or restarts gnome-shell.
#
# Usage: shell-hang-watchdog.sh
# Install as a systemd --user service (see shell-hang-watchdog.service).

set -u

POLL_INTERVAL=1          # seconds between pings
FAIL_THRESHOLD=4         # consecutive failed pings before we call it "hung"
PING_TIMEOUT=2           # seconds to wait for one D-Bus ping
FOLLOWUP_CAPTURES=4      # extra snapshots taken while still hung
FOLLOWUP_INTERVAL=10     # seconds between those snapshots

OUT_DIR="${HOME}/.cache/liquid-glass-hang-watchdog"
mkdir -p "$OUT_DIR"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') $*" | systemd-cat -t shell-hang-watchdog -p info
}

shell_pid() {
  pgrep -x gnome-shell | head -n1
}

ping_shell() {
  timeout "$PING_TIMEOUT" busctl --user call \
    org.gnome.Shell /org/gnome/Shell org.freedesktop.DBus.Peer Ping \
    >/dev/null 2>&1
}

capture_state() {
  local pid="$1" tag="$2"
  local f="${OUT_DIR}/hang_$(date '+%Y%m%d_%H%M%S')_${tag}.txt"
  {
    echo "=== $(date '+%Y-%m-%d %H:%M:%S.%3N') gnome-shell pid=${pid} tag=${tag} ==="
    echo
    echo "--- ps (all threads, state/cpu/wchan) ---"
    ps -o pid,tid,stat,pcpu,pmem,wchan:32,comm -L -p "$pid" 2>&1
    echo
    echo "--- /proc/${pid}/status ---"
    cat "/proc/${pid}/status" 2>&1
    echo
    echo "--- per-thread wchan ---"
    for t in /proc/"${pid}"/task/*; do
      tid="$(basename "$t")"
      echo "tid=${tid} wchan=$(cat "$t/wchan" 2>/dev/null) state=$(awk '{print $3}' "$t/stat" 2>/dev/null)"
    done
    echo
    echo "--- best-effort gdb backtrace (may fail under yama ptrace_scope) ---"
    timeout 10 gdb -p "$pid" --batch \
      -ex "set pagination off" \
      -ex "thread apply all bt" \
      -ex "detach" 2>&1
  } > "$f"
  log "captured ${f}"
}

main() {
  log "watchdog started"
  local fails=0
  local hung=0
  local followups_left=0

  while true; do
    sleep "$POLL_INTERVAL"

    local pid
    pid="$(shell_pid)"
    if [[ -z "$pid" ]]; then
      # gnome-shell not running (different session type, or logged out) — idle quietly.
      fails=0
      hung=0
      continue
    fi

    if ping_shell; then
      if [[ "$hung" -eq 1 ]]; then
        log "gnome-shell (pid=${pid}) responded again after being unresponsive"
      fi
      fails=0
      hung=0
      followups_left=0
      continue
    fi

    fails=$((fails + 1))
    if [[ "$fails" -ge "$FAIL_THRESHOLD" && "$hung" -eq 0 ]]; then
      hung=1
      followups_left=$FOLLOWUP_CAPTURES
      log "gnome-shell (pid=${pid}) unresponsive for ${fails}x${POLL_INTERVAL}s pings — capturing state"
      capture_state "$pid" "onset"
    elif [[ "$hung" -eq 1 && "$followups_left" -gt 0 ]]; then
      # Space out follow-up captures without blocking the ping loop timing much.
      sleep "$((FOLLOWUP_INTERVAL - POLL_INTERVAL))"
      followups_left=$((followups_left - 1))
      capture_state "$pid" "followup${followups_left}"
    fi
  done
}

main
