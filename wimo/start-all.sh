#!/usr/bin/env bash
# Starts all three server nodes in the background (logs in ./logs). Stop with ./stop-all.sh
cd "$(dirname "$0")"; mkdir -p logs
for n in node1 node2 node3; do
  node server/index.js $n > logs/$n.out 2>&1 &
  echo $! > logs/$n.pid
  echo "started $n (pid $!)"
done
echo "Open http://localhost:3001  http://localhost:3002  http://localhost:3003"
