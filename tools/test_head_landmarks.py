"""Oracle-v1 adversarial controls. Synthetic pixels only; no private/raw assets."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image
import qa_heroes as qa


def fixture(index, crown_dy=0, dx=0, accessory='plume'):
    a = np.zeros((96,128,4), np.uint8)
    a[40:91,40:57] = (30,70,140,255)
    a[30+crown_dy:40+crown_dy,40+dx:57+dx] = (90,50,30,255)
    a[40:47,47:56] = (230,180,130,255)
    # Appendage remains at exactly the same height while the cap changes.
    if accessory == 'crest': a[15:35,34:40] = (20,150,190,255)
    elif accessory == 'ponytail': a[15:40,30:40] = (230,200,120,255)
    else: a[15:40,34:40] = (230,150,20,255)
    f = Image.fromarray(a)
    action = 'walk' if index<8 else 'idle' if index<12 else 'atk'
    annotation = dict(frame=index, action=action, status='visible',
        frame_sha256=hashlib.sha256(f.tobytes()).hexdigest(),
        cap_mask=[[y,40+dx,57+dx] for y in range(30+crown_dy,40+crown_dy)],
        crown_pixel=[48+dx,30+crown_dy], feet_mask=[[90,40,57]],
        face_roi=[47,40,56,47], reason='Brown compact cranial cap above face; rear appendage excluded.')
    return f, annotation


class AnatomicalQA(unittest.TestCase):
    def inspect_fixture(self, name='paladin-Sol', dy=0, dx=0, mutate=None, cli=False):
        kind={'paladin-Sol':'plume','paladin-Gemini':'crest','paladin-Opus':'ponytail'}.get(name,'plume')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'root'; out=Path(tmp)/'qa'; out.mkdir()
            (root/'assets/px/heroes').mkdir(parents=True)
            meta=dict(fw=128,fh=96,ax=48,base=91,walk=list(range(8)),idle=list(range(8,12)),atk=list(range(12,16)))
            (root/'assets/px/heroes.json').write_text(json.dumps(meta))
            strip=Image.new('RGBA',(2048,96)); annotations=[]
            for i in range(16):
                f,a=fixture(i,dy if i==1 else 0,dx if i==1 else 0,kind)
                strip.paste(f,(128*i,0));annotations.append(a)
            path=root/'assets/px/heroes'/f'{name}.png';strip.save(path)
            cal=dict(schema_version=1,name=name,frame_size=[128,96],strip_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),frames=annotations)
            if mutate: mutate(cal)
            meta['head_landmarks']={name:cal}
            (root/'assets/px/head-landmarks.json').write_text(json.dumps(meta['head_landmarks']))
            result=qa.inspect(name,root,out,meta)
            if cli:
                run=subprocess.run([sys.executable,str(Path(qa.__file__).resolve()),'--names',name,'--root',str(root),'--output',str(Path(tmp)/'cli')],capture_output=True,text=True)
                report=json.loads((Path(tmp)/'cli'/f'{name}.json').read_text())
                self.assertEqual(report['status'],result['status'])
                self.assertEqual(run.returncode,int(result['status']=='FAIL'),run.stderr)
            return result

    def test_three_false_green_regressions(self):
        for name in ('paladin-Sol','paladin-Gemini','paladin-Opus'):
            with self.subTest(name=name):
                stable=self.inspect_fixture(name,cli=True)
                changed=self.inspect_fixture(name,dy=2,cli=True)
                self.assertEqual(stable['body_height_spread'],0)
                self.assertEqual(stable['status'],'PASS')
                self.assertEqual(changed['body_height_spread'],2)
                self.assertEqual(changed['height_spread'],0)  # silhouette stays green
                self.assertIn('body_height_spread=2 exceeds 1px',changed['reasons'])

    def test_height_exact_one_and_two(self):
        self.assertEqual(self.inspect_fixture(dy=1,cli=True)['status'],'PASS')
        self.assertEqual(self.inspect_fixture(dy=2,cli=True)['status'],'FAIL')

    def test_anatomical_center_exact_one_and_two(self):
        self.assertEqual(self.inspect_fixture(dx=1,cli=True)['anatomical_head_x_spread'],1)
        r=self.inspect_fixture(dx=2,cli=True)
        self.assertEqual(r['anatomical_head_x_spread'],2)
        self.assertIn('anatomical_head_x_spread=2.0 exceeds 1px',r['reasons'])
        self.assertLessEqual(r['head_x_spread_unrounded'],1)  # legacy gate alone misses it

    def test_missing_stale_occluded_and_wrong_action_fail_closed(self):
        mutations=[lambda c:c['frames'].pop(),lambda c:c.update(strip_sha256='stale'),
                   lambda c:c['frames'][0].update(frame_sha256='stale'),
                   lambda c:c['frames'][0].update(status='occluded'),
                   lambda c:c['frames'][0].update(action='atk'),
                   lambda c:c['frames'][0].update(frame=1),
                   lambda c:c['frames'][0].update(cap_mask=[]),
                   lambda c:c['frames'][0].update(cap_mask=[[1,1,2]]),
                   lambda c:c['frames'][0].update(cap_mask=[[30,40,200]]),
                   lambda c:c['frames'][0].update(crown_pixel=[48,29]),
                   lambda c:c['frames'][0].update(feet_mask=[])]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                r=self.inspect_fixture(mutate=mutation,cli=True)
                self.assertEqual(r['status'],'FAIL')
                self.assertIsNone(r['body_height_spread'])
                self.assertTrue(r['reasons'])

    def test_real_accessory_outline_regressions(self):
        # This developer-traced negative annotation is geometric: shared
        # dark colours cannot make brim/staff/goggle outlines cranial tissue.
        root = Path(__file__).resolve().parents[1]
        controls = json.loads((root / 'tools/fixtures/head-accessory-exclusions.json').read_text())['designs']
        calibrations = json.loads((root / 'assets/px/head-landmarks.json').read_text())
        self.assertEqual(set(controls), {'mage-Gemini', 'mage-Haiku', 'mage-Luna',
                                        'mage-Sonnet', 'engineer-Sol', 'engineer-Sonnet'})
        for name, frames in controls.items():
            strip = Image.open(root / f'assets/px/heroes/{name}.png').convert('RGBA')
            self.assertEqual([c['frame'] for c in frames], list(range(16)))
            for control in frames:
                i = control['frame']
                with self.subTest(name=name, frame=i):
                    frame = strip.crop((128*i, 0, 128*(i+1), 96))
                    annotation = calibrations[name]['frames'][i]
                    cap = qa.annotation_mask(frame, annotation['cap_mask'], 'cap')
                    forbidden = qa.annotation_mask(frame, control['accessory_outline_runs'], 'accessory')
                    self.assertFalse(np.any(cap & forbidden), 'accessory outline included in cranial cap')
                    x, y = control['retained_crown_pixel']
                    self.assertTrue(cap[y, x], 'enclosing shell crown must remain visible')
                    _, center, _ = qa.anatomical_landmark(frame, annotation, i, annotation['action'])
                    self.assertEqual(annotation['anatomical_center_x'], center)

    def test_appendage_change_does_not_change_anatomy(self):
        f,a=fixture(12)
        pixels=np.array(f);pixels[12:30,34:40]=(30,160,190,255)
        changed=Image.fromarray(pixels); a=copy.deepcopy(a)
        a['frame_sha256']=hashlib.sha256(changed.tobytes()).hexdigest()
        before=qa.measure(f,12,'atk',annotation=fixture(12)[1])
        after=qa.measure(changed,12,'atk',annotation=a)
        self.assertEqual((before['body_height'],before['head_center']),(after['body_height'],after['head_center']))


if __name__=='__main__': unittest.main()
