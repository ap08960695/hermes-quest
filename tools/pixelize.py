#!/usr/bin/env python3
"""Turn AI 'pixel art' (fake pixels of uneven size) into true pixel art on one world pixel grid.

Steps per sprite: box-downscale to the native size (each output pixel = average of its source block),
hard alpha, shared palette quantize (no dither), 1px dark outline. Output is drawn by the game only
at integer scale with smoothing off, so every pixel stays square and sharp.
Usage: pixelize.py heroes|monsters|buildings|props
"""
import json, os, sys

import numpy as np
from PIL import Image

OUT = 'assets/px'
OUTLINE = (24, 18, 28, 255)


def outline(im, base=False):
    """1px dark outline. base=False skips the bottom 12% so a building/prop meets the ground without a pasted line."""
    a = np.array(im)
    al = a[..., 3] > 0
    grow = np.zeros_like(al)
    # Dilation must not wrap a clipped left edge onto the opposite cell edge.
    grow[1:] |= al[:-1]; grow[:-1] |= al[1:]
    grow[:, 1:] |= al[:, :-1]; grow[:, :-1] |= al[:, 1:]
    edge = grow & ~al
    if not base:
        edge[int(a.shape[0] * .88):] = False
    a[edge] = OUTLINE
    return Image.fromarray(a)


def native(src, w, h, colors=64, line=True, base=True):
    """src RGBA (any size, transparent bg) -> w x h true-pixel sprite (keeps 1px border for outline)."""
    src = src.convert('RGBA')
    a = np.array(src).astype(float)
    pre = a.copy(); pre[..., :3] *= (a[..., 3:] / 255)          # premultiply so edges don't go grey
    im = Image.fromarray(pre.clip(0, 255).astype('uint8'), 'RGBA').resize((w - 2, h - 2), Image.BOX)
    b = np.array(im).astype(float)
    al = b[..., 3]
    rgb = np.where(al[..., None] > 0, b[..., :3] / np.maximum(al[..., None], 1) * 255, 0)
    keep = al > 110
    out = np.zeros((h - 2, w - 2, 4), 'uint8')
    out[..., :3] = rgb.clip(0, 255); out[..., 3] = np.where(keep, 255, 0)
    im = Image.fromarray(out, 'RGBA')
    q = im.convert('RGB').quantize(colors, method=Image.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
    q.putalpha(im.getchannel('A'))
    canvas = Image.new('RGBA', (w, h)); canvas.alpha_composite(q, (1, 1))
    return outline(canvas, base) if line else canvas


def heroes(target=64):
    """Raw Codex sheets (4x2 cells 384x512) -> native strips: walk height `target` px, feet on one baseline,
    walk frames centred on their own mass, attack frames on the walk centre (a lunge stays a lunge)."""
    import sprites as SP
    FW, FH, AX, BASE = 128, 96, 48, 91
    for cls in ['warrior', 'ranger', 'paladin', 'engineer', 'mage', 'sage', 'commander']:
        p = f'assets/raw/hero-{cls}.png'
        if not os.path.exists(p):
            continue
        sheet = Image.open(p).convert('RGBA').resize((384 * 4, 512 * 2), Image.LANCZOS)
        cells, boxes = [], []
        for i in range(8):
            r, c = divmod(i, 4)
            a = SP.strip_background(sheet.crop((c * 384, r * 512, (c + 1) * 384, (r + 1) * 512)))
            a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
            a[..., 3] = SP.despeckle(a[..., 3])
            ys, xs = np.nonzero(a[..., 3])
            cells.append(Image.fromarray(a)); boxes.append((ys.min(), ys.max(), xs.mean()))
        walk_h = np.median([b[1] - b[0] for b in boxes[:4]]); s = target / walk_h
        wcx = np.mean([b[2] for b in boxes[:4]])
        out = Image.new('RGBA', (FW * 8, FH))
        for i, (im, (y0, y1, cx)) in enumerate(zip(cells, boxes)):
            ref = cx if i < 4 else wcx
            # crop a window around the figure in source px, then box-downscale to native
            sx0 = ref - AX / s; sy0 = y1 - BASE / s
            win = im.crop((round(sx0), round(sy0), round(sx0 + FW / s), round(sy0 + FH / s)))
            out.alpha_composite(native(win, FW, FH), (i * FW, 0))
        os.makedirs(OUT, exist_ok=True); out.save(f'{OUT}/{cls}.png')
    json.dump(dict(fw=FW, fh=FH, ax=AX, base=BASE), open(f'{OUT}/heroes.json', 'w'))
    print('heroes ok')


def heroes8(target=64):
    """walk8-<cls>.png (4x3 cells 384x341: 8 walk + 4 idle) + attack row of hero-<cls>.png -> 16-frame strip.
    Every frame is anchored on the head/torso (top 40% of the figure), not the whole-body centroid, so swinging
    legs and capes don't shift the body sideways (the main source of walk-cycle jitter)."""
    import sprites as SP
    FW, FH, AX, BASE = 128, 96, 48, 91

    def load(path, cw, ch, cols, idx):
        sheet = Image.open(path).convert('RGBA').resize((cw * cols, ch * (max(idx) // cols + 1)), Image.LANCZOS)
        out = []
        for i in idx:
            r, c = divmod(i, cols)
            a = SP.strip_background(sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)))
            a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
            a[..., 3] = SP.despeckle(a[..., 3], .06)
            ys, xs = np.nonzero(a[..., 3])
            top = ys.min() + (ys.max() - ys.min()) * .4
            head = xs[ys <= top].mean()
            out.append((Image.fromarray(a), ys.min(), ys.max(), head))
        return out

    report = {}
    for cls in ['warrior', 'ranger', 'paladin', 'engineer', 'mage', 'sage', 'commander']:
        wpath, apath = f'assets/raw/walk8-{cls}.png', f'assets/raw/hero-{cls}.png'
        if not (os.path.exists(wpath) and os.path.exists(apath)):
            continue
        walk = load(wpath, 384, 341, 4, range(12))
        atk_all = load(apath, 384, 512, 4, range(8))
        atk = atk_all[4:]
        frames = []
        # attack poses raise arms/weapons, so their bbox height is not body height: scale the attack sheet by
        # its own WALK row (same sheet, same drawing scale) so the body stays the same size across frame sets.
        scales = {id(walk): target / np.median([f[2] - f[1] for f in walk[:8]]),
                  id(atk): target / np.median([f[2] - f[1] for f in atk_all[:4]])}
        for group in (walk, atk):
            s = scales[id(group)]
            for im, y0, y1, head in group:
                sx0 = head - AX / s; sy0 = y1 - BASE / s
                win = im.crop((round(sx0), round(sy0), round(sx0 + FW / s), round(sy0 + FH / s)))
                frames.append(native(win, FW, FH))
        strip = Image.new('RGBA', (FW * len(frames), FH))
        for i, f in enumerate(frames):
            strip.alpha_composite(f, (i * FW, 0))
        strip.save(f'{OUT}/{cls}.png')
        # jitter report on the walk loop: head x and top y per frame (native px)
        hx, ty = [], []
        for f in frames[:8]:
            a = np.array(f)[..., 3] > 0; ys, xs = np.nonzero(a); top = ys.min() + (ys.max() - ys.min()) * .4
            hx.append(xs[ys <= top].mean()); ty.append(ys.min())
        report[cls] = dict(head_x_spread=round(float(np.ptp(hx)), 1), top_y_spread=int(np.ptp(ty)))
    json.dump(dict(fw=FW, fh=FH, ax=AX, base=BASE, walk=list(range(8)), idle=list(range(8, 12)), atk=list(range(12, 16))),
              open(f'{OUT}/heroes.json', 'w'))
    print('heroes8', report)


WATER_BASE = {'harbor', 'rowboat'}
MON_H = {'goblin': 46, 'golem': 68, 'slime': 34, 'ghost': 50, 'skeleton': 52, 'bat': 44}
TIERS = {'s': .8, 'm': 1.0, 'l': 1.3}


def monsters2():
    """mon-<type>.png (4x3 cells 384x341: walk4, attack4, hurt, death3) -> per type and size tier a 12-frame strip.
    Anchored on the walk row's body centre + feet line so attack lunges and death falls keep their offset."""
    import sprites as SP
    meta = {}
    os.makedirs(f'{OUT}/monsters2', exist_ok=True)
    for m, base_h in MON_H.items():
        path = f'assets/raw/mon-{m}.png'
        if not os.path.exists(path):
            continue
        sheet = Image.open(path).convert('RGBA').resize((384 * 4, 341 * 3), Image.LANCZOS)
        cells = []
        for i in range(12):
            r, c = divmod(i, 4)
            a = SP.strip_background(sheet.crop((c * 384, r * 341, (c + 1) * 384, (r + 1) * 341)))
            a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
            a[..., 3] = SP.despeckle(a[..., 3], .06)
            ys, xs = np.nonzero(a[..., 3])
            cells.append((Image.fromarray(a), ys.min() if len(ys) else 0, ys.max() if len(ys) else 1, xs.mean() if len(xs) else 192))
        walk_h = np.median([c[2] - c[1] for c in cells[:4]]); cx_ = np.mean([c[3] for c in cells[:4]]); feet = np.median([c[2] for c in cells[:4]])
        for tier, k in TIERS.items():
            target = round(base_h * k); s_ = target / walk_h
            FW, FH = round(target * 2.6) // 2 * 2, round(target * 1.7)
            AX, BASE = FW // 2, FH - 3
            strip = Image.new('RGBA', (FW * 12, FH))
            for i, (im, y0, y1, _) in enumerate(cells):
                win = im.crop((round(cx_ - AX / s_), round(feet - BASE / s_), round(cx_ - AX / s_ + FW / s_), round(feet - BASE / s_ + FH / s_)))
                strip.alpha_composite(native(win, FW, FH), (i * FW, 0))
            strip.save(f'{OUT}/monsters2/{m}-{tier}.png')
            meta[f'{m}-{tier}'] = dict(fw=FW, fh=FH, ax=AX, base=BASE)
    json.dump(meta, open(f'{OUT}/monsters2/meta.json', 'w'))
    print('monsters2', sorted(meta))


def lairs():
    """lairs.png 2x2 cells of 768x512 -> cave/ruins/swamp/camp cutouts."""
    import sprites as SP
    names, width = ['cave', 'ruins', 'swamp', 'camp'], {'cave': 190, 'ruins': 170, 'swamp': 200, 'camp': 230}
    sheet = Image.open('assets/raw/lairs.png').convert('RGBA').resize((1536, 1024), Image.LANCZOS)
    os.makedirs(f'{OUT}/lairs', exist_ok=True)
    meta = {}
    for i, n in enumerate(names):
        r, c = divmod(i, 2)
        a = SP.strip_gradient(sheet.crop((c * 768, r * 512, (c + 1) * 768, (r + 1) * 512)))
        a[..., 3] = np.where(a[..., 3] > 100, 255, 0)
        a[..., 3] = SP.main_rows(SP.despeckle(a[..., 3], .05))
        ys, xs = np.nonzero(a[..., 3])
        im = Image.fromarray(a).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        wdt = width[n]; h = round(im.height * wdt / im.width)
        native(im, wdt + 2, h + 2, colors=48, base=False).save(f'{OUT}/lairs/{n}.png'); meta[n] = dict(w=wdt + 2, h=h + 2)
    json.dump(meta, open(f'{OUT}/lairs/meta.json', 'w'))
    print('lairs', meta)


# Model theme = new armour/cloth colours on the same animation frames (pose-identical, so motion stays smooth).
# Skin, hair-dark and near-grey pixels keep their colour; every other hue band is remapped to the theme.
THEMES = {'Sol': (28, 1.15, 1.05), 'Sonnet': (275, 1.0, 1.0), 'Haiku': (190, .8, 1.15), 'Gemini': (52, 1.1, 1.1),
          'Luna': (215, .45, 1.15), 'Opus': (45, .55, 1.25), 'Fable': (20, .8, 1.15), 'Astra': (195, 1.0, 1.1)}


def recolor(im, theme):
    import colorsys
    hue, sat_k, val_k = theme
    a = np.array(im).astype(float) / 255
    out = a.copy()
    rgb = a[..., :3].reshape(-1, 3); al = a[..., 3].reshape(-1)
    res = out[..., :3].reshape(-1, 3)
    for i in np.flatnonzero(al > 0):
        h, s_, v = colorsys.rgb_to_hsv(*rgb[i])
        skin = (h < 0.14 or h > 0.97) and 0.12 < s_ < 0.68 and v > 0.5 and (rgb[i][0] > rgb[i][2] + .08)   # warm, light = face/hands
        if s_ < 0.18 or skin or v < 0.12:
            continue
        # keep each pixel's offset from its band so shading survives; pull everything to the theme hue
        nh = (hue / 360 + (h - round(h * 6) / 6) * .5) % 1
        res[i] = colorsys.hsv_to_rgb(nh, min(1, s_ * sat_k), min(1, v * val_k))
    out[..., :3] = res.reshape(out[..., :3].shape)
    return Image.fromarray((out * 255).round().astype('uint8'), 'RGBA')


def combo(name, target=64):
    """combo-<cls>-<Tag>.png (4x4 cells 384x256: walk8, idle4, attack4) -> assets/px/heroes/<cls>-<Tag>.png,
    same frame layout as heroes.json (walk 0-7, idle 8-11, atk 12-15).
    Adaptive row cuts preserve feet; each animation group uses its body height."""
    import sprites as SP
    FW, FH, AX, BASE = 128, 96, 48, 91
    import hashlib, io
    raw_payload = open(f'assets/raw/combo-{name}.png', 'rb').read()
    raw_sha256 = hashlib.sha256(raw_payload).hexdigest()
    sheet = Image.open(io.BytesIO(raw_payload)).convert('RGBA').resize((1536, 1024), Image.LANCZOS)
    original = SP.strip_background(sheet)
    masks = SP.combo_row_bounds(original[..., 3], masks=True, columns=4)
    cells = []
    head_refs = []
    reference_heights = []
    source_clip = []
    for i in range(16):
        r, c = divmod(i, 4)
        a = original.copy()
        a[..., 3] = masks[i]
        a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
        a[..., 3] = SP.keep_main(a[..., 3], .03)
        ys, xs = np.nonzero(a[..., 3])
        # Locate the dense head silhouette, excluding an outstretched weapon.
        top = ys.min() + (ys.max() - ys.min()) * .4
        hist = np.bincount(xs[ys <= top], minlength=a.shape[1])
        width = max(8, round((ys.max() - ys.min()) * .3))
        scores = np.convolve(hist, np.ones(width), 'valid')
        centers = np.arange(len(scores)) + width / 2
        expected = c * 384 + 192
        scores[np.abs(centers - expected) > (ys.max() - ys.min()) * .25] = -1
        left = int(np.argmax(scores))
        head_pixels = (ys <= top) & (xs >= left) & (xs < left + width)
        body_center = xs[head_pixels].mean()

        head = body_center if i >= 12 else xs[ys <= top].mean()
        radius = max(4, round((ys.max() - ys.min()) * .08))
        core = (xs >= body_center - radius) & (xs <= body_center + radius)
        rows = np.bincount(ys[core], minlength=a.shape[0])
        head_top = np.flatnonzero(rows >= max(4, round((ys.max() - ys.min()) / target * 4)))[0]
        # Match the actual walk/idle crown and face, not a central raised mace.
        # Normalize only for landmark search; preserve every original pixel.
        norm_scale = target / (np.median(reference_heights) if i >= 12 else ys.max() - head_top)
        box = (int(xs.min()) - 4, int(ys.min()) - 4, int(xs.max()) + 5, int(ys.max()) + 5)
        cropped = Image.fromarray(a).crop(box)
        norm = np.array(cropped.resize((round(cropped.width * norm_scale), round(cropped.height * norm_scale)), Image.Resampling.NEAREST))
        if i >= 12:
            ny, nx = SP.match_head(norm, head_refs)
            head_top = box[1] + ny / norm_scale
            head = box[0] + nx / norm_scale
        else:
            reference_heights.append(ys.max() - head_top)
            if i in (0, 4, 8):
                head_refs.append(SP.head_reference(norm))
        if xs.min() == 0 or xs.max() == a.shape[1] - 1 or ys.min() == 0 or ys.max() == a.shape[0] - 1:
            source_clip.append(i)
        cells.append((Image.fromarray(a), head_top, ys.max(), head))
    # The attack group can be drawn at a different scale too. Its central head
    # silhouette, NOT the raised weapon bounding box, sets that group's scale.
    scales = [target / np.median([c[2] - c[1] for c in cells[row:row + 4]])
              for row in range(0, 16, 4)]
    strip = Image.new('RGBA', (FW * 16, FH))
    frames = []
    for i, (im, y0, y1, head) in enumerate(cells):
        # Within-row drawing differences need a small isotropic landmark
        # correction too; changing only the median leaves unequal bodies.
        s_ = target / (y1 - y0)
        original_scale = s_
        best_frame, best_error = None, float('inf')
        ys_, xs_ = np.nonzero(np.array(im)[..., 3])
        # Recover wide attack capes without shrinking the body: the attack
        # pose may translate, but the walk anchor remains fixed. Never cut it.
        for attempt in range(17):
            # Explore subpixel raster phases after the first bounded correction;
            # multiplying rounded crop sizes alone can oscillate across 1px.
            if attempt >= 2:
                offset = ((attempt - 2) // 2 + 1) * .005
                s_ = original_scale * (1 + offset * (1 if attempt % 2 == 0 else -1))
            sx = head - AX / s_
            lower = xs_.max() - (FW - 4) / s_
            upper = xs_.min() - 3 / s_
            if lower <= upper:
                sx = min(upper, max(lower, sx))
            win = im.crop((round(sx), round(y1 - BASE / s_), round(sx + FW / s_), round(y1 - BASE / s_ + FH / s_)))
            frame = native(win, FW, FH)
            pixels = np.array(frame)
            feet = np.nonzero(pixels[..., 3])[0].max()
            if i >= 12:
                raster_refs = [SP.head_reference(np.array(frames[j])) for j in (0, 4, 8)]
                height = int(feet) - SP.body_top(pixels, reference=raster_refs) + 1
            else:
                height = int(feet) - SP.body_top(pixels, reference_pose=True) + 1
            error = abs(height - (target + 1.5))
            if error < best_error:
                best_frame, best_error = frame, error
            # Box filtering + outlining can move a landmark by one native
            # pixel. Correct the raster scale, never edit the QA expectation.
            if height in (target + 1, target + 2):
                break
            correction = (target + 1.5) / height
            if not .9 <= correction <= 1.1:
                break  # an ambiguous landmark needs review, not distortion
            s_ *= correction
            if not .9 <= s_ / original_scale <= 1.1:
                break
        frames.append(best_frame)
    # One common walk anchor, moved minimally if a cape needs more left room.
    # This translation (not scaling) keeps both silhouette and <=1px jitter.
    geometry = []
    for frame in frames[:8]:
        yy, xx = np.nonzero(np.array(frame)[..., 3])
        hx = xx[yy <= yy.min() + (yy.max() - yy.min()) * .4].mean()
        geometry.append((hx, xx.min(), xx.max()))
    walk_anchor = max(AX, max(hx - left + 2 for hx, left, right in geometry))
    for i, frame in enumerate(frames):
        if i < 8:
            aligned = Image.new('RGBA', frame.size)
            aligned.alpha_composite(frame, (round(walk_anchor - geometry[i][0]), 0))
            frame = aligned
        strip.alpha_composite(frame, (i * FW, 0))
    os.makedirs(f'{OUT}/heroes', exist_ok=True)
    strip.save(f'{OUT}/heroes/{name}.png')
    import hashlib
    meta_path = f'{OUT}/heroes.json'
    meta = json.load(open(meta_path))
    meta.setdefault('source_checks', {})[name] = dict(
        raw_sha256=raw_sha256,
        head_method='walk-idle-appearance-reference',
        strip_sha256=hashlib.sha256(open(f'{OUT}/heroes/{name}.png', 'rb').read()).hexdigest(),
        edge_clip_frames=source_clip, row_scales=[round(float(s), 6) for s in scales])
    json.dump(meta, open(meta_path, 'w'), indent=2)
    hx = []
    for i in range(8):
        a = np.array(strip.crop((i * FW, 0, (i + 1) * FW, FH)))[..., 3] > 0; ys, xs = np.nonzero(a)
        hx.append(xs[ys <= ys.min() + (ys.max() - ys.min()) * .4].mean())
    print(name, 'head_x_spread', round(float(np.ptp(hx)), 1))


def variants():
    """One strip per (class, model) used by the team: assets/px/heroes/<cls>-<Tag>.png"""
    import json as _j
    d = _j.load(open('data/replay.json'))
    MODELS = [('opus', 'Opus'), ('fable', 'Fable'), ('sonnet', 'Sonnet'), ('haiku', 'Haiku'), ('sol', 'Sol'), ('luna', 'Luna'),
              ('astra', 'Astra'), ('gemini', 'Gemini')]
    os.makedirs(f'{OUT}/heroes', exist_ok=True)
    done = set()
    for b in d['bots']:
        tag = next((t for k, t in MODELS if k in (b.get('model') or '').lower()), None)
        if not tag or (b['cls'], tag) in done or not os.path.exists(f'{OUT}/{b["cls"]}.png'):
            continue
        recolor(Image.open(f'{OUT}/{b["cls"]}.png').convert('RGBA'), THEMES[tag]).save(f'{OUT}/heroes/{b["cls"]}-{tag}.png')
        done.add((b['cls'], tag))
    print('variants', sorted(done))


def cutouts(kind, size_fn):
    meta = json.load(open(f'assets/{kind}/meta.json'))
    os.makedirs(f'{OUT}/{kind}', exist_ok=True)
    out = {}
    for n, m in meta.items():
        im = Image.open(f'assets/{kind}/{n}.png')
        if n in WATER_BASE:                          # drop sea water painted under docks (bottom 30%, blue-dominant)
            a = np.array(im.convert('RGBA')); h0 = int(a.shape[0] * .7); r, g, b = (a[h0:, :, i].astype(int) for i in range(3))
            a[h0:, :, 3][(b > r + 30) & (b > g)] = 0; im = Image.fromarray(a)
        w = size_fn(n)
        h = max(4, round(m['h'] * w / m['w']))
        native(im, w + 2, h + 2, colors=48, base=False).save(f'{OUT}/{kind}/{n}.png')
        out[n] = dict(w=w + 2, h=h + 2)
    json.dump(out, open(f'{OUT}/{kind}/meta.json', 'w'))
    print(kind, len(out))


def monsters():
    sheet = Image.open('assets/sprites/monsters.png').convert('RGBA')
    names = json.load(open('assets/sprites/monsters.json'))['names']
    size = {'goblin': 46, 'golem': 70, 'slime': 36, 'ghost': 46, 'bat': 40, 'skeleton': 50, 'dragon': 180, 'mimic': 42}
    os.makedirs(f'{OUT}/monsters', exist_ok=True)
    meta = {}
    for i, n in enumerate(names):
        cell = sheet.crop((i * 256, 0, (i + 1) * 256, 256))
        a = np.array(cell)[..., 3]; ys, xs = np.nonzero(a)
        cell = cell.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        h = size[n]; w = max(4, round(cell.width * h / cell.height))
        native(cell, w + 2, h + 2).save(f'{OUT}/monsters/{n}.png'); meta[n] = dict(w=w + 2, h=h + 2)
    json.dump(meta, open(f'{OUT}/monsters/meta.json', 'w'))
    print('monsters ok')


if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'heroes':
        heroes()
    elif what == 'heroes8':
        heroes8()
    elif what == 'combo':
        combo(sys.argv[2])
    elif what == 'variants':
        variants()
    elif what == 'monsters2':
        monsters2()
    elif what == 'lairs':
        lairs()
    elif what == 'monsters':
        monsters()
    elif what == 'buildings':
        W = {'castle': 340, 'forge': 210, 'treehouse': 230, 'tower': 150, 'observatory': 200, 'cathedral': 260, 'volcano': 290,
             'harbor': 270, 'inn': 210, 'vault': 210, 'fountain': 72, 'trees': 120}
        cutouts('buildings', lambda n: W.get(n, 60))
    elif what == 'props':
        Wp = {'lamp': 18, 'signpost': 30, 'fence': 72, 'barrels': 38, 'crates': 38, 'stall': 92, 'cart': 72, 'well': 54,
              'rock': 56, 'rocks': 40, 'bush': 38, 'flowers': 30, 'pine': 72, 'oak': 92, 'deadtree': 70, 'stump': 28,
              'tent': 92, 'campfire': 34, 'windmill': 130, 'field': 150, 'pillar': 30, 'banner': 26, 'rowboat': 74, 'lavarock': 42}
        cutouts('props', lambda n: Wp.get(n, 28))
