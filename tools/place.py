#!/usr/bin/env python3
"""Dress the world: buildings behind each plaza, region props on plaza rims, lamps along roads,
signposts at junctions, forests/rocks in open land, boats at sea. Writes world.json 'props'.
Rules keep roads and the battle area of each plaza clear, so walking and fighting never collide
with scenery. Props are y-sorted with characters in game.js (depth, nothing floats)."""
import json, math, os, random

random.seed(3)
w = json.load(open('data/world.json'))
bmeta = json.load(open('assets/buildings/meta.json'))
pmeta = json.load(open('assets/props/meta.json')) if os.path.exists('assets/props/meta.json') else {}
G = w['graph']; P = G['pts']
segs = [(P[a], P[b]) for a, b in G['edges'] + G.get('wild', [])]
props = []


def dseg(x, y):
    best = 1e9
    for A, B in segs:
        dx, dy = B[0] - A[0], B[1] - A[1]; L = dx * dx + dy * dy or 1
        t = max(0, min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L))
        best = min(best, math.hypot(x - A[0] - t * dx, y - A[1] - t * dy))
    return best


from PIL import Image
_g = Image.open('assets/raw/ground.png').convert('RGB').resize(tuple(w['size']))


def sea(x, y):                         # water = blue-dominant ground pixel
    r, g, b = _g.getpixel((min(w['size'][0] - 1, max(0, int(x))), min(w['size'][1] - 1, max(0, int(y)))))
    return b > 120 and b > r + 40 and b > g + 10


def in_plaza(x, y, pad=0):
    if any(math.hypot(x - l['spot'][0], (y - l['spot'][1]) * 1.5) < 120 + pad for l in w.get('lairs', {}).values()):
        return True
    return any(((x - r['spot'][0]) / (124 + pad)) ** 2 + ((y - r['spot'][1]) / (76 + pad)) ** 2 < 1 for r in w['regions'].values())


def free(x, y, r=26):
    return all(math.hypot(x - p['x'], (y - p['y']) * 1.3) > r for p in props)


def add(img, x, y, width, meta, **kw):
    m = meta[img]
    props.append(dict(img=img, src='buildings' if meta is bmeta else 'props', x=round(x), y=round(y),
                      w=round(width), h=round(m['h'] * width / m['w']), **kw))


B = {'castle': ('castle', 340), 'forge': ('forge', 210), 'forest': ('treehouse', 230), 'tower': ('tower', 150),
     'observatory': ('observatory', 200), 'citadel': ('cathedral', 260), 'volcano': ('volcano', 290),
     'port': ('harbor', 270), 'inn': ('inn', 210), 'vault': ('vault', 210)}
for k, (b, width) in B.items():
    x, y = w['regions'][k]['spot']
    add(b, x, y - 40, width, bmeta, region=k)          # building front stands on the plaza (ry 72): door opens onto it
# soften building bases: a few bushes/flowers on the front corners hide the straight cut line
if pmeta:
    for p0 in [p for p in props if p.get('region')]:
        for side, it in ((-1, 'bush'), (1, 'flowers'), (-.6, 'flowers'), (.65, 'bush')):
            if it in pmeta and not (p0['region'] == 'port' and side > 0):
                add(it, p0['x'] + side * p0['w'] * .46, p0['y'] + 4 + abs(side) * 2, 30 if it == 'bush' else 24, pmeta)
x, y = w['regions']['castle']['spot']
add('fountain', x + 96, y + 34, 72, bmeta)

if pmeta:
    RIM = {'castle': ['banner', 'stall', 'well', 'banner'], 'forge': ['barrels', 'crates', 'cart', 'barrels'],
           'forest': ['tent', 'campfire', 'flowers', 'bush'], 'tower': ['pillar', 'rocks', 'pillar'],
           'observatory': ['rocks', 'rock', 'pillar'], 'citadel': ['banner', 'flowers', 'banner'],
           'volcano': ['lavarock', 'deadtree', 'lavarock', 'rock'], 'port': ['crates', 'barrels', 'crates'],
           'inn': ['tent', 'campfire', 'cart', 'fence', 'barrels'], 'vault': ['banner', 'crates', 'banner']}
    SIZE = {'banner': 26, 'stall': 54, 'well': 34, 'barrels': 30, 'crates': 30, 'cart': 44, 'tent': 46, 'campfire': 24,
            'flowers': 28, 'bush': 28, 'pillar': 24, 'rocks': 26, 'rock': 34, 'lavarock': 30, 'deadtree': 44, 'fence': 50}
    for k, items in RIM.items():
        cx_, cy_ = w['regions'][k]['spot']
        for i, it in enumerate(items):        # rim arc on the sides/front, outside the battle grid
            a = math.radians([200, 340, 160, 20, 250, 290][i % 6])
            x, y = cx_ + math.cos(a) * 150, cy_ + math.sin(a) * 88 + 10
            if dseg(x, y) > 14 and not sea(x, y) and it in pmeta and free(x, y, 20):
                add(it, x, y, SIZE.get(it, 30), pmeta)
    # lamps every ~95px along roads, alternating sides, never in plazas
    for A, Bp in segs:
        L = math.dist(A, Bp); n = int(L // 130)
        nx, ny = (-(Bp[1] - A[1]) / (L or 1), (Bp[0] - A[0]) / (L or 1))
        for j in range(1, n + 1):
            t = j / (n + 1); side = 1 if j % 2 else -1
            x, y = A[0] + (Bp[0] - A[0]) * t + nx * 22 * side, A[1] + (Bp[1] - A[1]) * t + ny * 22 * side
            if not in_plaza(x, y, 10) and not sea(x, y) and free(x, y, 30) and 'lamp' in pmeta:
                add('lamp', x, y, 14, pmeta)
    deg = {}
    for a, b in G['edges']:
        deg[a] = deg.get(a, 0) + 1; deg[b] = deg.get(b, 0) + 1
    for n, d in deg.items():
        if d >= 3 and n in G['pts'] and n not in w['regions'] and 'signpost' in pmeta:
            x, y = P[n][0] + 30, P[n][1] - 22
            if not in_plaza(x, y, 10) and free(x, y, 20):
                add('signpost', x, y, 20, pmeta)
    # farms near inn and forge outskirts
    for (x, y) in [(150, 930), (210, 820), (630, 1200), (120, 1200)]:
        if dseg(x, y) > 50 and free(x, y, 60) and 'field' in pmeta:
            add('field', x, y, 90, pmeta)
    if 'windmill' in pmeta and free(80, 1010, 70):
        add('windmill', 80, 1010, 130, pmeta)
    # boats at sea
    for (x, y) in [(1660, 1060), (1860, 920), (1570, 1240)]:
        if sea(x, y) and 'rowboat' in pmeta:
            add('rowboat', x, y, 40, pmeta)

# wilderness: forests by area flavour, rocks and bushes; keep roads and plazas clear
MAXFILL = 170 if not pmeta else 300   # ground already paints dense forest; props add depth, not clutter
for _ in range(2600):
    if sum(p['img'] in ('trees', 'pine', 'oak', 'bush', 'rocks', 'rock', 'stump', 'flowers', 'deadtree', 'lavarock') for p in props) >= MAXFILL:
        break
    x, y = random.uniform(10, w['size'][0] - 10), random.uniform(40, w['size'][1] - 6)
    if dseg(x, y) < 44 or sea(x, y) or in_plaza(x, y, 50) or not free(x, y, 40):
        continue
    near_volcano = math.dist((x, y), w['regions']['volcano']['spot']) < 300
    near_forest = math.dist((x, y), w['regions']['forest']['spot']) < 340
    if pmeta:
        pool = (['deadtree', 'lavarock', 'rock'] if near_volcano else ['pine', 'pine', 'oak', 'bush', 'flowers'] if near_forest
                else ['pine', 'oak', 'oak', 'bush', 'bush', 'rocks', 'rock', 'stump', 'flowers'])
        it = random.choice(pool)
        size = {'pine': 72, 'oak': 92, 'deadtree': 70, 'bush': 38, 'flowers': 30, 'rocks': 40, 'rock': 56, 'stump': 28,
                'lavarock': 42}[it] * random.uniform(.85, 1.25)
        if it in pmeta:
            add(it, x, y, size, pmeta)
    elif not near_volcano:
        add('trees', x, y, random.uniform(48, 78), bmeta)

if os.path.exists('assets/px/lairs/meta.json'):
    lmeta = json.load(open('assets/px/lairs/meta.json'))
    for key, l in w.get('lairs', {}).items():
        if l['img'] in lmeta:
            m = lmeta[l['img']]; props.append(dict(img=l['img'], src='lairs', x=l['spot'][0], y=l['spot'][1] - 20, w=m['w'], h=m['h'], lair=key))
w['props'] = props; w['bg'] = 'assets/raw/ground.png'; w['layered'] = True
json.dump(w, open('data/world.json', 'w'), ensure_ascii=False)
print('props', len(props), {k: sum(p['img'] == k for p in props) for k in sorted({p['img'] for p in props})})
