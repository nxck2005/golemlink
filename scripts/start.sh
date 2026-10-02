#!/usr/bin/env bash
# Restart wrapper for Termux:Widget and long-running phone use.
# A clean exit (0) ends the loop; crashes restart after 3 s, and after
# 5 crashes inside 60 s it gives up.
set -u

cd "$(dirname "$0")/.."

trap '' HUP

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT
fi

crashes=0
window_start=$(date +%s)

while true; do
  node src/main.js "$@"
  code=$?
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  now=$(date +%s)
  if [ $((now - window_start)) -gt 60 ]; then
    crashes=0
    window_start=$now
  fi
  crashes=$((crashes + 1))
  if [ "$crashes" -gt 5 ]; then
    echo "golemlink: 5 crashes within 60 s; giving up" >&2
    exit 1
  fi
  echo "golemlink: exited $code; restarting in 3 s" >&2
  sleep 3
done
