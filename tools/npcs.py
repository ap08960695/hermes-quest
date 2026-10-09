#!/usr/bin/env python3
"""Villager NPCs: assets/raw/npcs.png (4 rows x 4 walk frames, facing right) -> assets/px/npcs/<name>.png + meta.json.

Same pipeline as the heroes (tools/pixelize.py + tools/sprites.py): strip bg, hard alpha, keep_main to drop
pieces that spill in from a neighbouring cell, one scale per NPC, head/torso anchored x + feet on one baseline,
box downscale to native pixels, one shared palette per NPC (no dither), 1px outline.

Source facts (measured on the raw sheet): the grid is NOT an even 384x256 grid - rows sit at y 14-242 / 270-498 /
617-754 / 782-1010, and the child (row 3) is drawn ~60% as tall as the adults, so rows are cut by band, not by cell.
Only the right-facing walk cycle exists (contact, down, passing, up); the game mirrors it for left. There is no
dedicated idle drawing: idle = the 'passing' frame (index 2).

Usage (from the repo root; raw sheet is git-ignored, pass its path if the worktree has none):
    PYTHONPATH=tools python3 tools/npcs.py [assets/raw/npcs.png] [--contact DIR]
"""
import json, os, sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pixelize as PX   # noqa: E402  (native, outline)
import sprites as SP    # noqa: E402  (strip_background, keep_main)

HERO_WALK_H = 64                       # hero walk height in px (pixelize.heroes8 target)
FW, FH, AX, BASE = 96, 80, 48, 75      # frame box, head/torso x anchor, feet baseline (native px)
COLORS = 48
SHEET_W, SHEET_H, COLS = 1536, 1024, 4

# name, y band of the row on the raw sheet, share of hero height, px trimmed off the source bbox height before
# scaling (the knight's spear tip sticks above the helmet, it is not part of the body height)
NPCS = [
    dict(name='porter', title='Porter (sack)', band=(0, 256), ratio=.85, trim=0),
    dict(name='farmer', title='Farmer (straw hat, hoe)', band=(256, 560), ratio=.85, trim=0),
    dict(name='child', title='Child (wooden sword)', band=(560, 770), ratio=.60, trim=0),
    dict(name='guard', title='Town guard (spear)', band=(770, 1024), ratio=.85, trim=14),
]


def head_x(alpha):
    ys, xs = np.nonzero(alpha)
    return xs[ys <= ys.min() + (ys.max() - ys.min()) * .4].mean()


def cut(sheet, band, c):
    """One walk frame: RGBA array cropped from its column of the row band, bg out, stray pieces dropped."""
    a = np.array(sheet.crop((c * (SHEET_W // COLS), band[0], (c + 1) * (SHEET_W // COLS), band[1])))
    a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
    a[..., 3] = SP.keep_main(a[..., 3], .03)
    a[a[..., 3] == 0] = 0
    ys, xs = np.nonzero(a[..., 3])
    if not len(ys):
        raise SystemExit(f'empty frame band={band} col={c}')
    return Image.fromarray(a), ys.min(), ys.max(), head_x(a[..., 3])


def build(npc, sheet):
    cells = [cut(sheet, npc['band'], c) for c in range(COLS)]
    body_h = np.median([y1 - y0 - npc['trim'] for _, y0, y1, _ in cells])
    s = HERO_WALK_H * npc['ratio'] / body_h
    # feet line: lowest opaque row differs by a few px per frame (lifted foot), use the median so the walk doesn't bob
    feet = np.median([y1 for _, _, y1, _ in cells])
    frames = []
    for im, y0, y1, hx in cells:
        sx0, sy0 = hx - AX / s, feet - BASE / s
        win = im.crop((round(sx0), round(sy0), round(sx0 + FW / s), round(sy0 + FH / s)))
        frames.append(PX.native(win, FW, FH, colors=COLORS, line=False))
    strip = Image.new('RGBA', (FW * len(frames), FH))
    for i, f in enumerate(frames):
        strip.alpha_composite(f, (i * FW, 0))
    # one shared palette over the whole strip, then outline each frame
    q = strip.convert('RGB').quantize(COLORS, method=Image.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
    q.putalpha(strip.getchannel('A'))
    out = Image.new('RGBA', strip.size)
    for i in range(len(frames)):
        out.alpha_composite(PX.outline(q.crop((i * FW, 0, (i + 1) * FW, FH)), base=True), (i * FW, 0))
    return out, s


def measure(strip, n):
    hx, tops, hts, feet = [], [], [], []
    for i in range(n):
        a = np.array(strip.crop((i * FW, 0, (i + 1) * FW, FH)))[..., 3] > 0
        ys, xs = np.nonzero(a)
        hx.append(xs[ys <= ys.min() + (ys.max() - ys.min()) * .4].mean())
        tops.append(int(ys.min())); feet.append(int(ys.max())); hts.append(int(ys.max() - ys.min() + 1))
    return dict(height_px=hts, height_spread=int(np.ptp(hts)), feet_y=feet, head_x_spread=round(float(np.ptp(hx)), 1),
                top_y_spread=int(np.ptp(tops)))


def contact_sheet(strips, path, zoom=4):
    w = max(s.width for s in strips.values()) * zoom
    h = sum(s.height for s in strips.values()) * zoom
    bg = Image.new('RGBA', (w, h), (88, 124, 84, 255))
    y = 0
    for s in strips.values():
        big = s.resize((s.width * zoom, s.height * zoom), Image.NEAREST)
        bg.alpha_composite(big, (0, y))
        base_y = y + (BASE + 1) * zoom                       # feet baseline guide
        for x in range(0, w, 8):
            bg.putpixel((x, min(base_y, h - 1)), (255, 0, 0, 255))
        y += s.height * zoom
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bg.convert('RGB').save(path)


def main(argv):
    contact = None
    if '--contact' in argv:
        i = argv.index('--contact'); contact = argv[i + 1]; del argv[i:i + 2]
    src = argv[0] if argv else 'assets/raw/npcs.png'
    sheet = Image.open(src).convert('RGBA').resize((SHEET_W, SHEET_H), Image.LANCZOS)
    out_dir = 'assets/px/npcs'
    os.makedirs(out_dir, exist_ok=True)
    meta, strips, report = {}, {}, {}
    for npc in NPCS:
        strip, s = build(npc, sheet)
        strip.save(f"{out_dir}/{npc['name']}.png")
        strips[npc['name']] = strip
        m = measure(strip, 4)
        report[npc['name']] = m
        meta[npc['name']] = dict(
            title=npc['title'], file=f"{npc['name']}.png", fw=FW, fh=FH, ax=AX, base=BASE,
            frames=dict(walk=[0, 1, 2, 3], idle=[2]),
            dirs=dict(right=dict(walk=[0, 1, 2, 3], idle=[2]), left='mirror of right'),
            scale_vs_hero=npc['ratio'], walk_height_px=int(np.median(m['height_px'])),
            src_scale=round(float(s), 4), head_x_spread=m['head_x_spread'], height_spread=m['height_spread'])
    json.dump(dict(hero_walk_h=HERO_WALK_H, npcs=meta), open(f'{out_dir}/meta.json', 'w'), indent=1)
    print(json.dumps(report, indent=1))
    if contact:
        contact_sheet(strips, os.path.join(contact, 'npcs_contact_4x.png'))
        print('contact sheet ->', os.path.join(contact, 'npcs_contact_4x.png'))


if __name__ == '__main__':
    main(sys.argv[1:])
