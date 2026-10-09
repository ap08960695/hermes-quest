"""Normalization safety invariants, independent of production sprite annotations."""
import copy
import unittest

import numpy as np
from PIL import Image

import qa_heroes as qa
from normalize_heroes import affine, transformed
from test_head_landmarks import fixture


class NativeNormalization(unittest.TestCase):
    def test_pixels_and_masks_share_affine(self):
        frame, annotation = fixture(0)
        proposal = transformed(frame, annotation, .95, -.2, .3)
        self.assertIsNotNone(proposal)
        for key in ('cap_mask', 'feet_mask'):
            source = qa.annotation_mask(frame, annotation[key], key)
            expected = np.array(affine(Image.fromarray(source), .95, -.2, .3), bool)
            actual = qa.annotation_mask(proposal['image'], proposal['annotation'][key], key)
            np.testing.assert_array_equal(actual, expected)
        self.assertEqual(annotation, fixture(0)[1], 'source annotations must not mutate')
        self.assertEqual(proposal['image'].tobytes(), affine(frame, .95, -.2, .3).tobytes())

    def test_whole_silhouette_must_fit_not_just_head(self):
        frame, annotation = fixture(0)
        self.assertIsNone(transformed(frame, annotation, 1, 30, 15))
        self.assertIsNone(transformed(frame, annotation, 1, -80, 0))

    def test_mask_air_and_ambiguity_fail(self):
        frame, annotation = fixture(0)
        bad = copy.deepcopy(annotation)
        bad['cap_mask'] = [[1, 1, 3]]
        with self.assertRaises(ValueError):
            transformed(frame, bad, 1, 0, 0)
        bad = copy.deepcopy(annotation)
        bad['status'] = 'ambiguous'
        self.assertIsNone(transformed(frame, bad, 1, 0, 0))


if __name__ == '__main__':
    unittest.main()
