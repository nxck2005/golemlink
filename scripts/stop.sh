#!/usr/bin/env bash
# Send SIGTERM to the running daemon.
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${GOLEMLINK_DATA_DIR:-$HOME/.golemlink}"
PID_FILE="$DATA_DIR/daemon.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "golemlink: no daemon.pid in $DATA_DIR" >&2
  exit 1
fi

pid=$(cat "$PID_FILE")
if ! kill -TERM "$pid" 2>/dev/null; then
  echo "golemlink: process $pid is not running" >&2
  rm -f "$PID_FILE"
  exit 1
fi

echo "golemlink: sent SIGTERM to $pid"
