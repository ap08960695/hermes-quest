#!/usr/bin/env python3
"""Check every road edge runs over road-coloured pixels of the world background (no wall walking)."""
import json
from PIL import Image
w = json.load(open('data/world.json')); im = Image.open('assets/raw/world-bg.png').convert('RGB')
def road(p):
    r, g, b = im.getpixel((int(p[0]), int(p[1])))
    return r > 150 and g > 140 and b > 100 and max(r, g, b) - min(r, g, b) < 90
bad = []
for a, b in w['edges']:
    A, B = w['nodes'][a], w['nodes'][b]
    pts = [(A[0] + (B[0] - A[0]) * i / 20, A[1] + (B[1] - A[1]) * i / 20) for i in range(21)]
    ok = sum(road(p) for p in pts) / len(pts)
    if ok < .6: bad.append((a, b, round(ok, 2)))
for n, p in w['nodes'].items():
    if not road(p): print('node off-road', n, p, im.getpixel(tuple(p)))
print('edges off-road (<60%):', bad)
