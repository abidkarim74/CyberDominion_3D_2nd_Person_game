"""Inspect an artist model with Blender auto-execution disabled.

Run our own script against a .blend or .fbx; never execute bundled scripts.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
args = sys.argv[sys.argv.index('--') + 1:]
source = Path(args[0]).resolve()
output = ROOT / 'artifacts' / 'blender' / 'reference-model-inspection.json'
if source.suffix.lower() == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
elif source.suffix.lower() == '.fbx':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source), use_custom_normals=True)
else:
    raise RuntimeError('Only .blend and .fbx inspection is supported.')

def vec(value):
    return [round(float(c), 6) for c in value]

depsgraph = bpy.context.evaluated_depsgraph_get()
objects = []
global_min = Vector((float('inf'),) * 3)
global_max = Vector((float('-inf'),) * 3)
valid_min = Vector((float('inf'),) * 3)
valid_max = Vector((float('-inf'),) * 3)
for obj in bpy.data.objects:
    record = {
        'name': obj.name, 'type': obj.type,
        'parent': obj.parent.name if obj.parent else None,
        'instanceType': obj.instance_type,
        'instanceCollection': obj.instance_collection.name if obj.instance_collection else None,
        'collections': [c.name for c in obj.users_collection],
        'location': vec(obj.location), 'rotationEuler': vec(obj.rotation_euler),
        'scale': vec(obj.scale), 'dimensions': vec(obj.dimensions),
        'hideViewport': obj.hide_viewport, 'hideRender': obj.hide_render,
        'materials': [slot.material.name if slot.material else None for slot in obj.material_slots],
        'modifiers': [{'name': m.name, 'type': m.type, 'showViewport': m.show_viewport,
                       'showRender': m.show_render,
                       **({'levels': m.levels, 'renderLevels': m.render_levels} if m.type == 'SUBSURF' else {})}
                      for m in obj.modifiers],
    }
    if obj.type in {'MESH', 'CURVE', 'FONT'}:
        points = [obj.matrix_world @ Vector(p) for p in obj.bound_box]
        low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
        high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
        record['bounds'] = {'min': vec(low), 'max': vec(high), 'center': vec((low + high) * .5)}
        for i in range(3):
            global_min[i] = min(global_min[i], low[i])
            global_max[i] = max(global_max[i], high[i])
        if obj.type == 'MESH':
            obj.data.calc_loop_triangles()
            record['baseVertices'] = len(obj.data.vertices)
            record['baseFaces'] = len(obj.data.polygons)
            record['baseTriangles'] = len(obj.data.loop_triangles)
            record['uvLayers'] = [u.name for u in obj.data.uv_layers]
            record['smoothFaces'] = sum(p.use_smooth for p in obj.data.polygons)
            finite_points = []
            outlier_indices = []
            for v in obj.data.vertices:
                world = obj.matrix_world @ v.co
                if all(math.isfinite(c) and abs(c) < 1000 for c in world):
                    finite_points.append(world)
                else:
                    outlier_indices.append(v.index)
            record['outlierVertexIndices'] = outlier_indices
            if finite_points:
                record['validVertexBounds'] = {
                    'min': [min(p[i] for p in finite_points) for i in range(3)],
                    'max': [max(p[i] for p in finite_points) for i in range(3)],
                }
                for i in range(3):
                    valid_min[i] = min(valid_min[i], record['validVertexBounds']['min'][i])
                    valid_max[i] = max(valid_max[i], record['validVertexBounds']['max'][i])
            record['materialTriangles'] = {}
            for tri in obj.data.loop_triangles:
                idx = tri.material_index
                name = obj.data.materials[idx].name if idx < len(obj.data.materials) and obj.data.materials[idx] else f'slot-{idx}'
                record['materialTriangles'][name] = record['materialTriangles'].get(name, 0) + 1
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        record['evaluatedVertices'] = len(mesh.vertices)
        record['evaluatedTriangles'] = len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    objects.append(record)

materials = []
for material in bpy.data.materials:
    record = {'name': material.name, 'diffuseColor': vec(material.diffuse_color), 'metallic': material.metallic,
              'roughness': material.roughness, 'useNodes': material.use_nodes, 'images': []}
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image:
                record['images'].append({'name': node.image.name, 'filepath': node.image.filepath,
                                         'size': list(node.image.size), 'packed': bool(node.image.packed_file)})
            elif node.type == 'BSDF_PRINCIPLED':
                record['principled'] = {}
                for name in ['Base Color', 'Metallic', 'Roughness', 'Alpha', 'Transmission Weight', 'Coat Weight']:
                    socket = node.inputs.get(name)
                    if socket:
                        v = socket.default_value
                        record['principled'][name] = {'linked': socket.is_linked, 'value': vec(v) if hasattr(v, '__len__') else float(v)}
    materials.append(record)

report = {
    'source': str(source), 'blenderVersion': bpy.app.version_string,
    'unitSystem': bpy.context.scene.unit_settings.system, 'unitScale': bpy.context.scene.unit_settings.scale_length,
    'bounds': {'min': vec(valid_min), 'max': vec(valid_max), 'dimensions': vec(valid_max - valid_min)},
    'rawBoundsIncludingCorruptVertices': {'min': vec(global_min), 'max': vec(global_max), 'dimensions': vec(global_max - global_min)},
    'objectCount': len(objects), 'meshCount': sum(o['type'] == 'MESH' for o in objects),
    'baseTriangles': sum(o.get('baseTriangles', 0) for o in objects),
    'evaluatedTriangles': sum(o.get('evaluatedTriangles', 0) for o in objects),
    'objects': objects, 'materials': materials,
    'images': [{'name': i.name, 'filepath': i.filepath, 'size': list(i.size), 'packed': bool(i.packed_file)} for i in bpy.data.images],
    'collections': [{'name': c.name, 'objects': [o.name for o in c.objects]} for c in bpy.data.collections],
    'bundledTexts': [t.name for t in bpy.data.texts],
    'instances': [{'object': i.object.name, 'parent': i.parent.name if i.parent else None,
                   'isInstance': i.is_instance, 'translation': vec(i.matrix_world.translation)}
                  for i in depsgraph.object_instances],
    'grouping': {
        'wheel': ['wheel'],
        'wheelPivots': ['wheel_rf', 'wheel_lf', 'wheel_rb', 'wheel_lb'],
        'brakeHubs': [o['name'] for o in objects if o['name'].startswith('hub_')],
        'interior': ['Interior', 'Interior_badge', 'interiorlights', 'movsteer_0.5', 'steer_badge', 'speedook'],
        'glazing': ['windscreen_ok', 'glass_lf_ok', 'glass_rf_ok'],
        'bodyPanels': ['chassis_Mesh', 'bonnet_ok', 'door_lf_ok', 'door_rf_ok', 'movspoiler_25_1300'],
        'lights': ['headlights', 'lights', 'drl', 'taillights', 'brakelights', 'turnlights_f', 'turnlights_r', 'platelights'],
        'recommendedExcludedCorruptMesh': 'speedook',
        'sourceCoordinates': 'X lateral; -Y front; Z up',
    },
}
output.write_text(json.dumps(report, indent=2), encoding='utf8')
print('INSPECTION', json.dumps({k: report[k] for k in ['source', 'objectCount', 'meshCount', 'baseTriangles', 'evaluatedTriangles', 'bounds']}), flush=True)
print('REPORT', str(output), flush=True)
