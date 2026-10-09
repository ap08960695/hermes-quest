# Anatomical hero QA (oracle v1)

`qa_heroes.py --all` always inspects all 21 designs. The compatibility walk
centroid gate remains unrounded <=1px. Independent cap-mask walk centers add
another <=1px gate; every visible pose must satisfy feet-to-cap height spread
<=1px. Missing/ambiguous/occluded poses produce null heights and FAIL, never a
spread computed from the remaining subset.

`assets/px/head-landmarks.json` maps design names to schema_version=1,
name, design_revision, strip_sha256 (PNG bytes), frame_size, semantic_definition,
excluded_parts, reviewer, evidence_reference and 16 ordered frames. Raw digest
is provenance where available, not a PASS exception. Each frame specifies
frame/action, frame_sha256 (native RGBA bytes), status, reason, cap_mask,
crown_pixel, feet_mask and face_roi. Masks use exclusive runs `[y,x0,x1]` in
native frame-local coordinates. Face ROI uses `[x0,y0,x1,y1]`.

QA validates bounds, opaque pixels, nonempty/nonoverlapping runs, frame/action,
visibility and digests. It derives crown=min cap y, center=(min cap x+max cap x)/2,
and feet=max annotated shoe y. A digest merely invalidates stale coordinates:
it does not exempt geometry or certify that a mask depicts a head. There is no
automatic head fallback. Cap/feet annotations must be independently reviewed
against original pixels; a structurally valid plume mask must be rejected.

Overlays: blue cap boundary, red crown pixel, yellow cap center, cyan face
support ROI, green feet. UNKNOWN poses are labeled/red-bordered. Original
pixels remain unchanged for bleed, edge-clip, bbox and legacy centroid checks.

Semantic rule: compact hair/fitted cranial cap over the visible face, excluding
plume, ponytail, horns/prongs, free hair strands, weapon and FX. Never infer a
hidden crown using an eye offset. Never move a mask boundary to meet a gate.

Candidate: all 21 designs now have 16 developer-traced visible cap/foot masks.
Gemini has a new compact helmet design; 16 other designs use bounded isotropic
native reprocessing (full pixels and masks use the same nearest-neighbour affine).
The remaining four strips are unchanged. Paired before/after/unmarked/overlay
sheets and enlarged head crops are delivered outside the repository. Numeric
QA is 21/21; independent semantic Tester/Reviewer acceptance remains pending.
No structurally valid annotation, digest or numeric PASS certifies head identity.

`normalize_heroes.py` writes proposals outside the repository only. It requires
current visible annotations, preserves complete silhouette extents, limits scale
to 0.9–1.1 and jointly satisfies the unchanged legacy/anatomical walk gates.
An optional design-size target preserves wide silhouettes; it is not a new QA
threshold. It fails closed when no uncropped isotropic proposal exists. Pixel
changes invalidate previous reviews and require output semantic revalidation.

Cap masks exclude accessory outlines as well as accessory colours: projected
brim, hat prong, staff/orb and goggle rims/lenses are not cranial tissue. R3
corrects all 16 frames of mage Gemini/Haiku/Luna/Sonnet and engineer Sol/Sonnet.
`tools/fixtures/head-accessory-exclusions.json` records developer-traced native
negative masks; the real-strip regression rejects reinstating those pixels and
checks retained crowns and freshly derived centers. These fixtures do not
replace independent semantic review. Corrected Gemini/Haiku/Sonnet walk gates
required the existing uncropped full-frame isotropic reprocessor, not moved
annotation boundaries or weakened thresholds.

Regression commands (use an interpreter with numpy/Pillow):

    /usr/bin/python3 tools/qa_heroes.py --self-test
    /usr/bin/python3 -m unittest discover -s tools -p test_head_landmarks.py -v
    /usr/bin/python3 tools/qa_heroes.py --all --output /path/outside/repository

Adversarial fixtures distinguish cap drift from static plume/crest/ponytail,
check height/center exact1 vs2 at CLI+JSON level, reject missing/stale/occluded
annotations and preserve the previous geometry/centroid boundary tests.
