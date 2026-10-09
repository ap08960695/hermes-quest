#!/bin/bash
cd "$(dirname "$0")/.."
done_list=" "
while :; do
  for f in $(grep -oE "combo-[a-z]+-[A-Za-z]+\.png rc=0" assets/raw/gen.log | cut -d' ' -f1); do
    n=${f#combo-}; n=${n%.png}
    case "$done_list" in *" $n "*) continue;; esac
    PYTHONPATH=tools python3 tools/pixelize.py combo $n >> assets/raw/qa.log 2>&1 && done_list="$done_list$n "
  done
  grep -q COMBODONE assets/raw/gen.log && break
  sleep 20
done
echo COMBOPROCESSED >> assets/raw/qa.log
