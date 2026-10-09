#!/bin/bash
# Sequential Codex image generation (parallel runs raced on the generated-image dir).
P="$(cd "$(dirname "$0")/.." && pwd)"; R=$P/assets/raw/world-concept.png
T=$P/assets/raw/sheet-template.png; cd $P/assets/raw
run() { out=$1; shift; prompt=$1; shift
  [ -s $out ] && { echo "skip $out"; return; }
  codex exec --skip-git-repo-check -s workspace-write -C $P/assets/raw "Use your image generation tool to create ONE NEW image (never reuse an existing file) and save it as $P/assets/raw/$out. $prompt After saving, reply only with the file path." "$@" < /dev/null > $out.log 2>&1
  echo "$out rc=$? $(md5sum $out 2>/dev/null | cut -c1-8)"; }
run world-bg.png "1536x1024 landscape. EXACTLY the same kingdom layout, camera, art style and palette as the attached reference, but EMPTY: no characters, no monsters, no people, no UI, no HUD, no text labels, no banners with words, no damage numbers, no dragon (keep the volcano and its chains, empty). Clean wide roads of light stone connecting all regions so figures can walk on them later." -i $R
SHEET='Pixel-art game SPRITE SHEET, 1536x1024, TRANSPARENT background (alpha), HD-2D chibi style matching the attached world reference. Follow the attached template grid EXACTLY: 4 columns x 2 rows of 384x512 cells; draw the SAME character in every cell, same size, same colors, same outfit, facing RIGHT, full body, feet touching the red baseline, body centered on the blue center line. Top row = walk cycle (contact, down, passing, up). Bottom row = melee/spell attack (anticipation, swing, impact, recover). Do NOT draw the grid lines, baseline, center line or any text in the output. Character:'
run hero-warrior.png "$SHEET red-haired warrior in steel armor with red cape and a longsword." -i $T -i $R
run hero-ranger.png "$SHEET green-hooded elf ranger with a longbow (attack row = drawing and releasing an arrow)." -i $T -i $R
run hero-paladin.png "$SHEET gold-and-white armored paladin with a cross shield and mace." -i $T -i $R
run hero-engineer.png "$SHEET goggled engineer with brown leather coat and a big wrench (attack row = swinging wrench with sparks)." -i $T -i $R
run hero-mage.png "$SHEET mage in a tall blue wizard hat and blue robe with a glowing staff (attack row = casting a blue orb)." -i $T -i $R
run hero-sage.png "$SHEET white-haired sage in green robe with a leaf staff (attack row = casting green rune)." -i $T -i $R
run hero-commander.png "$SHEET bearded commander in navy and gold coat with a cape, pointing a baton (attack row = commanding gesture)." -i $T -i $R
run monsters.png "Pixel-art monster sheet, 1536x1024, TRANSPARENT background, HD-2D style matching the attached world reference. Follow the attached template grid: 4 columns x 2 rows of 384x512 cells, each monster full body facing LEFT with feet on the red baseline, centered. Cells in order: green goblin with club, iron siege golem, green slime, blue ghost, purple bat, skeleton warrior, red dragon (fills its cell, chained), treasure chest mimic. Do NOT draw grid lines, baseline or text." -i $T -i $R
echo ALLDONE
