"""Relax the playable character's captured weapon stance into civilian gaits.

Called by the realistic Blender builder as refine_gaits(rig, actions). Only
shoulders, arms, wrists and fingers are keyed. The captured pelvis, spine,
legs and feet remain untouched, including their timing and planted phases.
"""
from math import atan2, ceil, floor, sin, cos
import bpy
from mathutils import Vector, Matrix


def refine_gaits(rig, actions):
    scene = bpy.context.scene
    rig.animation_data_create()
    previous_action = rig.animation_data.action
    previous_frame = scene.frame_current
    previous_basis = {p.name: p.matrix_basis.copy() for p in rig.pose.bones}

    def bind(action):
        rig.animation_data.action = action
        if action is not None and len(action.slots):
            rig.animation_data.action_slot = action.slots[0]

    def bone(suffix):
        return rig.pose.bones['mixamorig:' + suffix]

    def aim(pose_bone, world_direction):
        # Retain the relaxed pose's roll and scale instead of guessing Euler
        # axes in the FBX armature's differently rolled left/right bones.
        current = (rig.matrix_world.to_3x3() @ (pose_bone.tail - pose_bone.head)).normalized()
        delta = current.rotation_difference(Vector(world_direction).normalized())
        world = rig.matrix_world @ pose_bone.matrix
        rotation = rig.matrix_world.inverted().to_quaternion() @ (delta @ world.to_quaternion())
        translation, _, scale = pose_bone.matrix.decompose()
        pose_bone.matrix = Matrix.LocRotScale(translation, rotation, scale)
        bpy.context.view_layer.update()

    # The authored idle has palms toward the thighs and softly curled fingers.
    # Reusing its local hand/finger transforms avoids the source capture's
    # closed trigger hand, while the wrists can follow the live arm swing.
    bind(actions['Idle'])
    scene.frame_set(floor(actions['Idle'].frame_range[0]))
    bpy.context.view_layer.update()
    names = []
    for side in ('Left', 'Right'):
        names += [side + suffix for suffix in ('Shoulder', 'Arm', 'ForeArm', 'Hand')]
        names += [side + 'Hand' + finger + str(joint)
                  for finger in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky') for joint in (1, 2, 3)]
    relaxed = {name: bone(name).matrix_basis.copy() for name in names if 'mixamorig:' + name in rig.pose.bones}

    reports = []
    for name in ('Walk', 'Run'):
        action = actions[name]
        bind(action)
        first, last = floor(action.frame_range[0]), ceil(action.frame_range[1])
        running = name == 'Run'
        samples = []
        captured = {}
        # The source's thighs are flexed around a forward-biased neutral. Use
        # each leg's measured cyclic range, so this bias cannot leave both
        # arms behind the torso throughout the entire walk/run.
        for frame in range(first, last + 1):
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            captured[frame] = {}
            for side in ('Left', 'Right'):
                leg = bone(side + 'UpLeg')
                direction = (rig.matrix_world.to_3x3() @ (leg.tail - leg.head)).normalized()
                captured[frame][side] = atan2(-direction.y, -direction.z)
        ranges = {}
        for side in ('Left', 'Right'):
            values = [p[side] for p in captured.values()]
            low, high = min(values), max(values)
            ranges[side] = ((low + high) * .5, max(.05, (high - low) * .5))
        for frame in range(first, last + 1):
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            # Measure this frame's actual captured thighs before changing the
            # upper body. This keeps each arm opposite its corresponding leg.
            thigh_pitch = captured[frame]
            for suffix, matrix in relaxed.items():
                bone(suffix).matrix_basis = matrix.copy()
            bpy.context.view_layer.update()

            for side, sign in (('Left', 1), ('Right', -1)):
                # Blender forward is -Y. Positive arm pitch moves backward,
                # opposing a forward thigh. Walking elbows flex 15 degrees;
                # running elbows flex 79 degrees with a loose forward pump.
                center, extent = ranges[side]
                swing = max(-1, min(1, (thigh_pitch[side] - center) / extent))
                pitch = swing * (.60 if running else .36)
                flex = (1.38 if running else .26) + .06 * max(0, -swing)
                forearm_pitch = pitch - flex
                hand_pitch = forearm_pitch - (.025 if running else .035)
                lateral = .12 if running else .085
                aim(bone(side + 'Arm'), (sign * lateral, sin(pitch), -cos(pitch)))
                aim(bone(side + 'ForeArm'), (-sign * .025, sin(forearm_pitch), -cos(forearm_pitch)))
                aim(bone(side + 'Hand'), (-sign * .018, sin(hand_pitch), -cos(hand_pitch)))
                if frame in (first, (first + last) // 2, last):
                    samples.append(dict(frame=frame, side=side, thighPitch=thigh_pitch[side], thighSwing=swing, armPitch=pitch,
                                        elbowFlexionDegrees=flex * 57.295779513))
            for suffix in relaxed:
                p = bone(suffix)
                p.rotation_mode = 'QUATERNION'
                for channel in ('location', 'rotation_quaternion', 'scale'):
                    p.keyframe_insert(channel, frame=frame, group=p.name)
        action['locomotion_style'] = 'unencumbered reciprocal arm swing; relaxed fingers; captured lower body unchanged'
        reports.append(dict(clip=name, frames=[first, last], samples=samples))

    bind(previous_action)
    scene.frame_set(previous_frame)
    if previous_action is None:
        for p in rig.pose.bones:
            p.matrix_basis = previous_basis[p.name]
    bpy.context.view_layer.update()
    print('REALISTIC_NATURAL_GAITS', reports, flush=True)
    return reports
