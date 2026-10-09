#!/usr/bin/env python3
"""Read-only QA of combo hero strips; Pillow/numpy are the pixelize dependencies.

Examples: qa_heroes.py --all --root /path/to/hermes-quest
          qa_heroes.py --names commander-Sol,mage-Haiku --root /path/to/repo
Exit 0: all PASS; 1: asset QA FAIL (including missing assets); 2: CLI/config error.
Body height measures feet to visually annotated anatomical crown, not the alpha
bounding box (reported separately). Every pose requires a visible crown/face
annotation bound to unchanged sheet pixels; absent/stale annotations fail closed.
Red crown, cyan face and blue anatomical head box make the semantic choice auditable.
Head x remains the walk top-40%
centroid for compatibility. Both body-height and walk-head spreads allow 1px.
Bleed uses full-resolution 8-connected alpha islands, so diagonal pixel-art
edges are connected. Visually reviewed staff ornaments, floating books and a
released arrow are exempt only by exact RGBA frame hash, action and component
geometry. Changed/unknown frames fail closed: proximity is not evidence of an
accessory. Approved ornaments remain reported as nearby_islands for JSON
compatibility, and every original pixel still counts in bbox/head. Any cell-edge touch
still FAILs, even an intentional cape/effect: clipping is not proof of a foreign
fragment. It never cleans/rescales the input to improve a score.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re

import numpy as np
from PIL import Image, ImageDraw

DEFAULT_OUTPUT = Path('../qa-out')  # Keep generated evidence outside the source tree.
# Fallback for worktrees without git-ignored assets/raw/combos.txt.
COMBOS = (
    'commander-Sol', 'engineer-Sol', 'engineer-Sonnet', 'mage-Sonnet',
    'paladin-Sol', 'paladin-Sonnet', 'ranger-Sol', 'ranger-Sonnet',
    'sage-Sonnet', 'warrior-Sol', 'warrior-Sonnet', 'mage-Gemini',
    'mage-Haiku', 'mage-Luna', 'paladin-Gemini', 'paladin-Opus',
    'ranger-Gemini', 'ranger-Haiku', 'sage-Gemini', 'sage-Luna', 'sage-Opus',
)


# Visually reviewed sage-Sonnet pendant, 20 alpha pixels at [69,51,73,57],
# idle frames 8/11. Hashes cover all original RGBA bytes, not just the ornament.
# A regenerated frame requires fresh visual calibration; never broaden by distance.
CALIBRATED_ORNAMENTS = {
    '50bb9132f712a5a9044b0ff2ee55e486e9a6096cc6ae01335a2e0bc223a86288':
        (8, 20, (69, 51, 73, 57)),
    'c79c64483bc4a951dfa93ab5f12bd3d60e6b6774289311e33123a152d9906c35':
        (11, 20, (69, 51, 73, 57)),
}


# Visually reviewed staff pendants, released arrow and floating books.
# Exact RGBA + action + component geometry; unknown/changed islands fail closed.
CALIBRATED_ACCESSORIES = {
    # Oracle-v1 isotropic sage-Opus reprocess: same floating books, visually
    # inspected in calibration/sage-Opus-paired.png (all16), no distance waiver.
    '0c42f05f824bc26374330a507f275749acaca5aba18fe0a8733cd0345b69350a': (5, 'walk', 201, (4, 41, 22, 59)),
    'f8c4bdce3041c36f18884444d734abce4a778c56a946460305e4ab7fdf9b9e13': (7, 'walk', 204, (5, 41, 23, 59)),
    '7c239e3156d583a2912b32f11e4a71ff7a832d850170edb17af9faa8c7da48b5': (12, 'atk', 265, (3, 43, 26, 59)),
    # R2 reprocessed pixels, independently inspected: pendant, arrow, book.
    '799c6860a1c3b620e96f3d443fc6b889c70e02e83fcdcf6eefe506040ef5cece': (7, 'walk', 20, (69, 49, 73, 55)),
    'e02f27535bcd1ab71fcf1555e3e3ab9dca79e8ff093027a853445cde83eb6a9c': (14, 'atk', 153, (90, 47, 118, 56)),
    'dc192f5b9d6e508d3545157809e5a070e3cd15be831dfdd06545bd35bb994ae4': (12, 'atk', 265, (3, 43, 26, 59)),
    'b26e88472e83efa7493ee854b61e354863f5234861a2a8b60587527a4dc2e2f7': (3, 'walk', 22, (69, 49, 74, 56)),
    'e78010ed88d3cfbe017bce4b730468853042fa526a1eaaf86317c834f30a1659': (6, 'walk', 18, (69, 49, 73, 55)),
    '71df891d0586becdebe107e33acabd9ff09e6442354c06e76db7065a39592b21': (7, 'walk', 18, (70, 49, 74, 55)),
    'b7e9c28a7b05082c2be2dd38eea9a70ef856b19a2701232ba8652156867d088f': (8, 'idle', 18, (70, 50, 74, 56)),
    'bbcbbe32eacf0ab20b589ad4ab37d2a83d86dbb5aaa5a2cd51a201c810c0c7a4': (14, 'atk', 154, (91, 47, 118, 56)),
    '0617337f4f268a4446612e52fd58236d98e8f958bad6e1ee76c62ad1c70b52e6': (5, 'walk', 230, (3, 40, 22, 59)),
    '06ba332791fcb64c42d7c598732cf7cf97eefe288984892ad7a318863f47fdeb': (7, 'walk', 235, (4, 40, 23, 60)),
    'c84b291030c87dc81f5eb33312cea979f9d8f316cb28954633882ba1180df1d0': (12, 'atk', 266, (3, 42, 26, 59)),
}


def components(mask):
    """Return size and exclusive bbox of each 8-connected opaque component."""
    h, w = mask.shape
    unseen = mask.copy()
    found = []
    for y, x in zip(*np.nonzero(mask)):
        if not unseen[y, x]:
            continue
        unseen[y, x] = False
        queue = [(int(y), int(x))]
        points = []
        size, x0, y0, x1, y1 = 0, int(x), int(y), int(x), int(y)
        while queue:
            cy, cx = queue.pop()
            points.append((cy, cx))
            size += 1
            x0, y0, x1, y1 = min(x0, cx), min(y0, cy), max(x1, cx), max(y1, cy)
            for ny in range(max(0, cy - 1), min(h, cy + 2)):
                for nx in range(max(0, cx - 1), min(w, cx + 2)):
                    if unseen[ny, nx]:
                        unseen[ny, nx] = False
                        queue.append((ny, nx))
        found.append({'pixels': size, 'bbox': [x0, y0, x1 + 1, y1 + 1], '_points': points})
    return sorted(found, key=lambda c: c['pixels'], reverse=True)


def annotation_mask(frame, runs, label):
    w, h = frame.size
    if not isinstance(runs, list) or not runs:
        raise ValueError(f'{label} mask required')
    mask = np.zeros((h, w), bool)
    for run in runs:
        if not isinstance(run, list) or len(run) != 3 or any(type(v) is not int for v in run):
            raise ValueError(f'invalid {label} run')
        y, x0, x1 = run
        if not (0 <= y < h and 0 <= x0 < x1 <= w) or mask[y, x0:x1].any():
            raise ValueError(f'{label} mask outside frame/overlapping')
        mask[y, x0:x1] = True
    if np.any(mask & (np.array(frame)[..., 3] == 0)):
        raise ValueError(f'{label} mask on transparent pixels')
    return mask


def anatomical_landmark(frame, annotation, index=None, action=None):
    """Measure explicit, visually reviewed cranial-cap/feet masks (oracle v1).

    Digests invalidate coordinates after edits; they never waive geometry gates.
    Structural validity is not semantic acceptance: independent visual review is
    required to reject a well-formed mask that incorrectly includes an accessory.
    """
    if not isinstance(annotation, dict) or annotation.get('status') != 'visible':
        raise ValueError('visible anatomical cap/face annotation required (unknown/occluded)')
    if index is not None and (type(annotation.get('frame')) is not int or annotation.get('frame') != index or annotation.get('action') != action):
        raise ValueError('anatomical frame/action mismatch')
    if annotation.get('frame_sha256') != hashlib.sha256(frame.tobytes()).hexdigest():
        raise ValueError('stale anatomical frame digest')
    if not isinstance(annotation.get('reason'), str) or not annotation['reason'].strip():
        raise ValueError('anatomical landmark reason required')
    cap = annotation_mask(frame, annotation.get('cap_mask'), 'cap')
    feet = annotation_mask(frame, annotation.get('feet_mask'), 'feet')
    yy, xx = np.nonzero(cap)
    crown_y, center = int(yy.min()), (int(xx.min()) + int(xx.max())) / 2
    point = annotation.get('crown_pixel')
    if (not isinstance(point, list) or len(point) != 2 or
            any(type(v) is not int for v in point)):
        raise ValueError('invalid anatomical crown_pixel')
    x, y = point
    if not (0 <= x < frame.width and 0 <= y < frame.height and cap[y, x] and y == crown_y):
        raise ValueError('crown_pixel does not match cap mask top')
    face = annotation.get('face_roi')
    if not isinstance(face, list) or len(face) != 4 or any(type(v) is not int for v in face):
        raise ValueError('visible face support ROI required')
    x0, y0, x1, y1 = face
    if not (0 <= x0 < x1 <= frame.width and crown_y < y0 < y1 <= frame.height):
        raise ValueError('invalid face support ROI')
    if not np.array(frame)[y0:y1, x0:x1, 3].any():
        raise ValueError('face support missing/occluded')
    feet_y = int(np.nonzero(feet)[0].max())
    if feet_y <= crown_y:
        raise ValueError('feet must be below cap')
    return crown_y, center, feet_y


def measure(frame, index, action, anchor=48, references=None, annotation=None):
    mask = np.array(frame)[..., 3] > 0
    ys, xs = np.nonzero(mask)
    parts = components(mask)
    # Fail closed for all unreviewed islands. A size/distance heuristic cannot
    # distinguish an ornament from nearby contamination. Exact frame matching
    # makes the two reviewed exceptions invalid after ANY pixel changes.
    reviewed = CALIBRATED_ORNAMENTS.get(hashlib.sha256(frame.tobytes()).hexdigest())
    accessory = CALIBRATED_ACCESSORIES.get(hashlib.sha256(frame.tobytes()).hexdigest())
    nearby, detached = [], []
    for part in parts:
        part.pop('_points')
    for part in parts[1:]:
        approved = (frame.size == (128, 96) and action == 'idle'
                    and reviewed == (index, part['pixels'], tuple(part['bbox'])))
        approved = approved or (frame.size == (128, 96) and accessory == (index, action, part['pixels'], tuple(part['bbox'])))
        (nearby if approved else detached).append(part)
    edge = bool(mask[0].any() or mask[-1].any() or mask[:, 0].any() or mask[:, -1].any())
    empty = not len(ys)
    bbox = None if empty else [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    head = None if empty else float(xs[ys <= ys.min() + (ys.max() - ys.min()) * .4].mean())
    center = None
    feet_y = None

    landmark_error = None
    try:
        if empty:
            raise ValueError('empty body')
        head_top, center, feet_y = anatomical_landmark(frame, annotation, index, action)
    except ValueError as exc:
        head_top = None
        landmark_error = str(exc)
    body_height = feet_y - head_top + 1 if head_top is not None else None
    return dict(frame=index, action=action, empty=empty, bbox=bbox,
                height=None if empty else bbox[3] - bbox[1], head_x=head,
                head_top=head_top, head_center=center, feet_y=feet_y, body_height=body_height, landmark_error=landmark_error,
                edge_touch=edge, components=parts, nearby_islands=nearby,
                detached_components=detached, neighbor_bleed=bool(detached), edge_clip=edge)


def contact_sheet(frames, metrics, meta, path, name):
    """Four columns, original frame order; each native pixel becomes exactly 4x4."""
    scale, cols, label = 4, 4, 24
    fw, fh = meta['fw'], meta['fh']
    tile_w, tile_h = fw * scale + 2, fh * scale + 2 + label
    sheet = Image.new('RGB', (cols * tile_w, 28 + ((len(frames) + cols - 1) // cols) * tile_h), '#181c26')
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 8), name + ' / native pixels x4 / walk 0-7, idle 8-11, atk 12-15', fill='white')
    for i, (frame, metric) in enumerate(zip(frames, metrics)):
        ox, oy = (i % cols) * tile_w, 28 + (i // cols) * tile_h
        bg = Image.new('RGBA', (fw, fh), '#343a46')
        bgdraw = ImageDraw.Draw(bg)
        for y in range(0, fh, 8):
            for x in range(0, fw, 8):
                if (x // 8 + y // 8) % 2:
                    bgdraw.rectangle((x, y, x + 7, y + 7), fill='#414957')
        bg.alpha_composite(frame)
        if metric['head_top'] is not None:
            bgdraw = ImageDraw.Draw(bg)
            annotation = metric.get('anatomical_annotation')
            if annotation:
                for y, x0, x1 in annotation['cap_mask']:
                    for x in (x0, x1 - 1): bgdraw.point((x,y), fill='#4488ff')
                x0,y0,x1,y1 = annotation['face_roi']
                bgdraw.rectangle((x0,y0,x1-1,y1-1), outline='#00ffff')
                for y,x0,x1 in annotation['feet_mask']:
                    bgdraw.line((x0,y,x1-1,y),fill='#66ff66')
                x,y = annotation['crown_pixel']
                bgdraw.line((x-2,y,x+2,y),fill='#ff3030')
                bgdraw.line((metric['head_center'], metric['head_top']+2, metric['head_center'], metric['head_top']+6), fill='#ffff00')
        sheet.paste(bg.convert('RGB').resize((fw * scale, fh * scale), Image.Resampling.NEAREST), (ox + 1, oy + 1))
        color = '#ff6868' if metric['neighbor_bleed'] or metric['edge_clip'] or metric['empty'] or metric['body_height'] is None else '#98a7bd'
        draw.rectangle((ox, oy, ox + fw * scale + 1, oy + fh * scale + 1), outline=color)
        # Anchor/feet ticks stay OUTSIDE the original pixels.
        ax, base = meta['ax'] * scale, meta['base'] * scale
        draw.line((ox + ax + 1, oy, ox + ax + 1, oy + 1), fill='#70d8ff')
        draw.point((ox, oy + base + 1), fill='#70d8ff')
        hx = '-' if metric['head_x'] is None else f"{metric['head_x']:.2f}"
        text = f"{i:02} {metric['action']} body={metric['body_height']} bbox={metric['height']} hx={hx} clip={int(metric['edge_clip'])}"
        if metric['body_height'] is None: text += ' UNKNOWN: annotation'
        draw.text((ox + 5, oy + fh * scale + 6), text, fill=color)
    sheet.save(path)


def inspect(name, root, output, meta):
    path = root / 'assets/px/heroes' / (name + '.png')
    result = dict(name=name, source=str(path), status='FAIL', reasons=[],
                  neighbor_bleed=None, edge_clip=None, body_height_spread=None, height_spread=None, head_x_spread=None,
                  contact_sheet=None, frames=[])
    try:
        payload = path.read_bytes()  # one snapshot while process_combos may be writing
        result['source_sha256'] = hashlib.sha256(payload).hexdigest()
        with Image.open(io.BytesIO(payload)) as im:
            strip = im.convert('RGBA')
        count = sum(len(meta[k]) for k in ('walk', 'idle', 'atk'))
        expected = (meta['fw'] * count, meta['fh'])
        if strip.size != expected:
            raise ValueError(f'sheet size {strip.size}, expected {expected}')
        actions = {i: k for k in ('walk', 'idle', 'atk') for i in meta[k]}
        frames = [strip.crop((i * meta['fw'], 0, (i + 1) * meta['fw'], meta['fh'])) for i in range(count)]
        calibration = meta.get('head_landmarks', {}).get(name)
        annotations = [None] * count
        if (isinstance(calibration, dict) and type(calibration.get('schema_version')) is int and calibration.get('schema_version') == 1 and
                calibration.get('name') == name and calibration.get('frame_size') == [meta['fw'], meta['fh']] and
                calibration.get('strip_sha256') == result['source_sha256'] and
                isinstance(calibration.get('frames'), list) and len(calibration['frames']) == count):
            annotations = calibration['frames']
        else:
            result['reasons'].append('missing/stale anatomical annotations: visual recalibration required')
        metrics = [measure(f, i, actions[i], meta['ax'], annotation=annotations[i]) for i, f in enumerate(frames)]
        for metric, annotation in zip(metrics, annotations):
            metric['anatomical_annotation'] = annotation
        source = meta.get('source_checks', {}).get(name)
        if source:
            if source.get('strip_sha256') != result['source_sha256']:
                result['reasons'].append('source-check hash mismatch: reprocess asset')
            else:
                indices = source.get('edge_clip_frames')
                if not isinstance(indices, list) or any(type(i) is not int or not 0 <= i < count for i in indices):
                    raise ValueError('invalid source edge_clip_frames')
                for i in indices:
                    metrics[i]['edge_clip'] = True
                    metrics[i]['source_edge_clip'] = True
        result['frames'] = metrics
        result['neighbor_bleed'] = sum(m['neighbor_bleed'] for m in metrics)
        result['edge_clip'] = sum(m['edge_clip'] for m in metrics)
        bodies = [m['body_height'] for m in metrics if m['body_height'] is not None]
        result['body_height_spread'] = max(bodies) - min(bodies) if len(bodies) == count else None
        heights = [m['height'] for m in metrics if not m['empty']]
        heads = [metrics[i]['head_x'] for i in meta['walk'] if not metrics[i]['empty']]
        result['height_spread'] = max(heights) - min(heights) if heights else None
        result['head_x_spread'] = round(max(heads) - min(heads), 1) if heads else None
        result['head_x_spread_unrounded'] = max(heads) - min(heads) if heads else None
        anatomical_heads = [metrics[i]['head_center'] for i in meta['walk'] if metrics[i]['head_center'] is not None]
        result['anatomical_head_x_spread'] = max(anatomical_heads) - min(anatomical_heads) if len(anatomical_heads) == len(meta['walk']) else None
        for m in metrics:
            if m['empty']:
                result['reasons'].append(f"empty frame {m['frame']}")
            if m['neighbor_bleed']:
                result['reasons'].append(f"frame {m['frame']}: neighbor_bleed ({len(m['detached_components'])} unreviewed islands)")
            if m['edge_clip']:
                result['reasons'].append(f"frame {m['frame']}: edge_clip")
            if m['body_height'] is None:
                result['reasons'].append(f"frame {m['frame']}: {m['landmark_error'] or 'head region missing'}")
        # Rounded head_x_spread is display-only; acceptance uses exact pixels.
        for key, value in (('body_height_spread', result['body_height_spread']),
                           ('anatomical_head_x_spread', result['anatomical_head_x_spread']),
                           ('head_x_spread', result['head_x_spread_unrounded'])):
            if value is not None and value > 1:
                result['reasons'].append(f'{key}={value} exceeds 1px')
        contact = output / (name + '-contact.png')
        contact_sheet(frames, metrics, meta, contact, name)
        result['contact_sheet'] = str(contact)
        result['status'] = 'FAIL' if result['reasons'] else 'PASS'
    except (OSError, ValueError) as exc:
        result['reasons'].append(str(exc))
    return result


def load_meta(root):
    meta = json.loads((root / 'assets/px/heroes.json').read_text())
    annotations = root / 'assets/px/head-landmarks.json'
    meta['head_landmarks'] = json.loads(annotations.read_text()) if annotations.exists() else {}
    if not isinstance(meta['head_landmarks'], dict):
        raise ValueError('head-landmarks.json: expected design map')
    for k in ('fw', 'fh', 'ax', 'base'):
        if type(meta.get(k)) is not int:
            raise ValueError(f'heroes.json: {k} must be an integer')
    if meta['fw'] <= 0 or meta['fh'] <= 0 or not (0 <= meta['ax'] < meta['fw'] and 0 <= meta['base'] < meta['fh']):
        raise ValueError('heroes.json: invalid frame dimensions/anchor')
    # Reject inconsistent metadata instead of silently skipping/reordering frames.
    for k, expected in (('walk', list(range(8))), ('idle', list(range(8, 12))), ('atk', list(range(12, 16)))):
        if meta.get(k) != expected:
            raise ValueError(f'heroes.json: {k} must be {expected} for combo strips')
    return meta


def self_test():
    """Adversarial geometry tests; run without any generated/private assets."""
    import unittest
    import pixelize
    import sprites

    class Geometry(unittest.TestCase):
        def landmark(self, f, index=12, action='atk', shift=0):
            return dict(status='visible', frame=index, action=action,
                        frame_sha256=hashlib.sha256(f.tobytes()).hexdigest(),
                        cap_mask=[[y,40+shift,57+shift] for y in range(30,38)],
                        crown_pixel=[48+shift,30], feet_mask=[[90,40+shift,57+shift]],
                        face_roi=[47+shift,38,56+shift,46], reason='synthetic compact cap/face and feet')

        def figure(self):
            a = np.zeros((96, 128, 4), np.uint8)
            a[30:91, 40:57] = (40, 70, 140, 255)
            a[38:46, 47:56] = (220, 180, 150, 255)
            return Image.fromarray(a)

        def test_raised_weapon_does_not_change_body_height(self):
            f = self.figure(); a = np.array(f)
            a[15:62, 75:86] = (170, 170, 180, 255)
            a[55:62, 56:86] = (170, 170, 180, 255)
            f = Image.fromarray(a)
            m = measure(f, 12, 'atk', annotation=self.landmark(f))
            self.assertEqual(m['body_height'], 61)
            self.assertEqual(m['height'], 76)
            self.assertFalse(m['neighbor_bleed'])

        def test_connected_central_overhead_weapon(self):
            f = self.figure(); a = np.array(f)
            a[15:30, 46:53] = (170, 170, 180, 255)
            reference = sprites.head_reference(np.array(f))
            f = Image.fromarray(a)
            m = measure(f, 13, 'atk', annotation=self.landmark(f,13))
            self.assertEqual(m['head_top'], 30)
            self.assertEqual(m['body_height'], 61)
            self.assertEqual(sprites.body_top(a, reference=reference), 30)
            self.assertIsNone(measure(Image.fromarray(a), 13, 'atk')['body_height'])
            with self.assertRaises(ValueError):
                sprites.body_top(a)

        def test_same_colour_overhead_weapon_not_head(self):
            f = self.figure(); a = np.array(f)
            a[15:30, 46:53] = (40, 70, 140, 255)
            f = Image.fromarray(a)
            m = measure(f, 13, 'atk', annotation=self.landmark(f,13))
            self.assertEqual(m['head_top'], 30)

        def test_missing_reference_fails_closed(self):
            a = np.array(self.figure()); a[15:32, 38:59] = (170, 170, 180, 255)
            m = measure(Image.fromarray(a), 13, 'atk')
            self.assertIsNone(m['body_height'])
            self.assertIn('annotation', m['landmark_error'])

        def test_competing_head_appearances_fail_closed(self):
            f = self.figure(); ref = sprites.head_reference(np.array(f))
            a = np.zeros((96, 128, 4), np.uint8)
            rh, rw = ref.shape[:2]
            a[10:10 + rh, 35:35 + rw] = ref
            a[40:40 + rh, 35:35 + rw] = ref
            with self.assertRaisesRegex(ValueError, 'competing'):
                sprites.match_head(a, [ref])
            self.assertIsNone(measure(Image.fromarray(a), 13, 'atk', references=[ref])['body_height'])

        def test_clip_is_not_bleed(self):
            a = np.array(self.figure()); a[60:65, :41] = (40, 70, 140, 255)
            m = measure(Image.fromarray(a), 13, 'atk')
            self.assertTrue(m['edge_clip']); self.assertFalse(m['neighbor_bleed'])
            a[4:8, 110:114] = (20, 255, 20, 255)
            self.assertTrue(measure(Image.fromarray(a), 13, 'atk')['neighbor_bleed'])

        def test_outline_does_not_wrap(self):
            f = Image.new('RGBA', (12, 12)); f.putpixel((0, 5), (100, 90, 80, 255))
            a = np.array(pixelize.outline(f, base=True))
            self.assertFalse(a[:, -1, 3].any()); self.assertEqual(a[5, 1, 3], 255)

        def test_unequal_rows_keep_complete_figures(self):
            alpha = np.zeros((160, 160), np.uint8)
            for y0, y1 in ((2, 39), (43, 82), (86, 111), (115, 155)):
                for c in range(4):
                    alpha[y0:y1, c * 40 + 8:c * 40 + 28] = 255
            masks = sprites.combo_row_bounds(alpha, masks=True, columns=4)
            self.assertEqual(len(masks), 16)
            self.assertTrue(np.array_equal(np.maximum.reduce(masks), alpha))
            for i, m in enumerate(masks):
                self.assertEqual(np.nonzero(m)[0].min(), (2, 43, 86, 115)[i // 4])

        def test_foreign_nearby_block_fails_closed(self):
            f = self.figure(); a = np.array(f); a[50:60, 59:67] = (0, 255, 0, 255)
            m = measure(Image.fromarray(a), 0, 'walk')
            self.assertTrue(m['neighbor_bleed']); self.assertFalse(m['edge_clip'])

        def check_head_spread_boundary(self, extra_pixel):
            import subprocess
            import sys
            import tempfile

            with tempfile.TemporaryDirectory(prefix='hero-head-boundary-') as tmp:
                root, output = Path(tmp) / 'root', Path(tmp) / 'inspect'
                (root / 'assets/px/heroes').mkdir(parents=True)
                output.mkdir()
                meta = dict(fw=128, fh=96, ax=48, base=91, walk=list(range(8)),
                            idle=list(range(8, 12)), atk=list(range(12, 16)))
                (root / 'assets/px/heroes.json').write_text(json.dumps(meta))
                original = np.array(self.figure())
                shifted = np.zeros_like(original)
                shifted[:, 1:] = original[:, :-1]
                if extra_pixel:
                    # Connected pixel: changes head centroid, not bleed/height.
                    shifted[32, 58] = (40, 70, 140, 255)
                strip = Image.new('RGBA', (128 * 16, 96))
                for i in range(16):
                    strip.paste(Image.fromarray(shifted if i == 1 else original), (128 * i, 0))
                strip.save(root / 'assets/px/heroes/probe-Sol.png')
                calibration = dict(schema_version=1,name='probe-Sol',frame_size=[128,96],
                    strip_sha256=hashlib.sha256((root / 'assets/px/heroes/probe-Sol.png').read_bytes()).hexdigest(),
                    frames=[self.landmark(strip.crop((128*i,0,128*(i+1),96)),i,
                        'walk' if i<8 else 'idle' if i<12 else 'atk',int(i==1)) for i in range(16)])
                meta['head_landmarks'] = {'probe-Sol':calibration}
                (root / 'assets/px/head-landmarks.json').write_text(json.dumps(meta['head_landmarks']))
                result = inspect('probe-Sol', root, output, meta)
                expected = 'FAIL' if extra_pixel else 'PASS'
                self.assertEqual(result['status'], expected)
                self.assertEqual(result['body_height_spread'], 0)
                self.assertEqual(result['neighbor_bleed'], 0)
                self.assertEqual(result['edge_clip'], 0)
                self.assertEqual(result['head_x_spread'], 1.0)
                if extra_pixel:
                    self.assertGreater(result['head_x_spread_unrounded'], 1)
                    self.assertLess(result['head_x_spread_unrounded'], 1.05)
                    self.assertEqual(result['reasons'], [
                        f"head_x_spread={result['head_x_spread_unrounded']} exceeds 1px"])
                else:
                    self.assertEqual(result['head_x_spread_unrounded'], 1)
                    self.assertEqual(result['reasons'], [])
                cli_output = Path(tmp) / 'cli'
                cli = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                      '--names', 'probe-Sol', '--root', str(root),
                                      '--output', str(cli_output)], capture_output=True, text=True)
                self.assertEqual(cli.returncode, int(extra_pixel), cli.stdout + cli.stderr)
                report = json.loads((cli_output / 'probe-Sol.json').read_text())
                self.assertEqual(report['status'], expected)
                self.assertEqual(report['reasons'], result['reasons'])
                self.assertEqual(report['head_x_spread_unrounded'], result['head_x_spread_unrounded'])

        def test_exact_one_pixel_head_spread_passes_inspect_and_cli(self):
            self.check_head_spread_boundary(extra_pixel=False)

        def test_slightly_over_one_pixel_head_spread_fails_inspect_and_cli(self):
            self.check_head_spread_boundary(extra_pixel=True)

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Geometry))
    return int(not result.wasSuccessful())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    select = parser.add_mutually_exclusive_group(required=True)
    select.add_argument('--names', help='comma-separated class-Model names')
    select.add_argument('--all', action='store_true', help='all 21 combos, including missing/unprocessed ones')
    select.add_argument('--self-test', action='store_true', help='run synthetic geometry/pipeline regression tests')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT, help='artifact directory outside repo')
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    root, output = args.root.resolve(), args.output.resolve()
    if output == root or root in output.parents:
        parser.error('--output must be outside --root (do not commit QA images)')
    try:
        if args.all:
            names = list(COMBOS)  # --all must never silently certify a partial raw list.
        else:
            names = args.names.split(',')
        names = list(dict.fromkeys(n.strip() for n in names if n.strip()))
        if not names or any(not re.fullmatch(r'[a-z]+-[A-Za-z]+', n) for n in names):
            raise ValueError('expected nonempty class-Model names, no paths')
        meta = load_meta(root)
        output.mkdir(parents=True, exist_ok=True)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    results = [inspect(n, root, output, meta) for n in names]
    summary = dict(root=str(root), meta=meta,
                   script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   thresholds=dict(neighbor_bleed=0, edge_clip=0, body_height_spread=1, head_x_spread=1, anatomical_head_x_spread=1), results=results)
    for result in results:
        (output / (result['name'] + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    table = ['name|bleed|clip|body_height_spread|head_x_spread|PASS/FAIL']
    table.extend(f"{r['name']}|{r['neighbor_bleed']}|{r['edge_clip']}|{r['body_height_spread']}|{r['head_x_spread']}|{r['status']}" for r in results)
    (output / 'summary.txt').write_text('\n'.join(table) + '\n')
    print('\n'.join(table))
    return int(any(r['status'] != 'PASS' for r in results))


if __name__ == '__main__':
    raise SystemExit(main())
