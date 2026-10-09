#!/usr/bin/env python3
"""Compose scale C from processed pixels only; no generation or raw-sheet pipeline.

First build: python3 tools/compose_world_px.py --upgrade --source-ref <base>
Repeat build: python3 tools/compose_world_px.py
Masks/relocations/full-map evidence go to --output (default: preview/world-c).
The public base revision pins the original processed ground for repeatability.
"""
import argparse
from copy import deepcopy
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MAIN = ('forge', 'port', 'castle')
BUILDINGS = ('forge', 'harbor', 'castle', 'treehouse', 'tower', 'observatory',
             'cathedral', 'volcano', 'inn', 'vault')


def source_bytes(ref, path):
    if path != 'data/world.json' and not path.startswith('assets/px/'):
        raise ValueError('Only world data and processed pixels are permitted')
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT)


def rounded(v):
    return math.floor(v + .5)  # same native rounding as the canvas runtime


def scaled(point):
    return [rounded(v * 9 / 8) for v in point]


def ellipse(mask, center, radii):
    x, y = center; rx, ry = radii
    left, top = max(0, x-rx), max(0, y-ry)
    right, bottom = min(mask.shape[1], x+rx+1), min(mask.shape[0], y+ry+1)
    yy, xx = np.mgrid[top:bottom, left:right]
    mask[top:bottom, left:right] |= ((xx-x)/rx)**2 + ((yy-y)/ry)**2 <= 1


def segment(mask, a, b, radius):
    ax, ay = a; bx, by = b
    left = max(0, min(ax, bx)-radius); top = max(0, min(ay, by)-radius)
    right = min(mask.shape[1], max(ax, bx)+radius+1)
    bottom = min(mask.shape[0], max(ay, by)+radius+1)
    yy, xx = np.mgrid[top:bottom, left:right]
    dx, dy = bx-ax, by-ay
    t = np.clip(((xx-ax)*dx+(yy-ay)*dy)/max(1, dx*dx+dy*dy), 0, 1)
    mask[top:bottom, left:right] |= (xx-ax-t*dx)**2+(yy-ay-t*dy)**2 <= radius**2


def masks(world, ground):
    shape = (world['size'][1], world['size'][0])
    road, wild, painted, standing, arrival = [np.zeros(shape, bool) for _ in range(5)]
    pts = world['graph']['pts']
    for a, b in world['graph']['edges']:
        segment(road, pts[a], pts[b], 13)
    for a, b in world['graph'].get('wild', []):
        segment(wild, pts[a], pts[b], 7)
    for key, region in world['regions'].items():
        plaza = region.get('plaza', {})
        ellipse(painted, plaza.get('center', region['spot']), plaza.get('painted', [120, 72]))
        if key in MAIN:
            ellipse(standing, plaza['center'], plaza['standing'])
        # Keep the unchanged game's old arrival/standing area usable too.
        if key != 'rest_inn':
            ellipse(arrival, region['spot'], [112, 66])
        else:
            for point in [region['spot'], *region['rest_spots'], region['portal']['spot']]:
                ellipse(arrival, point, [8, 8])
    rgb = np.asarray(ground.convert('RGB')).astype('int16')
    yy = np.arange(shape[0])[:, None]
    water = ((rgb[:, :, 2] > 115) & (rgb[:, :, 2] > rgb[:, :, 0]+35)
             & (rgb[:, :, 2] > rgb[:, :, 1]+5) & (yy > shape[0]*.42))
    platform = Image.new('1', tuple(world['size']))
    draw = ImageDraw.Draw(platform)
    for item in world.get('platforms', []):
        draw.polygon([tuple(p) for p in item['polygon']], fill=1)
    return dict(road=road, wild=wild, painted=painted, standing=standing,
                arrival=arrival, water=water, platform=np.asarray(platform, bool))


def footprint(prop, pixels=None):
    path = ROOT / 'assets/px' / prop.get('src', 'buildings') / (prop['img']+'.png')
    im = (pixels[prop['img']] if pixels and prop.get('src') == 'buildings' and prop['img'] in pixels
          else Image.open(path)).convert('RGBA')
    return np.asarray(im)[:, :, 3] > 0


def placement(alpha, x, y, size):
    h, w = alpha.shape
    left, top = x-w//2, y-h+1
    if left < 0 or top < 0 or left+w > size[0] or top+h > size[1]:
        return None
    return (slice(top, top+h), slice(left, left+w))


def relocate(world, fields, seeds, pixels):
    # Entire visible alpha must clear all roads, expanded painted plazas and
    # legacy standing zones. Sea-going rowboats are not land obstacles.
    protected = fields['road'] | fields['wild'] | fields['standing'] | fields['arrival']
    for key in MAIN:
        p = world['regions'][key]['plaza']
        ellipse(protected, p['center'], p['painted'])
    reserved = np.zeros_like(protected)
    offsets = sorted(((x, y) for x in range(-128, 129, 8) for y in range(-128, 129, 8)
                      if x*x+y*y <= 128**2), key=lambda p: (p[0]**2+p[1]**2, p[1], p[0]))
    changes = []
    # Buildings/rest structures first, then solid props, then decorative plants.
    order = sorted(range(len(world['props'])), key=lambda i: (
        world['props'][i].get('src') not in ('buildings', 'regions', 'lairs'),
        world['props'][i]['img'] in ('flowers', 'bush'), i))
    for i in order:
        prop = world['props'][i]; alpha = footprint(prop, pixels)
        x, y = seeds[i]['x'], seeds[i]['y']
        boat = prop['img'] == 'rowboat'
        for dx, dy in offsets:
            area = placement(alpha, x+dx, y+dy, world['size'])
            if area is None:
                continue
            if np.any(alpha & protected[area]) or np.any(alpha & reserved[area]):
                continue
            land_contact = alpha.copy()
            if prop.get('src') == 'props':
                # Canopies can overhang water; ground contact cannot.
                land_contact[:-6] = False
            if not boat and np.any(land_contact & fields['water'][area] & ~fields['platform'][area]):
                continue
            prop['x'], prop['y'] = x+dx, y+dy
            # Decorative plants may share scenery, but not traversable ground.
            if prop.get('src') in ('buildings', 'regions', 'lairs'):
                reserved[area] |= alpha
            if dx or dy:
                changes.append(dict(index=i, img=prop['img'], seed=[x, y],
                                    after=[x+dx, y+dy], distance=round(math.hypot(dx, dy), 3)))
            break
        else:
            debug_pixels = np.zeros((*protected.shape, 3), dtype='uint8')
            debug_pixels[protected] = (150, 150, 150)
            debug_pixels[reserved] = (160, 50, 50)
            debug_pixels[fields['water'] & ~fields['platform']] = (20, 70, 170)
            debug = Image.fromarray(debug_pixels)
            im = Image.open(ROOT / 'assets/px' / prop.get('src', 'buildings') / (prop['img']+'.png')).convert('RGBA')
            debug.paste(im, (x-im.width//2, y-im.height+1), im)
            debug_dir = ROOT / 'preview/world-c'; debug_dir.mkdir(parents=True, exist_ok=True)
            debug.crop((max(0,x-300), max(0,y-300), min(world['size'][0],x+300), min(world['size'][1],y+200))).save(debug_dir/'placement-failure.png')
            raise ValueError(f'No placement within 128px for prop {i}: {prop["img"]} seed={x,y}')
    return changes


def bridge_polygon(a, b, pad=15):
    dx, dy = b[0]-a[0], b[1]-a[1]; length = math.hypot(dx, dy)
    nx, ny = -dy/length*pad, dx/length*pad
    ex, ey = dx/length*pad, dy/length*pad
    return [[rounded(x), rounded(y)] for x, y in (
        (a[0]-ex+nx, a[1]-ey+ny), (b[0]+ex+nx, b[1]+ey+ny),
        (b[0]+ex-nx, b[1]+ey-ny), (a[0]-ex-nx, a[1]-ey-ny))]


def upgrade(ref):
    ref = subprocess.check_output(['git', 'rev-parse', '--verify', ref+'^{commit}'], cwd=ROOT, text=True).strip()
    base = json.loads(source_bytes(ref, 'data/world.json'))
    world = deepcopy(base)
    world['size'] = [2304, 1536]
    world['bg'] = 'assets/px/ground.png'
    for name, point in world['graph']['pts'].items():
        world['graph']['pts'][name] = scaled(point)
    # Approach the camp from its open southern side, not through the roof.
    cx, cy = world['graph']['pts']['camp']
    world['graph']['pts']['camp_approach'] = [cx-160, cy+24]
    world['graph']['wild'] = [edge for edge in world['graph']['wild'] if 'camp' not in edge]
    world['graph']['wild'].extend([['camp', 'camp_approach'], ['camp_approach', 'bridge_v']])
    for region in world['regions'].values():
        region['spot'] = scaled(region['spot'])
        if 'rest_spots' in region:
            region['rest_spots'] = [scaled(p) for p in region['rest_spots']]
            region['portal']['spot'] = scaled(region['portal']['spot'])
    world['regions']['castle']['node'] = 'castle'
    world['regions']['observatory']['node'] = 'observatory'
    for lair in world['lairs'].values():
        lair['spot'] = scaled(lair['spot'])
    for prop in world['props']:
        prop['x'], prop['y'] = scaled([prop['x'], prop['y']])
    # Northern volcano was cropped; enlarged plazas reach the Inn and Vault.
    # Geometry-selected grid offsets retain region arrival anchors and all props.
    region_adjustments = []
    for key in ('volcano', 'inn', 'vault'):
        dx = -64 if key == 'inn' else 0
        region_adjustments.append(dict(region=key, seed=world['regions'][key]['spot'][:], delta=[dx, 64]))
        world['regions'][key]['spot'][0] += dx
        world['regions'][key]['spot'][1] += 64
        world['graph']['pts'][key][0] += dx
        world['graph']['pts'][key][1] += 64
        for prop in world['props']:
            if prop.get('region') == key:
                prop['x'] += dx
                prop['y'] += 64
    for key in MAIN:
        region = world['regions'][key]; x, y = region['spot']
        # Clear the southern trees/Inn/Vault without prop moves beyond 128px.
        offset = {'castle': 60, 'forge': 100, 'port': 124}[key]
        px = x-32 if key == 'castle' else x
        region['plaza'] = dict(center=[px, y+offset], painted=[240, 144], standing=[224, 132], node=key+'_plaza')
        world['graph']['pts'][key+'_plaza'] = [px, y+offset]
        world['graph']['edges'].append([key, key+'_plaza'])
    meta_path = ROOT / 'assets/px/buildings/meta.json'
    meta = json.loads(source_bytes(ref, 'assets/px/buildings/meta.json'))
    pixels = {}
    for name in BUILDINGS:
        im = Image.open(io.BytesIO(source_bytes(ref, f'assets/px/buildings/{name}.png')))
        size = (rounded(im.width*7/8), rounded(im.height*7/8))
        pixels[name] = im.resize(size, Image.Resampling.NEAREST)
        meta[name] = dict(w=size[0], h=size[1])
    for prop in world['props']:
        h, w = footprint(prop, pixels).shape
        prop['w'], prop['h'] = w, h
    ground = Image.open(io.BytesIO(source_bytes(ref, 'assets/px/ground.png'))).resize(tuple(world['size']), Image.Resampling.NEAREST)
    x, y = world['regions']['port']['plaza']['center']
    world['platforms'] = [dict(kind='quay', region='port', polygon=[
        [x-120, y-360], [x+120, y-360], [x+120, y-148], [x+244, y-148],
        [x+244, y+148], [x-244, y+148], [x-244, y-148], [x-120, y-148]]),
        # Cover the tiny existing water pocket at the Castle's western paving.
        dict(kind='culvert', region='castle', polygon=[[888, 824], [893, 824], [893, 830], [888, 830]])]
    fields = masks(world, ground)
    # Explicit bridge decks, including any water crossed by wild approaches.
    for a, b in world['graph']['edges'] + world['graph'].get('wild', []):
        test = np.zeros_like(fields['water'])
        segment(test, world['graph']['pts'][a], world['graph']['pts'][b], 13)
        if np.any(test & fields['water'] & ~fields['platform']):
            world['platforms'].append(dict(kind='bridge', edge=[a, b], polygon=bridge_polygon(
                world['graph']['pts'][a], world['graph']['pts'][b])))
    fields = masks(world, ground)
    seeds = deepcopy(world['props'])
    relocate(world, fields, seeds, pixels)
    changes = []
    for i, (before, after) in enumerate(zip(base['props'], world['props'])):
        seed = scaled([before['x'], before['y']])
        final = [after['x'], after['y']]
        distance = math.dist(seed, final)
        if distance > 128:
            raise ValueError(f'Combined region/prop displacement exceeds 128px: {i}')
        if distance:
            changes.append(dict(index=i, img=after['img'], seed=seed, after=final,
                                distance=round(distance, 3)))
    # No tracked files change until every proposed placement succeeds.
    for name, im in pixels.items():
        im.save(ROOT / f'assets/px/buildings/{name}.png')
    meta_path.write_text(json.dumps(meta, indent=2)+'\n')
    world['composition'] = dict(version=1, source_revision=ref, scale=[9, 8], building_scale=[7, 8],
                                prop_count=len(base['props']), region_adjustments=region_adjustments,
                                relocations=changes)
    (ROOT / 'data/world.json').write_text(json.dumps(world, ensure_ascii=False, indent=2)+'\n')
    return world


def tile_image(name, size):
    tile = Image.open(ROOT / 'assets/px/regions' / (name+'.png')).convert('RGB')
    out = Image.new('RGB', size)
    for y in range(0, size[1], tile.height):
        for x in range(0, size[0], tile.width):
            out.paste(tile, (x, y))
    return out


def compose(world, output, write_ground=True):
    output.mkdir(parents=True, exist_ok=True)
    original = source_bytes(world['composition']['source_revision'], 'assets/px/ground.png')
    ground = Image.open(io.BytesIO(original)).convert('RGB').resize(tuple(world['size']), Image.Resampling.NEAREST)
    fields = masks(world, ground)
    for tile, field in [('rest_flagstone', fields['platform']),
                        ('rest_cobble', fields['road'] | fields['wild']),
                        ('rest_flagstone', fields['painted'])]:
        # Water is never silently converted to land: a named platform is required.
        field = field & (~fields['water'] | fields['platform'])
        ground.paste(tile_image(tile, ground.size), (0, 0), Image.fromarray(field.astype('uint8')*255))
    generated_ground = output / 'ground.png'
    ground.save(generated_ground, optimize=True)
    if write_ground:
        (ROOT / 'assets/px/ground.png').write_bytes(generated_ground.read_bytes())
    fields['walkable'] = ((fields['road'] | fields['wild'] | fields['painted'] | fields['arrival'])
                          & (~fields['water'] | fields['platform']))
    solid = np.zeros_like(fields['walkable'])
    full = ground.convert('RGBA')
    for prop in sorted(world['props'], key=lambda p: p['y']):
        alpha = footprint(prop); area = placement(alpha, prop['x'], prop['y'], world['size'])
        if area is None:
            raise ValueError('Prop outside world')
        solid[area] |= alpha
        im = Image.open(ROOT / 'assets/px' / prop.get('src', 'buildings') / (prop['img']+'.png')).convert('RGBA')
        full.alpha_composite(im, (area[1].start, area[0].start))
    fields['solid'] = solid
    fields['walkable'] &= ~solid
    hashes = {}
    for name, field in fields.items():
        path = output / (name+'.png')
        Image.fromarray(field.astype('uint8')*255).save(path)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    full.convert('RGB').save(output / 'full-map.png', optimize=True)
    roads = sum(math.dist(world['graph']['pts'][a], world['graph']['pts'][b]) for a, b in world['graph']['edges'])
    report = dict(size=world['size'], road_length=round(roads, 3),
                  buildings={n: Image.open(ROOT / f'assets/px/buildings/{n}.png').size for n in BUILDINGS},
                  props=len(world['props']), relocations=world['composition']['relocations'], masks=hashes,
                  ground_sha256=hashlib.sha256(generated_ground.read_bytes()).hexdigest(),
                  source_processed_ground_sha256=hashlib.sha256(original).hexdigest())
    (output / 'geometry.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({k: report[k] for k in ('size', 'road_length', 'props', 'ground_sha256')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upgrade', action='store_true')
    parser.add_argument('--source-ref')
    parser.add_argument('--evidence-only', action='store_true', help='Generate masks/ground evidence without altering tracked assets')
    parser.add_argument('--output', type=Path, default=ROOT / 'preview/world-c')
    args = parser.parse_args()
    if args.upgrade and not args.source_ref:
        parser.error('--upgrade requires an explicit public base --source-ref')
    if args.upgrade and args.evidence_only:
        parser.error('--upgrade cannot be combined with --evidence-only')
    world = upgrade(args.source_ref) if args.upgrade else json.loads((ROOT / 'data/world.json').read_text())
    compose(world, args.output, write_ground=not args.evidence_only)


if __name__ == '__main__':
    main()
