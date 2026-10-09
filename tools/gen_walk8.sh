#!/bin/bash
P="$(cd "$(dirname "$0")/.." && pwd)"; cd $P/assets/raw
declare -A D=([warrior]="red-haired warrior in steel armor with red cape and a longsword" [ranger]="green-hooded elf ranger with a longbow" [paladin]="gold-and-white armored paladin with a cross shield and mace" [engineer]="goggled engineer with brown leather coat and a big wrench" [mage]="mage in a tall blue wizard hat and blue robe with a glowing staff" [sage]="white-haired sage in green robe with a leaf staff" [commander]="bearded commander in navy and gold coat with a cape, holding a baton")
for c in warrior ranger paladin engineer mage sage commander; do
  out=walk8-$c.png; [ -s $out ] && continue
  codex exec --skip-git-repo-check -s workspace-write -C $P/assets/raw "Use your image generation tool to create ONE NEW image (never reuse an existing file) and save it as $P/assets/raw/$out. 1536x1024 SPRITE SHEET, TRANSPARENT background. Draw EXACTLY the same character as the attached reference sheet (same face, hair, outfit, colors, proportions, weapon, same chibi HD pixel-art style): ${D[$c]}. Follow the attached template EXACTLY: 4 columns x 3 rows of 384x341 cells, same character size in every cell, facing RIGHT, full body, feet on the red baseline, body centred on the blue line. Rows 1-2 = one smooth 8-frame WALK cycle in order (right foot contact, down, passing, up, left foot contact, down, passing, up) with arms and cape swinging opposite to legs, head bobbing slightly. Row 3 = 4-frame IDLE breathing loop (tiny chest rise, cape/hair sway). Do NOT draw grid lines, baseline, centre line or any text." -i walk8-template.png -i hero-$c.png < /dev/null > $out.log 2>&1
  echo "$out rc=$?" >> gen.log
done
echo WALK8DONE >> gen.log
