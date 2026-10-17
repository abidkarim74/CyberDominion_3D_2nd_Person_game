"""Measure the playable model's neck geometry and sample its exported poses.

Run with Blender, not system Python:
  blender --background --threads 4 --python-exit-code 1 --python scripts/verify-person-anatomy.py

The checks detect discontinuities, extreme proportions and broken skinning.
Front/profile render inspection remains necessary to judge human appearance.
No model, rig, action or source file is saved by this verifier.
"""
from pathlib import Path
import argparse
import json
import math
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'artifacts' / 'blender' / 'person-anatomy-verification.json'
parser = argparse.ArgumentParser()
parser.add_argument('--blend', type=Path, default=ROOT / 'artifacts' / 'blender' / 'person-realistic.blend')
options = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
CLIPS = ('Idle', 'Walk', 'Run', 'Seated', 'EnterCar', 'ExitCar')
report = {'passed': False, 'checks': {}, 'limitations': [
    'Measurements detect geometry regressions; front and profile renders must also be inspected.',
    'Head width and neck transition are geometric proxies rather than anatomical landmark annotations.',
]}
failures = []


def points(obj, evaluated=False):
    owner = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()) if evaluated else obj
    mesh = owner.to_mesh() if evaluated else owner.data
    positions = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get('co', positions)
    positions = positions.reshape(-1, 3)
    matrix = np.asarray(owner.matrix_world, dtype=np.float64)
    result = positions @ matrix[:3, :3].T + matrix[:3, 3]
    if evaluated:
        owner.to_mesh_clear()
    return result


def edges(obj):
    result = np.empty(len(obj.data.edges) * 2, dtype=np.int32)
    obj.data.edges.foreach_get('vertices', result)
    return result.reshape(-1, 2)


def section(positions, connections, height):
    a, b = positions[connections[:, 0]], positions[connections[:, 1]]
    dz = b[:, 2] - a[:, 2]
    valid = ((a[:, 2] <= height) & (b[:, 2] >= height) |
             (b[:, 2] <= height) & (a[:, 2] >= height)) & (np.abs(dz) > 1e-8)
    a, b, dz = a[valid], b[valid], dz[valid]
    if not len(a):
        raise AssertionError(f'No mesh section at {height:.4f}m')
    t = (height - a[:, 2]) / dz
    return a + t[:, None] * (b - a)


def check(name, condition, measured):
    report['checks'][name] = measured
    if not condition:
        failures.append({'check': name, 'measured': measured})


try:
    bpy.ops.wm.open_mainfile(filepath=str(options.blend))
    scene = bpy.context.scene
    rig = bpy.data.objects['PersonRig']
    objects = [obj for obj in scene.objects if obj.type == 'MESH' and
               any(mod.type == 'ARMATURE' and mod.object == rig for mod in obj.modifiers)]
    head = next(obj for obj in objects if 'scanned bald adult' in obj.name)
    skin = next(obj for obj in objects if 'skin neck shoulders arms hands' in obj.name)
    actions = {action.name: action for action in bpy.data.actions if action.name in CLIPS}
    check('allGameplayClips', set(actions) == set(CLIPS), sorted(actions))
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    rig.animation_data.action = None
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()

    rest = {obj.name: points(obj) for obj in objects}
    connections = {obj.name: edges(obj) for obj in objects}
    hp = rest[head.name]
    sp = rest[skin.name]
    head_base, scalp = float(hp[:, 2].min()), float(hp[:, 2].max())
    all_points = np.concatenate(list(rest.values()))
    height = float(np.ptp(all_points[:, 2]))
    cranium = hp[hp[:, 2] > scalp - .16]
    head_width = float(np.ptp(cranium[:, 0]))
    # In rest pose the hands extend sideways; shoulder width is measured at
    # the actual arm-joint centres instead of using the T-pose mesh bounds.
    shoulder_width = float((rig.matrix_world @ rig.data.bones['mixamorig:LeftArm'].head_local -
                            rig.matrix_world @ rig.data.bones['mixamorig:RightArm'].head_local).length)
    check('adultHeadWidthRatio', 9.0 < height / head_width < 13.0,
          {'bodyHeightMeters': height, 'headWidthMeters': head_width,
           'bodyHeightPerHeadWidth': height / head_width,
           'shoulderCentreWidthPerHeadWidth': shoulder_width / head_width})

    # The head's lowest surface and the source neck must meet in position.
    # Surface distance handles different vertex densities on the two rings.
    skin_tree = BVHTree.FromPolygons([Vector(p) for p in sp],
                                     [tuple(poly.vertices) for poly in skin.data.polygons],
                                     all_triangles=False)
    seam = hp[hp[:, 2] < head_base + .0005]
    seam_distances = [skin_tree.find_nearest(Vector(p))[3] for p in seam]
    seam_max = max(seam_distances)
    check('neckSurfaceJoin', seam_max < .004,
          {'scanBaseMeters': head_base, 'samples': len(seam),
           'maximumSurfaceGapMeters': seam_max})

    # The first 30 mm above the join should remain a neck. A sudden 10+ mm
    # radial jump in a 2.5 mm slice exposes the old scan's shoulder shelf.
    slices = []
    for z in np.linspace(head_base + .001, head_base + .031, 13):
        ring = section(hp, connections[head.name], float(z))
        slices.append({'heightMeters': float(z), 'widthMeters': float(np.ptp(ring[:, 0])),
                       'depthMeters': float(np.ptp(ring[:, 1]))})
    width_steps = np.abs(np.diff([row['widthMeters'] for row in slices]))
    depth_steps = np.abs(np.diff([row['depthMeters'] for row in slices]))
    largest_step = float(max(width_steps.max(), depth_steps.max()))
    check('smoothLowerNeck', largest_step < .010,
          {'largestDiameterChangePer2_5mm': largest_step, 'sections': slices})

    # Locate the first widening or forward chin projection above the throat.
    # Width alone locates the cheeks on a narrow jaw, so the front contour is
    # also used. This remains a silhouette proxy, not an annotated chin.
    base_width = slices[0]['widthMeters']
    base_front = float(section(hp, connections[head.name], head_base + .001)[:, 1].min())
    transition = None
    for z in np.linspace(head_base + .002, min(head_base + .13, scalp - .11), 65):
        ring = section(hp, connections[head.name], float(z))
        if np.ptp(ring[:, 0]) > base_width * 1.16 or ring[:, 1].min() < base_front - .012:
            transition = float(z)
            break
    check('shortNeckTransition', transition is not None and transition - head_base < .075,
          {'joinToJawTransitionMeters': None if transition is None else transition - head_base,
           'baseWidthMeters': base_width, 'baseFrontMeters': base_front,
           'transitionHeightMeters': transition})

    weights = {}
    edge_rest = {}
    for obj in objects:
        totals = [sum(group.weight for group in vertex.groups) for vertex in obj.data.vertices]
        error = max(abs(value - 1) for value in totals)
        weights[obj.name] = {'vertices': len(totals), 'maximumWeightSumError': error}
        check('normalisedWeights/' + obj.name, error < .002, weights[obj.name])
        ep = rest[obj.name][connections[obj.name]]
        edge_rest[obj.name] = np.linalg.norm(ep[:, 1] - ep[:, 0], axis=1)

    poses = {}
    for clip in CLIPS:
        action = actions[clip]
        rig.animation_data.action = action
        if len(action.slots):
            rig.animation_data.action_slot = action.slots[0]
        start, end = action.frame_range
        frames = sorted(set(round(float(frame), 3) for frame in np.linspace(start, end, 13)))
        clip_report = {'sampledFrames': frames, 'meshes': {}, 'maximumNeckJoinGapMeters': 0.0}
        for frame in frames:
            scene.frame_set(math.floor(frame), subframe=frame % 1)
            bpy.context.view_layer.update()
            posed = {obj.name: points(obj, evaluated=True) for obj in objects}
            for obj in objects:
                pp = posed[obj.name]
                check('finiteVertices/' + clip + '/' + obj.name,
                      bool(np.isfinite(pp).all()) and float(np.max(np.abs(pp))) < 5,
                      {'frame': frame, 'maximumCoordinateMeters': float(np.max(np.abs(pp)))})
                ep = pp[connections[obj.name]]
                lengths = np.linalg.norm(ep[:, 1] - ep[:, 0], axis=1)
                valid = edge_rest[obj.name] > .001
                if not valid.any():
                    valid = edge_rest[obj.name] > .00001
                ratios = lengths[valid] / edge_rest[obj.name][valid]
                value = clip_report['meshes'].setdefault(obj.name, {'maximumEdgeStretch': 0.0,
                                                                 'maximum99thPercentileStretch': 0.0})
                value['maximumEdgeStretch'] = max(value['maximumEdgeStretch'], float(ratios.max()))
                value['maximum99thPercentileStretch'] = max(value['maximum99thPercentileStretch'],
                                                            float(np.quantile(ratios, .99)))
                limit = 2.0 if obj == head else 3.0
                if value['maximum99thPercentileStretch'] >= limit:
                    value['stretchLimitExceeded'] = True
            # Every scan/source-neck seam sample must remain attached while
            # the same Head/Neck bones rotate in each gameplay clip.
            posed_tree = BVHTree.FromPolygons([Vector(p) for p in posed[skin.name]],
                                               [tuple(poly.vertices) for poly in skin.data.polygons],
                                               all_triangles=False)
            seam_indices = np.flatnonzero(hp[:, 2] < head_base + .0005)
            gap = max(posed_tree.find_nearest(Vector(posed[head.name][index]))[3]
                      for index in seam_indices)
            clip_report['maximumNeckJoinGapMeters'] = max(clip_report['maximumNeckJoinGapMeters'], gap)
        check('animatedNeckJoin/' + clip, clip_report['maximumNeckJoinGapMeters'] < .006,
              {'maximumSurfaceGapMeters': clip_report['maximumNeckJoinGapMeters']})
        for name, measured in clip_report['meshes'].items():
            check('stableSkin/' + clip + '/' + name,
                  not measured.get('stretchLimitExceeded', False), measured)
        poses[clip] = clip_report
    report['poses'] = poses
    report['failures'] = failures
    report['passed'] = not failures
    if failures:
        raise AssertionError(f'{len(failures)} geometry/pose checks failed; see {OUTPUT}')
except Exception as error:
    report['failure'] = str(error)
    raise
finally:
    OUTPUT.write_text(json.dumps(report, indent=2))
    print('PERSON_ANATOMY_VERIFICATION', json.dumps({'passed': report['passed'],
          'report': str(OUTPUT), 'failure': report.get('failure')}), flush=True)
