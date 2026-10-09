#!/usr/bin/env python3
"""Sprite QA: turn Codex sprite sheets (4x2 cells of 384x512) into clean, aligned atlases.

Fixes the usual AI-sprite problems that make motion flicker or float:
- background left in (white/checker) -> flood-filled to transparent from the cell border
- soft alpha halo -> hard alpha threshold (pixel art has no partial alpha)
- each frame drawn at a different size/offset -> uniform scale per sheet, feet aligned to one
  baseline, body centered on the mask centroid of the walk row
- palette drift between frames -> one shared palette per sheet (quantize)
Reports per-frame height/centroid drift so a bad frame can be regenerated instead of shipped.
Usage: sprites.py <raw.png> <out-name> [target_height=96]
"""
import json, os, sys
from collections import deque

import numpy as np
from PIL import Image

CW, CH, COLS, ROWS = 384, 512, 4, 2
OUTW, OUTH, BASE, AX = 192, 144, 136, 72   # frame box, feet baseline, body x anchor (room for reach on the right)


def strip_background(cell):
    a = np.array(cell.convert('RGBA'))
    if (a[..., 3] < 250).mean() > 0.2:       # already transparent enough
        return a
    h, w = a.shape[:2]
    rgb = a[..., :3].astype(int)
    seen = np.zeros((h, w), bool)
    q = deque([(y, x) for x in range(w) for y in (0, h - 1)] + [(y, x) for y in range(h) for x in (0, w - 1)])
    while q:
        y, x = q.popleft()
        if seen[y, x]:
            continue
        seen[y, x] = True
        # ponytail: background = near-white or near-grey checker; tune TOL if a sheet keeps a halo
        c = rgb[y, x]
        if c.min() < 170 or c.max() - c.min() > 40:
            continue
        a[y, x, 3] = 0
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx]:
                q.append((ny, nx))
    return a


def strip_gradient(cell, tol=10, seed_tol=60):
    """Remove a smooth (gradient/vignette) background: flood from the border while each step's colour change
    stays small; sharp object edges stop the fill. Then hard-threshold alpha."""
    a = np.array(cell.convert('RGBA'))
    if (a[..., 3] < 250).mean() > 0.2:
        return a
    h, w = a.shape[:2]
    rgb = a[..., :3].astype(int)
    seen = np.zeros((h, w), bool)
    q = deque((y, x) for x in range(w) for y in (0, h - 1))
    q.extend((y, x) for y in range(h) for x in (0, w - 1))
    for y, x in q:
        seen[y, x] = True
    while q:
        y, x = q.popleft()
        a[y, x, 3] = 0
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and np.abs(rgb[ny, nx] - rgb[y, x]).max() <= tol:
                seen[ny, nx] = True
                q.append((ny, nx))
    return a


def main_rows(alpha, gap=3):
    """Zero rows outside the contiguous row band that holds most of the mass (cuts neighbour-cell strips)."""
    rows = (alpha > 0).sum(1)
    runs, start = [], None
    for i, n in enumerate(list(rows) + [0]):
        if n and start is None:
            start = i
        elif not n and start is not None:
            runs.append([start, i]); start = None
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    if not merged:
        return alpha
    a, b = max(merged, key=lambda r: rows[r[0]:r[1]].sum())
    out = alpha.copy(); out[:a] = 0; out[b:] = 0
    return out


def body_top(a, anchor=48, reference=None, reference_pose=False):
    """Measure a reference-matched head; alpha alone is not semantic evidence.

    Unreferenced calls are permitted only for known walk/idle reference poses.
    Arbitrary/attack images require crown/face appearance evidence or fail closed.
    """
    if reference is not None:
        return match_head(a, reference)[0]
    if not reference_pose:
        raise ValueError('semantic head reference required')
    ys, xs = np.nonzero(a[..., 3])
    if not len(ys):
        raise ValueError('empty body')
    center = None
    if center is None:
        upper = ys <= ys.min() + (ys.max() - ys.min()) * .4
        hist = np.bincount(xs[upper], minlength=a.shape[1])
        width = max(8, round((ys.max() - ys.min()) * .3))
        scores = np.convolve(hist, np.ones(width), 'valid')
        centers = np.arange(len(scores)) + width / 2
        foot_center = xs[ys >= ys.max() - (ys.max() - ys.min()) * .2].mean()
        scores[np.abs(centers - foot_center) > 16] = -1
        left = int(np.argmax(scores))
        inside = upper & (xs >= left) & (xs < left + width)
        center = xs[inside].mean() if inside.any() else anchor
    center = round(float(center))
    rows = np.flatnonzero((a[:, max(0, center - 5):min(a.shape[1], center + 6), 3] > 0).sum(1) >= 4)
    if not len(rows):
        raise ValueError('head region missing')
    return int(rows[0])


def head_reference(a):
    """Walk/idle crown and face appearance, including transparent surroundings."""
    top = body_top(a, reference_pose=True)
    ys, xs = np.nonzero(a[..., 3])
    height = int(ys.max()) - top + 1
    upper = (ys >= top) & (ys < top + height * .25)
    foot_center = float(xs[ys >= ys.max() - height * .2].mean())
    width = max(8, round(height * .25))
    hist = np.bincount(xs[upper], minlength=a.shape[1])
    scores = np.convolve(hist, np.ones(width), 'valid')
    centers = np.arange(len(scores)) + width / 2
    scores[np.abs(centers - foot_center) > 16] = -1
    left = int(scores.argmax())
    core = upper & (xs >= left) & (xs < left + width)
    center = int(round(float(xs[core].mean())))
    # Keep the crown/face, not a lateral staff included by a whole-upper-body
    # centroid. Equipment changes pose independently and is not a reference.
    radius = max(9, round(height * .18))
    left = max(0, center - radius)
    right = min(a.shape[1], center + radius + 1)
    # Two rows above the crown pin its boundary: a uniform face/hair patch
    # without background can match every vertical position inside a body.
    patch = a[max(0, top - 2):top + max(8, round(height * .30)), left:right].copy()
    if top < 2:
        patch = np.pad(patch, ((2 - top, 0), (0, 0), (0, 0)))
    return patch


def match_head(a, references):
    """Match crown/face appearance, never the topmost central alpha.

    Transparent template pixels count too, preventing a matching weapon colour
    from substituting for a complete head. Uncertain/competing matches fail
    closed; callers must not rescale or issue a QA PASS in that case.
    """
    if isinstance(references, np.ndarray):
        references = [references]
    candidates = []
    image = a.astype(np.float32)
    for reference in references:
        for scale in (.75, .875, 1., 1.125, 1.25):
            rh, rw = reference.shape[:2]
            ref = np.array(Image.fromarray(reference).resize(
                (max(3, round(rw * scale)), max(3, round(rh * scale))), Image.Resampling.NEAREST))
            rh, rw = ref.shape[:2]
            if rh > a.shape[0] or rw > a.shape[1]:
                continue
            # Sample the complete patch; broadcast over all candidate positions.
            step = max(1, min(rh, rw) // 12)
            sample = ref[::step, ::step].astype(np.float32)
            sh, sw = sample.shape[:2]
            ymax = min(a.shape[0] - rh + 1, round(a.shape[0] * .7))
            xmax = a.shape[1] - rw + 1
            score = np.zeros((ymax, xmax), np.float32)
            for y in range(sh):
                for x in range(sw):
                    pixel = image[y * step:y * step + ymax, x * step:x * step + xmax]
                    opaque = sample[y, x, 3] > 0
                    mismatch = (pixel[..., 3] > 0) != opaque
                    score += mismatch * 255
                    if opaque:
                        score += np.abs(pixel[..., :3] - sample[y, x, :3]).mean(2)
            score /= sh * sw
            # Keep spatially distinct alternatives to test ambiguity.
            for _ in range(3):
                y, x = np.unravel_index(score.argmin(), score.shape)
                candidates.append((float(score[y, x]), int(y) + round(2 * scale), int(x), rw))
                score[max(0, y - 3):y + 4, max(0, x - 3):x + 4] = float('inf')
    if not candidates:
        raise ValueError('head reference missing')
    candidates.sort()
    best = candidates[0]
    if best[0] > 65:
        raise ValueError('ambiguous head appearance: no reliable reference match')
    rival = next((c for c in candidates[1:] if abs(c[1] - best[1]) > 3), None)
    if rival and rival[0] < best[0] + 3:
        raise ValueError('ambiguous head appearance: competing vertical matches')
    return best[1], best[2] + best[3] // 2


def combo_row_bounds(alpha, masks=False, columns=1):
    """Find four drawn figures in a column, rather than assuming equal row heights.

    Work at full resolution: subsampling joins adjacent feet/hair across rows.
    Return cuts between the four largest silhouettes. Fail on ambiguous sheets.
    """
    m = alpha > 128
    h, w = m.shape
    seen = np.zeros_like(m)
    labels = np.zeros(m.shape, np.int32)
    parts = []
    for y, x in zip(*np.nonzero(m)):
        if seen[y, x]:
            continue
        seen[y, x] = True
        q, ys, xs = [(int(y), int(x))], [], []
        label = len(parts) + 1
        labels[y, x] = label
        while q:
            cy, cx = q.pop(); ys.append(cy); xs.append(cx)
            for ny in range(max(0, cy - 1), min(h, cy + 2)):
                for nx in range(max(0, cx - 1), min(w, cx + 2)):
                    if m[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; labels[ny, nx] = label; q.append((ny, nx))
        parts.append((len(ys), min(ys), max(ys) + 1, label, float(np.mean(xs))))
    figures = sorted(parts, reverse=True)[:4 * columns]
    if len(figures) != 4 * columns or min(p[0] for p in figures) < max(p[0] for p in figures) * .2:
        raise ValueError('combo column does not contain four separate figures')
    groups = [sorted([p for p in figures if min(columns - 1, int(p[4] / w * columns)) == c], key=lambda p: p[1])
              for c in range(columns)]
    if any(len(g) != 4 for g in groups):
        raise ValueError('combo figures touch across cells: regenerate sheet')
    figures = [groups[c][r] for r in range(4) for c in range(columns)]
    if masks:
        # A raised bow can overlap the preceding row's feet vertically while
        # staying disconnected. Component ownership preserves both intact.
        owners = np.zeros(len(parts) + 1, np.int32)
        samples = [np.column_stack(np.nonzero(labels == f[3]))[::8] for f in figures]
        for p in parts:
            if p in figures:
                row = figures.index(p)
            elif p[0] >= 20:
                points = np.column_stack(np.nonzero(labels == p[3]))[::max(1, p[0] // 32)]
                # Ownership is nearest silhouette, not nearest body centroid:
                # a projectile beside the previous cell must not follow the
                # next cell's torso just because that torso is closer.
                row = min(range(len(figures)), key=lambda r: ((points[:, None] - samples[r]) ** 2).sum(2).min())
            else:
                row = min(range(len(figures)), key=lambda r: ((p[1] + p[2] - figures[r][1] - figures[r][2]) / 2) ** 2
                          + (p[4] - figures[r][4]) ** 2)
            owners[p[3]] = row + 1
        return [np.where(owners[labels] == row + 1, alpha, 0) for row in range(len(figures))]
    if any(a[2] > b[1] + 4 for a, b in zip(figures, figures[1:])):
        raise ValueError('combo row silhouettes overlap: regenerate sheet')
    return [0] + [(a[2] + b[1]) // 2 for a, b in zip(figures, figures[1:])] + [alpha.shape[0]]


def keep_main(alpha, keep=0.02):
    """Keep the main figure: largest component + other pieces (effects, weapon tips) that are not sitting above
    its head or glued to the cell's top edge. Drops feet/legs that spill in from the sheet row above."""
    m = alpha[::2, ::2] > 0
    h, w = m.shape
    lab = np.zeros((h, w), int); info = [None]
    for y in range(h):
        for x in range(w):
            if m[y, x] and not lab[y, x]:
                n = len(info); q = [(y, x)]; lab[y, x] = n; ys = []; xs = []
                while q:
                    cy, cx = q.pop(); ys.append(cy); xs.append(cx)
                    for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = n; q.append((ny, nx))
                info.append((len(ys), min(ys), max(ys)))
    if len(info) == 1:
        return alpha
    big = max(range(1, len(info)), key=lambda i: info[i][0])
    bs, bt, bb = info[big]
    ok = np.zeros(len(info), bool)
    for i in range(1, len(info)):
        size, top, bot = info[i]
        above_head = bot < bt + (bb - bt) * .15
        ok[i] = i == big or (size >= keep * bs and not above_head and not (top == 0 and bt > 0))
    full = np.repeat(np.repeat(ok[lab], 2, 0), 2, 1)[:alpha.shape[0], :alpha.shape[1]]
    return np.where(full, alpha, 0)


def despeckle(alpha, keep=0.02):
    """Drop dust/stray blobs: keep connected components >= keep * largest (4-connected, 1/2 res)."""
    m = alpha[::2, ::2] > 0
    h, w = m.shape
    lab = np.zeros((h, w), int)
    sizes = [0]
    for y in range(h):
        for x in range(w):
            if m[y, x] and not lab[y, x]:
                n = len(sizes); sizes.append(0); q = [(y, x)]; lab[y, x] = n
                while q:
                    cy, cx = q.pop(); sizes[n] += 1
                    for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = n; q.append((ny, nx))
    big = max(sizes)
    ok = np.array([s >= keep * big for s in sizes]); ok[0] = False
    full = np.repeat(np.repeat(ok[lab], 2, 0), 2, 1)[:alpha.shape[0], :alpha.shape[1]]
    return np.where(full, alpha, 0)


def main(src, name, target=96):
    sheet = Image.open(src).convert('RGBA').resize((CW * COLS, CH * ROWS), Image.LANCZOS)
    cells, boxes = [], []
    for r in range(ROWS):
        for c in range(COLS):
            a = strip_background(sheet.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH)))
            a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
            a[..., 3] = despeckle(a[..., 3])
            ys, xs = np.nonzero(a[..., 3])
            if len(ys) == 0:
                raise SystemExit(f'{name}: empty frame r{r}c{c}')
            cells.append(a)
            boxes.append((ys.min(), ys.max(), xs.mean(), xs.min(), xs.max()))
    walk_h = np.median([b[1] - b[0] for b in boxes[:4]])
    scale = target / walk_h
    frames, report = [], []
    for i, (a, (y0, y1, cx, x0, x1)) in enumerate(zip(cells, boxes)):
        im = Image.fromarray(a)
        w, h = round(CW * scale), round(CH * scale)
        im = im.resize((w, h), Image.NEAREST)
        out = Image.new('RGBA', (OUTW, OUTH))
        # Feet on BASE; walk frames centered on their own mask centroid, attack frames on the walk centroid
        # so a lunge reads as a lunge instead of being re-centered away.
        ref_cx = cx if i < 4 else np.mean([b[2] for b in boxes[:4]])
        out.alpha_composite(im, (round(AX - ref_cx * scale), round(BASE - y1 * scale)))
        frames.append(out)
        report.append(dict(frame=i, height=round((y1 - y0) * scale, 1), cx=round(ref_cx * scale, 1)))
    strip = Image.new('RGBA', (OUTW * 8, OUTH))
    for i, f in enumerate(frames):
        strip.alpha_composite(f, (i * OUTW, 0))
    alpha = strip.getchannel('A')
    pal = strip.convert('RGB').quantize(48, method=Image.MEDIANCUT).convert('RGB')
    pal.putalpha(alpha)
    os.makedirs('assets/sprites', exist_ok=True)
    pal.save(f'assets/sprites/{name}.png')
    hs = [r['height'] for r in report[:4]]
    drift = dict(walk_height_spread=round(max(hs) - min(hs), 1),
                 walk_cx_spread=round(max(r['cx'] for r in report[:4]) - min(r['cx'] for r in report[:4]), 1))
    json.dump(dict(frames=report, drift=drift, w=OUTW, h=OUTH, base=BASE), open(f'assets/sprites/{name}.json', 'w'))
    print(name, drift)


MONSTERS = [('goblin', 64), ('golem', 104), ('slime', 44), ('ghost', 64), ('bat', 48), ('skeleton', 72),
            ('dragon', 220), ('mimic', 56)]


def monsters(src):
    """Monster sheet: one creature per cell, each scaled to its own height, one 256x256 frame each."""
    sheet = Image.open(src).convert('RGBA').resize((CW * COLS, CH * ROWS), Image.LANCZOS)
    strip = Image.new('RGBA', (256 * len(MONSTERS), 256))
    for i, (mname, target) in enumerate(MONSTERS):
        r, c = divmod(i, COLS)
        a = strip_background(sheet.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH)))
        a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
        ys, xs = np.nonzero(a[..., 3])
        im = Image.fromarray(a).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        s = min(target / im.height, 240 / im.width)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.NEAREST)
        strip.alpha_composite(im, (i * 256 + (256 - im.width) // 2, 248 - im.height))
    alpha = strip.getchannel('A')
    pal = strip.convert('RGB').quantize(64, method=Image.MEDIANCUT).convert('RGB')
    pal.putalpha(alpha)
    os.makedirs('assets/sprites', exist_ok=True)
    pal.save('assets/sprites/monsters.png')
    json.dump(dict(names=[m for m, _ in MONSTERS], w=256, h=256, base=248), open('assets/sprites/monsters.json', 'w'))
    print('monsters ok')


BUILDINGS = ['castle', 'forge', 'treehouse', 'tower', 'observatory', 'cathedral', 'volcano', 'harbor', 'inn', 'vault',
             'fountain', 'trees']


def buildings(src):
    """Building sheet 4x3 (384x341 cells): cut each building to its own PNG, base = lowest opaque row."""
    bw, bh = 384, 341
    sheet = Image.open(src).convert('RGBA').resize((bw * 4, bh * 3), Image.LANCZOS)
    meta = {}
    os.makedirs('assets/buildings', exist_ok=True)
    for i, n in enumerate(BUILDINGS):
        r, c = divmod(i, 4)
        a = strip_gradient(sheet.crop((c * bw, r * bh, (c + 1) * bw, (r + 1) * bh)))
        a[..., 3] = np.where(a[..., 3] > 100, 255, 0)
        a[..., 3] = main_rows(despeckle(a[..., 3], .03))
        ys, xs = np.nonzero(a[..., 3])
        im = Image.fromarray(a).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        im.save(f'assets/buildings/{n}.png')
        meta[n] = dict(w=im.width, h=im.height)
    json.dump(meta, open('assets/buildings/meta.json', 'w'))
    print('buildings', meta)


PROPS = ['lamp', 'signpost', 'fence', 'barrels', 'crates', 'stall', 'cart', 'well', 'rock', 'rocks', 'bush', 'flowers',
         'pine', 'oak', 'deadtree', 'stump', 'tent', 'campfire', 'windmill', 'field', 'pillar', 'banner', 'rowboat', 'lavarock']


def props(src):
    """Prop sheet 6x4 (256x256 cells) -> one trimmed PNG per prop."""
    sheet = Image.open(src).convert('RGBA').resize((256 * 6, 256 * 4), Image.LANCZOS)
    meta = {}
    os.makedirs('assets/props', exist_ok=True)
    for i, n in enumerate(PROPS):
        r, c = divmod(i, 6)
        a = strip_gradient(sheet.crop((c * 256, r * 256, (c + 1) * 256, (r + 1) * 256)))
        a[..., 3] = np.where(a[..., 3] > 100, 255, 0)
        a[..., 3] = main_rows(despeckle(a[..., 3], .05))
        ys, xs = np.nonzero(a[..., 3])
        if not len(ys):
            continue
        im = Image.fromarray(a).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        im.save(f'assets/props/{n}.png')
        meta[n] = dict(w=im.width, h=im.height)
    json.dump(meta, open('assets/props/meta.json', 'w'))
    print('props', len(meta))


if __name__ == '__main__':
    if sys.argv[2] == 'props':
        props(sys.argv[1])
    elif sys.argv[2] == 'buildings':
        buildings(sys.argv[1])
    elif sys.argv[2] == 'monsters':
        monsters(sys.argv[1])
    else:
        main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 96)
