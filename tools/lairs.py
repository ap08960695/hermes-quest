#!/usr/bin/env python3
"""Add monster lairs + war camp to the world: wild nodes, dirt trails to the nearest road node (graph 'wild'
edges, used by monsters only), and lair props. Heroes never route over 'wild' edges.
Run before tools/terrain.py (trails are painted) and tools/place.py (keeps trees off trails)."""
import json, math, sys

import numpy as np
from PIL import Image

w = json.load(open('data/world.json'))
G = w['graph']; P = G['pts']
if sys.argv[1:] == ['--preserve']:
    # Additive region work must not relocate existing lairs or change wild routing.
    for key, lair in w['lairs'].items():
        if P[key] != lair['spot'] or [key, lair['road']] not in G['wild']:
            raise SystemExit(f'inconsistent existing lair: {key}')
    print('existing lairs and wild trails preserved'); sys.exit(0)
g = np.array(Image.open('assets/raw/ground.png').convert('RGB').resize(tuple(w['size']))).astype(int)


def water(x, y):
    r, gg, b = g[int(min(max(y, 0), w['size'][1] - 1)), int(min(max(x, 0), w['size'][0] - 1))]
    return b > 115 and b > r + 35 and b > gg + 5 and y > w['size'][1] * .42


def dseg(x, y):
    best = 1e9
    for a, b in G['edges']:
        A, B = P[a], P[b]; dx, dy = B[0] - A[0], B[1] - A[1]; L = dx * dx + dy * dy or 1
        t = max(0, min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L))
        best = min(best, math.hypot(x - A[0] - t * dx, y - A[1] - t * dy))
    return best


def ok(x, y):
    if water(x, y) or dseg(x, y) < 120:
        return False
    if any(math.hypot(x - r['spot'][0], y - r['spot'][1]) < 260 for r in w['regions'].values()):
        return False
    return not any(water(x + dx, y + dy) for dx in (-90, 0, 90) for dy in (-60, 0, 60))


def settle(x, y):
    """Nearest acceptable land spot (spiral search)."""
    for r in range(0, 400, 12):
        for a in range(0, 360, 15):
            cx, cy = x + r * math.cos(math.radians(a)), y + r * math.sin(math.radians(a))
            if 60 < cx < w['size'][0] - 60 and 90 < cy < w['size'][1] - 40 and ok(cx, cy):
                return [round(cx), round(cy)]
    raise SystemExit(f'no spot near {x},{y}')


WANT = {'lair_cave': (1880, 380, 'cave', 'DARK CAVE · ถ้ำมืด'), 'lair_ruins': (1120, 120, 'ruins', 'RUINED GATE · ประตูมิติ'),
        'lair_swamp': (460, 1200, 'swamp', 'SWAMP · หนองพิษ'), 'camp': (800, 1200, 'camp', 'MONSTER CAMP · ค่ายมอนสเตอร์')}
road_nodes = {k: v for k, v in P.items() if not k.startswith(('lair_', 'camp'))}
G['wild'] = []
w['lairs'] = {}
for key, (x, y, img, label) in WANT.items():
    p = settle(x, y)
    P[key] = p
    near = min(road_nodes, key=lambda n: math.dist(road_nodes[n], p))
    G['wild'].append([key, near])
    w['lairs'][key] = dict(spot=p, img=img, label=label, road=near)
G['edges'] = [e for e in G['edges'] if not any(n.startswith(('lair_', 'camp')) for n in e)]
json.dump(w, open('data/world.json', 'w'), ensure_ascii=False)
print({k: (v['spot'], v['road']) for k, v in w['lairs'].items()})
