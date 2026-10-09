#!/usr/bin/env python3
"""Derive walkable roads from the world background and precompute region-to-region paths.

Road = light, low-saturation stone (grass is yellow-green with low blue). A* on an 8px grid with
cheap road cells and expensive off-road cells, so figures follow the painted roads and never
cut through walls, buildings or water. Writes paths into data/world.json and a mask preview.
"""
import heapq, json, math

import numpy as np
from PIL import Image

G = 8
w = json.load(open('data/world.json'))
img = np.array(Image.open('assets/raw/world-bg.png').convert('RGB')).astype(int)
R, Gc, B = img[..., 0], img[..., 1], img[..., 2]
# ponytail: colour threshold road detector; tune these if a new background uses other stone colours
road = (R > 165) & (Gc > 145) & (B > 115) & (R - B < 115) & (Gc - B < 90)
H, W = road.shape
gh, gw = H // G, W // G
cell = road[:gh * G, :gw * G].reshape(gh, G, gw, G).mean(axis=(1, 3)) > .35
cost = np.where(cell, 1.0, 30.0)
Image.fromarray((np.kron(cell, np.ones((G, G))) * 255).astype('uint8')).save('assets/road-mask.png')


def snap(p):
    x, y = int(p[0] // G), int(p[1] // G)
    best = None
    for r in range(0, 12):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                yy, xx = y + dy, x + dx
                if 0 <= yy < gh and 0 <= xx < gw and cell[yy, xx]:
                    d = dx * dx + dy * dy
                    if best is None or d < best[0]:
                        best = (d, (xx, yy))
        if best:
            return best[1]
    return (x, y)


def astar(a, b):
    openq, came, gs = [(0, a)], {a: None}, {a: 0}
    while openq:
        _, cur = heapq.heappop(openq)
        if cur == b:
            break
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            n = (cur[0] + dx, cur[1] + dy)
            if not (0 <= n[0] < gw and 0 <= n[1] < gh):
                continue
            g = gs[cur] + cost[n[1], n[0]] * (1.414 if dx and dy else 1)
            if g < gs.get(n, 1e18):
                gs[n], came[n] = g, cur
                heapq.heappush(openq, (g + math.dist(n, b), n))
    path, cur = [], b
    while cur:
        path.append(cur)
        cur = came.get(cur)
    return path[::-1]


def simplify(pts):
    """Drop collinear grid steps; keep corners so motion follows the road bends."""
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        d1 = (pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        d2 = (pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
        if d1 != d2:
            out.append(pts[i])
    out.append(pts[-1])
    return out


spots = {k: snap(v['spot']) for k, v in w['regions'].items()}
for k, s in spots.items():
    w['regions'][k]['spot'] = [s[0] * G + G // 2, s[1] * G + G // 2]
paths, offroad = {}, []
keys = list(spots)
for i, a in enumerate(keys):
    for b in keys[i + 1:]:
        p = astar(spots[a], spots[b])
        offroad.append((a, b, round(sum(not cell[y, x] for x, y in p) / len(p), 2)))
        paths[f'{a}|{b}'] = [[x * G + G // 2, y * G + G // 2] for x, y in simplify(p)]
w['paths'] = paths
w.pop('nodes', None); w.pop('edges', None)
json.dump(w, open('data/world.json', 'w'))
print('road cells', int(cell.sum()), 'of', cell.size)
print('worst off-road fraction', sorted(offroad, key=lambda t: -t[2])[:6])
