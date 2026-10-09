#!/bin/bash
# Process each sprite sheet as soon as Codex finishes it.
cd "$(dirname "$0")/.."
done_list=" warrior ranger paladin "
while ! grep -q LAYERSDONE assets/raw/gen.log; do
  for c in paladin engineer mage sage commander; do
    case "$done_list" in *" $c "*) continue;; esac
    grep -q "hero-$c.png rc=" assets/raw/gen.log && python3 tools/sprites.py assets/raw/hero-$c.png $c 96 >> assets/raw/qa.log 2>&1 && done_list="$done_list$c "
  done
  case "$done_list" in *" monsters "*) ;; *) grep -q "monsters.png rc=" assets/raw/gen.log && python3 tools/sprites.py assets/raw/monsters.png monsters >> assets/raw/qa.log 2>&1 && done_list="$done_list monsters ";; esac
  sleep 15
done
python3 tools/sprites.py assets/raw/buildings.png buildings >> assets/raw/qa.log 2>&1 && python3 tools/place.py >> assets/raw/qa.log 2>&1
echo PROCESSDONE >> assets/raw/qa.log
until grep -q PROPSDONE assets/raw/gen.log; do sleep 20; done
python3 tools/sprites.py assets/raw/props.png props >> assets/raw/qa.log 2>&1 && python3 tools/place.py >> assets/raw/qa.log 2>&1
echo PROPSPROCESSED >> assets/raw/qa.log
