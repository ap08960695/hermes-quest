#!/usr/bin/env python3
"""Compose the ground from terrain tiles (no single painted backdrop).

1. Cut assets/raw/terrain.png (6x4 cells of 256px) and box-downscale each to a 32x32 true-pixel tile.
2. Build a native 768x512 terrain class map from the world layout: roads (graph edges), plazas,
   coastline (water mask), volcano ash zone, northern snow, forest floor; low-frequency noise makes
   borders organic instead of straight.
3. Paint each native pixel from its class tile (tiled), mix grass variants by noise, add 1px curbs
   on road/plaza edges and a foam line on the shore. Writes assets/px/ground.png.
"""
import json, sys

import numpy as np
from PIL import Image

NW, NH, T = 2048, 1365, 64     # must equal data/world.json size
NAMES = ['grass', 'grass_dark', 'grass_flowers', 'forest', 'dirt', 'cobble', 'flagstone', 'sand', 'shallow', 'deep',
         'ash', 'lava', 'snow', 'snowgrass', 'planks', 'cliff', 'farm', 'gravel', 'moss', 'drygrass', 'tallgrass',
         'clover', 'mud', 'pebbles']
rng = np.random.default_rng(11)


def tiles():
    sheet = Image.open('assets/raw/terrain.png').convert('RGB').resize((1536, 1024), Image.LANCZOS)
    out = {}
    for i, n in enumerate(NAMES):
        r, c = divmod(i, 6)
        cell = sheet.crop((c * 256 + 40, r * 256 + 40, (c + 1) * 256 - 24, (r + 1) * 256 - 24))   # skip borders + any label text
        t = cell.resize((T, T), Image.BOX).quantize(24, dither=Image.Dither.NONE).convert('RGB')
        out[n] = np.array(t)
    return out


def noise(scale, seed):
    r = np.random.default_rng(seed)
    g = r.random((NH // scale + 2, NW // scale + 2))
    img = Image.fromarray((g * 255).astype('uint8')).resize(((NW // scale + 2) * scale, (NH // scale + 2) * scale), Image.BICUBIC)
    return np.array(img)[:NH, :NW] / 255.0


def main():
    w = json.load(open('data/world.json'))
    G = w['graph']; P = {k: np.array(v, float) for k, v in G['pts'].items()}
    yy, xx = np.mgrid[0:NH, 0:NW].astype(float)
    n1, n2, n3 = noise(48, 1), noise(18, 2), noise(96, 3)

    def dist_seg(a, b):
        d = b - a; L = max((d ** 2).sum(), 1)
        t = np.clip(((xx - a[0]) * d[0] + (yy - a[1]) * d[1]) / L, 0, 1)
        return np.hypot(xx - a[0] - t * d[0], yy - a[1] - t * d[1])

    droad = np.min([dist_seg(P[a], P[b]) for a, b in G['edges']], axis=0) + (n2 - .5) * 4.0
    plaza = np.zeros((NH, NW), bool)
    for k, r in w['regions'].items():
        cx, cy = np.array(r['spot'], float)
        plaza |= ((xx - cx) / 120) ** 2 + ((yy - cy) / 72) ** 2 + (n2 - .5) * .25 < 1
    g = np.array(Image.open('assets/raw/ground.png').convert('RGB').resize((NW, NH), Image.BOX)).astype(int)
    water = (g[..., 2] > 115) & (g[..., 2] > g[..., 0] + 35) & (g[..., 2] > g[..., 1] + 5) & (yy > NH * .42)   # snow is bluish too
    water = np.array(Image.fromarray((water * 255).astype('uint8')).filter(__import__('PIL.ImageFilter', fromlist=['x']).ModeFilter(13))) > 128
    deep = water & (np.array(Image.fromarray((water * 255).astype('uint8')).filter(
        __import__('PIL.ImageFilter', fromlist=['x']).MinFilter(29))) > 128)
    vx, vy = np.array(w['regions']['volcano']['spot'], float)
    dv = np.hypot(xx - vx, (yy - vy) * 1.3) + (n1 - .5) * 80
    fx, fy = np.array(w['regions']['forest']['spot'], float)
    df = np.hypot(xx - fx, yy - fy) + (n1 - .5) * 100

    cls = np.full((NH, NW), 'grass', dtype=object)
    grassy = n3
    cls[grassy > .62] = 'grass_dark'; cls[(grassy < .3)] = 'clover'; cls[(n2 > .8) & (grassy < .55)] = 'grass_flowers'
    cls[(n1 > .7) & (yy > NH * .7)] = 'drygrass'
    cls[(df < 210) & (n2 > .45)] = 'grass_dark'; cls[(df < 210) & (n2 > .7)] = 'tallgrass'; cls[(df < 140) & (n2 < .3)] = 'moss'
    snow = yy + (n1 - .5) * 60 < 140
    cls[snow & (xx < NW * .62)] = 'snowgrass'; cls[(yy + (n1 - .5) * 60 < 90) & (xx < NW * .62)] = 'snow'
    cls[dv < 240] = 'ash'; cls[(dv < 210) & (n2 > .72)] = 'lava'
    shore = (~water) & (np.array(Image.fromarray((water * 255).astype('uint8')).filter(
        __import__('PIL.ImageFilter', fromlist=['x']).MaxFilter(17))) > 128)
    cls[shore] = 'sand'
    cls[water] = 'shallow'; cls[deep] = 'deep'
    # monster trails (wild edges): narrow dirt paths with ragged edges, lair grounds
    for a, b in G.get('wild', []):
        dt_ = dist_seg(P[a], P[b]) + (n2 - .5) * 5
        cls[(dt_ < 7) & ~water] = 'dirt'
    for key, l in w.get('lairs', {}).items():
        lx, ly = l['spot']; dl = np.hypot(xx - lx, (yy - ly) * 1.5) + (n1 - .5) * 40
        ground = {'cave': 'gravel', 'ruins': 'moss', 'swamp': 'mud', 'camp': 'dirt'}[l['img']]
        cls[(dl < 95) & ~water] = ground
    edge = (droad < 13) & (droad >= 9) & ~water
    cls[edge] = 'dirt'
    cls[(droad < 9) & ~water] = 'cobble'
    cls[plaza & ~water] = 'flagstone'
    # pier from the port plaza into the sea
    px, py = np.array(w['regions']['port']['spot'], float)
    cls[(xx > px + 100) & (xx < px + 230) & (np.abs(yy - py - 10) < 12)] = 'planks'
    # farms west of the inn
    ix, iy = np.array(w['regions']['inn']['spot'], float)
    cls[(np.abs(xx - (ix - 120)) < 52) & (np.abs(yy - (iy - 72)) < 24) & (droad > 20)] = 'farm'

    tl = tiles()
    out = np.zeros((NH, NW, 3), 'uint8')
    for name in set(cls.ravel()):
        m = cls == name
        t = tl[name]
        out[m] = t[(yy[m].astype(int)) % T, (xx[m].astype(int)) % T]
    # 1px curbs: darken the outermost pixel of road/plaza and a foam pixel at the shore
    hard = np.isin(cls, ['cobble', 'flagstone'])
    border = hard & ~(np.roll(hard, 1, 0) & np.roll(hard, -1, 0) & np.roll(hard, 1, 1) & np.roll(hard, -1, 1))
    out[border] = (out[border] * .72).astype('uint8')
    foam = water & ~(np.roll(water, 1, 0) & np.roll(water, -1, 0) & np.roll(water, 1, 1) & np.roll(water, -1, 1))
    out[foam] = (225, 240, 245)
    Image.fromarray(out).save('assets/px/ground.png')
    json.dump({'classes': sorted(set(cls.ravel()))}, open('assets/px/ground.json', 'w'))
    print('ground ok', sorted(set(cls.ravel())))


def rest_ground():
    """Paint only the new inn/road using processed terrain, never reroll the map."""
    from pathlib import Path
    w = json.load(open('data/world.json'))
    ground = Image.open('assets/px/ground.png').convert('RGB')
    out = np.array(ground)
    yy, xx = np.mgrid[0:ground.height, 0:ground.width]
    pts = w['graph']['pts']
    def distance(a, b):
        ax, ay = pts[a]; bx, by = pts[b]; dx, dy = bx - ax, by - ay
        t = np.clip(((xx - ax) * dx + (yy - ay) * dy) / max(1, dx * dx + dy * dy), 0, 1)
        return np.hypot(xx - ax - t * dx, yy - ay - t * dy)
    x, y = w['regions']['rest_inn']['spot']
    spur = [(a, b) for a, b in w['graph']['edges']
            if a.startswith('rest_') or b.startswith('rest_')]
    road = np.minimum.reduce([distance(a, b) for a, b in spur])
    plaza = ((xx - x) / 90) ** 2 + ((yy - y) / 60) ** 2 < 1
    # Preserve ALL old paved roads/plazas, including the junction at vault.
    protected = np.zeros(xx.shape, bool)
    for a, b in w['graph']['edges'] + w['graph'].get('wild', []):
        if not (a.startswith('rest_') or b.startswith('rest_')):
            protected |= distance(a, b) < 15
    for key, r in w['regions'].items():
        if key != 'rest_inn':
            rx, ry = r['spot']; protected |= ((xx - rx) / 125) ** 2 + ((yy - ry) / 77) ** 2 < 1
    outdir = Path('assets/px/regions'); outdir.mkdir(exist_ok=True)
    # Sample untouched native tiles once; retain them for repeatable additive builds.
    for name, box in [('rest_cobble', (668, 1018, 732, 1026)),
                      ('rest_flagstone', (944, 631, 1008, 695))]:
        p = outdir / f'{name}.png'
        if not p.exists(): ground.crop(box).save(p)
    mask = ((road < 13) | plaza) & ~protected
    # Dirt curb uses the existing brown road-edge palette; no new AI/raw dependency.
    out[mask] = ground.getpixel((700, 1033))
    for name, m in [('rest_cobble', (road < 9) & ~plaza), ('rest_flagstone', plaza)]:
        tile = np.array(Image.open(outdir / f'{name}.png').convert('RGB'))
        m = m & mask
        out[m] = tile[yy[m] % tile.shape[0], xx[m] % tile.shape[1]]
    edge = plaza & ~(np.roll(plaza, 1, 0) & np.roll(plaza, -1, 0) & np.roll(plaza, 1, 1) & np.roll(plaza, -1, 1))
    out[edge & mask] = (out[edge & mask] * .72).astype('uint8')
    assert np.array_equal(out[~mask], np.array(ground)[~mask]), 'ground changed outside rest mask'
    Image.fromarray(out).save('assets/px/ground.png')
    print('rest_inn terrain; additive mask pixels', int(mask.sum()))


if __name__ == '__main__':
    if sys.argv[1:] == ['--rest-inn']:
        rest_ground()
    else:
        main()
