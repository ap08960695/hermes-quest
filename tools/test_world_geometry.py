#!/usr/bin/env python3
"""Independent geometry/pixel gates for scale C, with destructive mutations.

Run python3 tools/test_world_geometry.py [--masks <dir>]. Missing evidence is
generated without touching candidate assets; explicit masks are checked as-is.
Also discoverable: python3 -m unittest tools.test_world_geometry
No imports from the composer: road/ellipse checks use actual sprite alpha pixels
and analytic segment distances; exported masks are verified against those facts.
"""
import argparse
from copy import deepcopy
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MASKS = ROOT / 'preview/world-c'
SIZES = dict(forge=(186, 162), harbor=(238, 207), castle=(299, 281),
             treehouse=(203, 199), tower=(133, 169), observatory=(177, 155),
             cathedral=(229, 218), volcano=(256, 221), inn=(186, 154), vault=(186, 151))


def git_bytes(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT)


def ellipse_at(x, y, center, radii):
    return ((x-center[0])/radii[0])**2 + ((y-center[1])/radii[1])**2 <= 1


def distance_squared(x, y, a, b):
    vx, vy = b[0]-a[0], b[1]-a[1]
    projection = np.clip(((x-a[0])*vx+(y-a[1])*vy)/(vx*vx+vy*vy or 1), 0, 1)
    return (x-a[0]-projection*vx)**2 + (y-a[1]-projection*vy)**2


def image_for(prop):
    return Image.open(ROOT / 'assets/px' / prop.get('src', 'buildings') / (prop['img']+'.png')).convert('RGBA')


def platform_mask(world):
    im = Image.new('1', tuple(world['size'])); draw = ImageDraw.Draw(im)
    for p in world['platforms']:
        assert p['kind'] in ('quay', 'bridge', 'culvert'), 'Unknown platform kind'
        assert all(0 <= x < world['size'][0] and 0 <= y < world['size'][1] for x, y in p['polygon'])
        draw.polygon([tuple(v) for v in p['polygon']], fill=1)
    return np.asarray(im, bool)


def assert_geometry(world, water, compare_masks=False):
    width, height = world['size']; pts = world['graph']['pts']
    assert {k for k,r in world['regions'].items() if 'plaza' in r} == {'forge','port','castle'}, 'Missing expanded plaza'
    assert len(world['regions']['rest_inn']['rest_spots']) == 7
    assert len({tuple(p) for p in world['regions']['rest_inn']['rest_spots']}) == 7
    assert [width, height] == [2304, 1536]
    edges = world['graph']['edges']; wild = world['graph']['wild']
    assert len({tuple(sorted(e)) for e in edges+wild}) == len(edges+wild), 'Duplicate edge'
    assert all(a != b and a in pts and b in pts for a, b in edges+wild), 'Dangling graph edge'
    assert all(0 <= x < width and 0 <= y < height for x, y in pts.values()), 'Graph out of bounds'
    seen = {'castle'}
    while True:
        reached = seen | {b for a, b in edges+wild if a in seen} | {a for a, b in edges+wild if b in seen}
        if reached == seen:
            break
        seen = reached
    assert seen == set(pts), 'Disconnected graph'
    deck = platform_mask(world)
    allowed = deck | ~water
    yy, xx = np.indices((height, width))
    road = np.zeros((height, width), bool); trails = road.copy(); standing = road.copy()
    painted = road.copy(); arrival = road.copy(); major = road.copy()
    for links, radius, field in ((edges, 13, road), (wild, 7, trails)):
        for a, b in links:
            # Independently evaluate the analytic polyline envelope by scanline.
            left, right = max(0,min(pts[a][0],pts[b][0])-radius), min(width,max(pts[a][0],pts[b][0])+radius+1)
            top, bottom = max(0,min(pts[a][1],pts[b][1])-radius), min(height,max(pts[a][1],pts[b][1])+radius+1)
            field[top:bottom,left:right] |= distance_squared(xx[top:bottom,left:right], yy[top:bottom,left:right], pts[a], pts[b]) <= radius**2
    for key, r in world['regions'].items():
        assert r['node'] in pts and r['spot'] == pts[r['node']], 'Arrival anchor changed meaning'
        p = r.get('plaza')
        if p:
            assert key in ('forge', 'port', 'castle')
            assert p['painted'] == [240, 144] and p['standing'] == [224, 132], 'Wrong plaza radii'
            assert p['center'] == pts[p['node']] and [key, p['node']] in edges, 'Missing entry spur'
            assert math.dist(p['center'], [r['spot'][0],r['spot'][1]+124]) <= 128, 'Plaza beyond seed allowance'
            px, py = p['center']; rx, ry = p['painted']
            assert 0 <= px-rx and px+rx < width and 0 <= py-ry and py+ry < height, 'Plaza out of bounds'
            area = ellipse_at(xx, yy, p['center'], p['painted']); major |= area; painted |= area
            standing |= ellipse_at(xx, yy, p['center'], p['standing'])
        else:
            painted |= ellipse_at(xx, yy, r['spot'], [120,72])
        if key == 'rest_inn':
            for point in [r['spot'], *r['rest_spots'], r['portal']['spot']]:
                arrival |= ellipse_at(xx, yy, point, [8,8])
        else:
            arrival |= ellipse_at(xx, yy, r['spot'], [112,66])
    protected = road | trails | major | arrival
    assert not np.any(protected & ~allowed), 'Road/plaza/arrival on unsupported water'
    solid = np.zeros((height, width), bool)
    for i, prop in enumerate(world['props']):
        im = image_for(prop); alpha = np.asarray(im)[:,:,3] > 0
        assert (prop['w'], prop['h']) == im.size, f'Wrong actual PNG dimensions: {i}'
        left, top = prop['x']-im.width//2, prop['y']-im.height+1
        assert left >= 0 and top >= 0 and left+im.width <= width and top+im.height <= height, f'Prop out of bounds: {i}'
        area = (slice(top,top+im.height),slice(left,left+im.width))
        assert not np.any(alpha & protected[area]), f'Visible sprite blocks a road/plaza/rest spot: {i}'
        contact = alpha.copy()
        if prop.get('src') == 'props':
            contact[:-6] = False  # foliage overhang is not a ground-contact collision
        if prop['img'] != 'rowboat':
            assert not np.any(contact & ~allowed[area]), f'Land contact on water: {i}'
        solid[area] |= alpha
    walkable = (road | trails | painted | arrival) & allowed & ~solid
    if compare_masks:
        expected = dict(road=road, wild=trails, painted=painted, standing=standing,
                        arrival=arrival, water=water, platform=deck, solid=solid, walkable=walkable)
        for name, field in expected.items():
            im = Image.open(MASKS / (name+'.png'))
            assert im.size == (width,height), f'Mask dimensions wrong: {name}'
            assert np.array_equal(np.asarray(im)>0,field), f'Exported mask is stale/wrong: {name}'
        assert np.all(walkable[standing]), 'Standing mask contains non-walkable pixels'
    return dict(road_overlap_px=int(np.sum(solid & (road|trails))), standing_area_px=int(standing.sum()),
                nodes=len(pts), edges=len(edges), props=len(world['props']))


class WorldGeometry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global MASKS
        # CI discovery has no preview artifacts. Generate only evidence in a
        # scratch directory, never rewrite candidate pixels to make a gate pass.
        if not (MASKS/'ground.png').exists():
            cls.generated = tempfile.TemporaryDirectory(prefix='world-geometry-')
            MASKS = Path(cls.generated.name)
            subprocess.run([sys.executable,str(ROOT/'tools/compose_world_px.py'),
                            '--evidence-only','--output',str(MASKS)],check=True,cwd=ROOT)
            cls.addClassCleanup(cls.generated.cleanup)
        cls.world = json.loads((ROOT/'data/world.json').read_text())
        cls.ref = cls.world['composition']['source_revision']
        cls.base = json.loads(git_bytes(cls.ref, 'data/world.json'))
        original = Image.open(io.BytesIO(git_bytes(cls.ref,'assets/px/ground.png'))).convert('RGB')
        rgb = np.asarray(original.resize(tuple(cls.world['size']),Image.Resampling.NEAREST)).astype('int16')
        y = np.arange(rgb.shape[0])[:,None]
        cls.water = (rgb[:,:,2]>115) & (rgb[:,:,2]>rgb[:,:,0]+35) & (rgb[:,:,2]>rgb[:,:,1]+5) & (y>rgb.shape[0]*.42)

    def test_actual_geometry_and_exported_masks(self):
        print('geometry:', json.dumps(assert_geometry(self.world,self.water,True), sort_keys=True))
        with Image.open(ROOT/'assets/px/ground.png') as actual, Image.open(MASKS/'ground.png') as expected:
            self.assertTrue(np.array_equal(np.asarray(actual.convert('RGB')),np.asarray(expected.convert('RGB'))),
                            'Candidate ground differs from processed-only composition')

    def test_no_prop_loss_and_bounded_documented_relocations(self):
        before, after = self.base['props'], self.world['props']
        self.assertEqual(len(before),len(after))
        documented = {p['index']:p for p in self.world['composition']['relocations']}
        moved = set()
        for i,(p,q) in enumerate(zip(before,after)):
            self.assertEqual((p['img'],p['src']),(q['img'],q['src']))
            for key in set(p)-{'x','y','w','h'}:
                self.assertEqual(p[key],q[key])
            seed = [math.floor(p[k]*9/8+.5) for k in ('x','y')]; final = [q['x'],q['y']]
            d = math.dist(seed,final)
            self.assertLessEqual(d,128)
            if d:
                moved.add(i)
                self.assertEqual(documented[i]['seed'],seed)
                self.assertEqual(documented[i]['after'],final)
                self.assertAlmostEqual(documented[i]['distance'],d,delta=.00051)
        self.assertEqual(moved,set(documented))
        for key, lair in self.base['lairs'].items():
            self.assertEqual(self.world['lairs'][key]['spot'],[math.floor(v*9/8+.5) for v in lair['spot']])
        self.assertEqual(self.world['regions']['rest_inn']['rest_spots'],
                         [[math.floor(v*9/8+.5) for v in p] for p in self.base['regions']['rest_inn']['rest_spots']])
        self.assertEqual(self.world['regions']['rest_inn']['portal']['spot'],
                         [math.floor(v*9/8+.5) for v in self.base['regions']['rest_inn']['portal']['spot']])
        for change in self.world['composition']['region_adjustments']:
            r = change['region']; seed = [math.floor(v*9/8+.5) for v in self.base['regions'][r]['spot']]
            self.assertEqual(seed,change['seed'])
            self.assertLessEqual(math.hypot(*change['delta']),128)
            self.assertEqual(self.world['regions'][r]['spot'],[seed[i]+change['delta'][i] for i in range(2)])

    def test_buildings_nearest_neighbor_and_asset_caps(self):
        meta = json.loads((ROOT/'assets/px/buildings/meta.json').read_text())
        for name,size in SIZES.items():
            before = Image.open(io.BytesIO(git_bytes(self.ref,f'assets/px/buildings/{name}.png'))).convert('RGBA')
            after = Image.open(ROOT/f'assets/px/buildings/{name}.png').convert('RGBA')
            self.assertEqual(after.size,size)
            self.assertEqual(meta[name],dict(w=size[0],h=size[1]))
            self.assertTrue(np.array_equal(np.asarray(after),np.asarray(before.resize(size,Image.Resampling.NEAREST))))
        for name in ('fountain','trees'):
            self.assertEqual((ROOT/f'assets/px/buildings/{name}.png').read_bytes(),git_bytes(self.ref,f'assets/px/buildings/{name}.png'))
        with Image.open(ROOT/'assets/px/ground.png') as ground:
            self.assertEqual(ground.size,(2304,1536))
        for path in (ROOT/'assets/px').rglob('*.png'):
            self.assertLessEqual(path.stat().st_size,4*1024*1024,str(path.relative_to(ROOT)))

    def test_mutations_reject_disconnected_graph_wrong_radius_and_blocked_rest(self):
        for mutation in ('graph','radii','rest','road','quay'):
            w = deepcopy(self.world)
            if mutation == 'graph':
                w['graph']['edges'] = [e for e in w['graph']['edges'] if 'forge_plaza' not in e]
            elif mutation == 'radii':
                w['regions']['castle']['plaza']['standing'] = [225,132]
            elif mutation == 'rest':
                fire = next(p for p in w['props'] if p['img']=='campfire')
                fire['x'],fire['y'] = w['regions']['rest_inn']['rest_spots'][0]
            elif mutation == 'road':
                w['graph']['pts']['plaza_w'] = [w['props'][0]['x'],w['props'][0]['y']-25]
            else:
                w['platforms'][0]['polygon'] = [[x+280,y] for x,y in w['platforms'][0]['polygon']]
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                assert_geometry(w,self.water)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--masks',type=Path,default=MASKS)
    args, remaining = parser.parse_known_args()
    MASKS = args.masks
    unittest.main(argv=[__file__,*remaining])
