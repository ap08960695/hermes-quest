#!/usr/bin/env python3
"""Render a side-by-side walk GIF: old 4-frame (head not anchored) vs new 8-frame, same distance-driven stepping."""
import json, sys
from PIL import Image
S = sys.argv[1]
old = Image.open(S + '/px-walk4/warrior.png'); new = Image.open('assets/px/warrior.png')
ground = Image.open('assets/px/ground.png').crop((560, 650, 1000, 760))
frames = []
STRIDE, V, FPS = 24, 70, 30
for i in range(90):
    dist = V * i / FPS
    f = ground.copy().convert('RGBA')
    for row, (sheet, n) in enumerate(((old, 4), (new, 8))):
        k = int(dist // (STRIDE * 2 / n)) % n
        bob = (2 if k % (n // 2) == 1 else -1 if k % (n // 2) == n // 4 + 1 else 0)
        x = int(20 + dist) % 400
        cell = sheet.crop((k * 128, 0, (k + 1) * 128, 96))
        f.alpha_composite(cell, (x - 48, row * 48 - 40 + bob))
    frames.append(f.convert('RGB').resize((880, 220), Image.NEAREST))
pal = frames[0].quantize(200)
frames[0].quantize(palette=pal).save('preview/walk-compare.gif', save_all=True,
    append_images=[f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames[1:]], duration=1000 // FPS, loop=0)
print('ok')
