#!/usr/bin/env python3
"""Bounded isotropic native reprocessing from explicit anatomical annotations.

Writes proposals outside the source tree. Never invents/adjusts mask boundaries;
cap and footwear masks undergo the identical nearest-neighbour affine as pixels.
Changed pixels require fresh visual review. Unsolvable walk gates fail closed.
"""
import argparse
import copy
import hashlib
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image
import qa_heroes as qa


def affine(image, scale, sx, sy, size=(128, 96)):
    return image.transform(size, Image.Transform.AFFINE,
                           (1 / scale, 0, sx, 0, 1 / scale, sy),
                           Image.Resampling.NEAREST)


def mask_runs(mask):
    result = []
    for y, row in enumerate(mask):
        xs = np.flatnonzero(row)
        for group in np.split(xs, np.flatnonzero(np.diff(xs) > 1) + 1):
            if len(group):
                result.append([y, int(group[0]), int(group[-1]) + 1])
    return result


def transformed(frame, annotation, scale, sx, sy):
    # All opaque source extents must fit with one-pixel safety margin. No crop
    # can be used to remove a high weapon or low cape/FX to improve the score.
    yy, xx = np.nonzero(np.array(frame)[..., 3])
    extents = ((xx.min() - sx) * scale, (xx.max() - sx) * scale,
               (yy.min() - sy) * scale, (yy.max() - sy) * scale)
    if not (1 <= extents[0] <= extents[1] < 127 and
            1 <= extents[2] <= extents[3] < 95):
        return None
    image = affine(frame, scale, sx, sy)
    a = copy.deepcopy(annotation)
    masks = []
    for key in ('cap_mask', 'feet_mask'):
        mask = qa.annotation_mask(frame, annotation[key], key)
        moved = np.array(affine(Image.fromarray(mask), scale, sx, sy), bool)
        if not moved.any():
            return None
        a[key] = mask_runs(moved)
        masks.append(moved)
    cap, feet = masks
    cy, cx = np.nonzero(cap)
    crown = int(cy.min())
    top = cx[cy == crown]
    a['crown_pixel'] = [int(top[len(top) // 2]), crown]
    a['anatomical_center_x'] = (int(cx.min()) + int(cx.max())) / 2
    a['feet_y'] = int(np.nonzero(feet)[0].max())
    a['face_roi'] = [round((v - (sx if j % 2 == 0 else sy)) * scale)
                     for j, v in enumerate(annotation['face_roi'])]
    a['frame_sha256'] = hashlib.sha256(image.tobytes()).hexdigest()
    a['reason'] += ' Identical isotropic affine applied to full pixels/cap/feet; output visual revalidation required.'
    a['raster_transform'] = dict(scale=scale, sx=sx, sy=sy)
    try:
        crown, center, foot = qa.anatomical_landmark(image, a, a['frame'], a['action'])
    except ValueError:
        return None
    yy, xx = np.nonzero(np.array(image)[..., 3])
    legacy = float(xx[yy <= yy.min() + (yy.max() - yy.min()) * .4].mean())
    return dict(image=image, annotation=a, height=foot - crown + 1,
                center=center, legacy=legacy,
                cost=abs(scale - 1) * 100 + abs(sx) * .01 + abs(sy) * .01)


def choose_walk(options):
    # Search both unchanged <=1px gates jointly, using exact unrounded centroids.
    # Each candidate lies in a one-pixel box. Find a box intersecting all poses.
    x_values = sorted({o['center'] for group in options for o in group})
    best = None
    for x in x_values:
        groups = [[o for o in group if x <= o['center'] <= x + 1] for group in options]
        if any(not group for group in groups):
            continue
        values = sorted({o['legacy'] for group in groups for o in group})
        for legacy in values:
            picked = []
            for group in groups:
                feasible = [o for o in group if legacy <= o['legacy'] <= legacy + 1]
                if not feasible:
                    break
                picked.append(min(feasible, key=lambda o: o['cost']))
            if len(picked) == 8:
                cost = sum(o['cost'] for o in picked)
                if best is None or cost < best[0]:
                    best = cost, picked
    return best[1] if best else None


def normalize(name, root, calibration, output, target_height=None):
    if not re.fullmatch(r'[a-z]+-[A-Za-z]+', name):
        raise ValueError('expected class-Model name, no paths')
    source = root / 'assets/px/heroes' / f'{name}.png'
    payload = source.read_bytes()
    c = copy.deepcopy(calibration)
    if c['strip_sha256'] != hashlib.sha256(payload).hexdigest():
        raise ValueError('stale strip digest')
    strip = Image.open(source).convert('RGBA')
    if strip.size != (2048, 96) or not isinstance(c.get('frames'), list) or len(c['frames']) != 16:
        raise ValueError('native 16-frame strip and complete ordered annotations required')
    frames = [strip.crop((i * 128, 0, (i + 1) * 128, 96)) for i in range(16)]
    metrics = [qa.measure(f, i, 'walk' if i < 8 else 'idle' if i < 12 else 'atk', annotation=a)
               for i, (f, a) in enumerate(zip(frames, c['frames']))]
    if len(metrics) != 16 or any(m['body_height'] is None for m in metrics):
        raise ValueError('all sixteen visible anatomical masks required')
    heights = [m['body_height'] for m in metrics]
    target = float(np.median(heights)) if target_height is None else float(target_height)
    if not np.isfinite(target) or target <= 0:
        raise ValueError('positive finite target height required')
    low = int(np.floor(target))
    options = []
    anchor = float(np.median([m['head_center'] for m in metrics[:8]]))
    for i, (f, a, m) in enumerate(zip(frames, c['frames'], metrics)):
        group = []
        ideal = target / m['body_height']
        # <=10% isotropic correction only; no local head warp or blank pixels.
        scales = sorted({1.0} | {ideal * (1 + j * .005) for j in range(-4, 5)}, key=lambda s: abs(s - 1))
        for scale in scales:
            if not .9 <= scale <= 1.1:
                continue
            cx = anchor if i < 8 else m['head_center']
            base_x = m['head_center'] - cx / scale
            base_y = m['feet_y'] - m['feet_y'] / scale
            for px in (-.4, 0, .4):
                for py in (-.4, 0, .4):
                    for dx in (-1, 0, 1) if i < 8 else (0,):
                        o = transformed(f, a, scale, base_x + px + dx, base_y + py)
                        if o and low <= o['height'] <= low + 1:
                            group.append(o)
        if not group:
            raise ValueError(f'frame {i}: no bounded isotropic proposal without cropping')
        options.append(group)
    walk = choose_walk(options[:8])
    if walk is None:
        raise ValueError('no jointly feasible anatomical/legacy walk alignment; inspect raw/redraw')
    picked = walk + [min(group, key=lambda o: o['cost']) for group in options[8:]]
    result = Image.new('RGBA', strip.size)
    for i, o in enumerate(picked):
        result.paste(o['image'], (i * 128, 0))
    path = output / f'{name}.png'
    result.save(path)
    c['frames'] = [o['annotation'] for o in picked]
    c['strip_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    c['design_revision'] = 'oracle-v1-isotropic-native-proposal'
    c['reviewer'] = 'developer proposal; output semantic review pending'
    c['input_strip_sha256'] = hashlib.sha256(payload).hexdigest()
    (output / f'{name}.json').write_text(json.dumps(c, indent=2) + '\n')
    return dict(name=name, target=target, heights=[o['height'] for o in picked],
                anatomical_walk_spread=max(o['center'] for o in walk)-min(o['center'] for o in walk),
                legacy_walk_spread=max(o['legacy'] for o in walk)-min(o['legacy'] for o in walk))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=Path.cwd())
    p.add_argument('--annotations', type=Path, required=True)
    p.add_argument('--names', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--target-height', type=float, help='Optional design size to preserve wide complete silhouettes; never a QA threshold')
    args = p.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    if output == root or root in output.parents:
        p.error('proposals must be outside repository')
    output.mkdir(parents=True, exist_ok=True)
    calibrations = json.loads(args.annotations.read_text())
    results = []
    for name in args.names.split(','):
        try:
            result = normalize(name, root, calibrations[name], output, args.target_height)
        except (OSError, ValueError, KeyError) as exc:
            result = dict(name=name, error=str(exc))
        results.append(result)
        print(json.dumps(result), flush=True)
    (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    return int(any('error' in r for r in results))


if __name__ == '__main__':
    raise SystemExit(main())
