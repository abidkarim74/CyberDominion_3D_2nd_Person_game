"""Bake edits from bugatti-chiron.blend into compact game material batches.

blender --background artifacts/blender/bugatti-chiron.blend --python scripts/export-blender-car.py
"""
import base64
import bpy
import json
import struct
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'
COLLECTION=bpy.data.collections.get('Bugatti / game body')
if not COLLECTION:raise RuntimeError('Open bugatti-chiron.blend before exporting.')
def game(p):return (p[0],p[2],-p[1])
def pack(values,fmt):return base64.b64encode(struct.pack('<'+fmt*len(values),*values)).decode('ascii')
allowed={'paint','secondaryPaint','carbon','alloy','glass','amber','trim','redAccent','badge','grille','grilleFine','grilleDense','lights','interior','white','red'}
depsgraph=bpy.context.evaluated_depsgraph_get();buckets={}
for obj in COLLECTION.objects:
    if obj.type not in {'MESH','CURVE','FONT'}:continue
    evaluated=obj.evaluated_get(depsgraph);data=evaluated.to_mesh();data.calc_loop_triangles()
    normal_matrix=obj.matrix_world.to_3x3().inverted().transposed()
    for triangle in data.loop_triangles:
        # Bevels on shallow recesses can collapse tiny corner triangles.
        # Omit those and fall back to the face normal at degenerate corners.
        a,b,c=(data.vertices[v].co for v in triangle.vertices)
        if (b-a).cross(c-a).length_squared < 1e-16:continue
        material=data.materials[triangle.material_index].name
        if material not in allowed:raise RuntimeError(f'{obj.name}: unsupported game material {material}')
        bucket=buckets.setdefault(material,{'name':'Blender Chiron / '+material,'material':material,'p':[],'n':[],'u':[],'i':[],'lookup':{}})
        for loop in triangle.loops:
            vertex=data.vertices[data.loops[loop].vertex_index];position=game(obj.matrix_world@vertex.co)
            corner_normal=data.corner_normals[loop].vector
            if corner_normal.length_squared < 1e-12:corner_normal=triangle.normal
            normal=game((normal_matrix@corner_normal).normalized())
            uv=tuple(data.uv_layers.active.data[loop].uv) if data.uv_layers.active else (position[2]*.5+position[0]*.25,position[1]*.6+position[0]*.15)
            key=tuple(round(c*4096) for c in position)+tuple(round(c*32767) for c in normal)+tuple(round(c*1000000)/1000000 for c in uv)
            if key not in bucket['lookup']:
                bucket['lookup'][key]=len(bucket['p'])//3
                bucket['p'].extend(key[:3]);bucket['n'].extend(key[3:6]);bucket['u'].extend(key[6:])
            bucket['i'].append(bucket['lookup'][key])
    evaluated.to_mesh_clear()
meshes=[]
for b in buckets.values():
    if len(b['p'])//3>65535:raise RuntimeError(f"{b['material']}: exceeds 16-bit index budget")
    uv_scale=min(4096,int(32760/max(1,max(abs(v) for v in b['u']))))
    if uv_scale<1:raise RuntimeError(f"{b['material']}: invalid source UV range")
    meshes.append({'name':b['name'],'material':b['material'],'position':pack(b['p'],'h'),'normal':pack(b['n'],'h'),'uv':pack([round(v*uv_scale) for v in b['u']],'h'),'uvScale':uv_scale,'index':pack(b['i'],'H'),'vertices':len(b['p'])//3,'triangles':len(b['i'])//3})
asset={'version':1,'source':'artifacts/blender/bugatti-chiron.blend','positionScale':4096,'normalScale':32767,'uvScale':4096,'meshes':meshes}
(ROOT/'lib'/'blender-car-model.json').write_text(json.dumps(asset,separators=(',',':')))
print('Chiron body baked:',sum(m['triangles'] for m in meshes),'triangles;',len(meshes),'material batches',flush=True)
bpy.ops.object.select_all(action='DESELECT')
for name in ('Bugatti / game body','Bugatti / wheel and cabin reference'):
    for obj in bpy.data.collections[name].objects:obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT/'bugatti-chiron.glb'),export_format='GLB',use_selection=True,export_apply=True,export_yup=True)
