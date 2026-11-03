#!/usr/bin/env bash
cd "$(dirname "$0")"
for f in logs/*.pid; do [ -f "$f" ] && kill "$(cat $f)" 2>/dev/null && echo "stopped $(basename $f .pid)"; rm -f "$f"; done
