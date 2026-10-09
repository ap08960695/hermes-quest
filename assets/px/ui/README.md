# Pixel UI modules

`font.js` and `ui-glyphs.js` publish `window.UIText` and `window.UIGlyphs`.
They are plain scripts with no game-state or RNG access and also export CommonJS
for tests. Load both before the UI integration (neither edits the game itself).

- `UIText.measure(text, scale=2)` returns fixed advance in pixels (6 per glyph).
- `UIText.draw(ctx,text,x,y,{scale=2,color,align='left',maxWidth=Infinity})`
  returns advance drawn. x is the left/center/right anchor, y is the top.
  Positions round to native integer pixels; scale must be a positive integer.
  Width overflow truncates only complete cells; it never squeezes glyphs.
  Unknown characters, including lowercase and Unicode minus, become `?`.
- `UIGlyphs.draw(ctx,id,x,y,scale=2,state='normal')` draws a 16x16 icon.
  States: normal, selected (one-pixel external frame), disabled, alert.
  Unknown IDs/states and fractional scales throw instead of silently substituting.
- Draw APIs restore caller context state and disable smoothing while drawing.

Regenerate with `node tools/gen_ui_atlas.cjs`; PNGs use deterministic stored
DEFLATE blocks, RGBA and no timestamps/metadata. `atlas.json` pins PNG hashes,
geometry and the 45/46 maps. Runtime drawing uses these same native arrays,
so main UI is immediately drawable without asynchronous PNG load races.
Contact sheets: `node tools/gen_ui_atlas.cjs --contact-dir <evidence-dir>`.
Run unit/artifact gates with `node --test tools/test_ui_atlas.cjs`.

## Detail bitmap helper (Thai + Latin)

`await UIText.ready()` loads ONLY the bundled static font. Its URL is relative
to `font.js`, so standalone and nested plugin routes work. Requires FontFace,
document.fonts and Intl.Segmenter; absent APIs/font fail visibly, not via system
fallback. `UIText.bitmap(text,{maxWidth=280,color})` wraps at word boundaries,
hard-breaks long tokens only at grapheme boundaries, and rasterizes offscreen
at 18px. maxWidth is content width; allow up to 8px horizontal padding plus
possible left ink overhang. Each line has 4px padding above/below its measured
ink, and at least 18px ascent + 5px descent. Empty/newline-only lines retain height.
`UIText.drawBitmap(ctx,bitmap,x,y,scale=1)` scales whole lines nearest-neighbour.
No free-text canvas draw occurs on the main glyph API.

`await UIText.detail(ctx,text,x,y,{maxWidth,scale,onError})` combines both; font,
coverage or layout failure draws offline/alert and calls `onError` with a safe
accessible status. Supply a hidden accessible DOM using `textContent` separately.
No HTML parsing or DOM insertion is performed here.

The detail cache is bounded to 64 entries, in-memory only. Call
`UIText.clearCache()` BEFORE replacing privacy/config context, clear old visible
canvases and accessible DOM, and do not retain returned bitmap references across
that migration. Pending font loads cannot insert/render pre-migration content.
No rasterized name/title/note is persisted or included in the generated atlas.
The integration owns fail-closed selection/redaction and font/static allowlisting.

Screen-space backing-grid/DPR/camera separation, 44px hitboxes, accessible DOM,
modal envelopes and actual game migration are integration responsibilities.
