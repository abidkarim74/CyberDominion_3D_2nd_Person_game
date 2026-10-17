"""Refine the original driver's hands without changing his rig or animations.

Blender 5.2 --background --threads 4 --python scripts/build-driver-hands.py
The canonical person.blend and person.glb remain the editable base assets.
"""
from pathlib import Path
from math import sin, cos, pi
import bpy, bmesh, json, struct, hashlib
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'; WEB=ROOT/'public'/'models'/'person'
SOURCE=OUT/'person.blend'
source_hash=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
scene=bpy.context.scene
rig=bpy.data.objects['PersonRig']; root=bpy.data.objects['PersonRoot']
parts=[o for o in scene.objects if o.type=='MESH' and o.name.startswith('Person /')]
body=next(o for o in parts if 'Body' in o.name)
actions={a.name:a for a in bpy.data.actions if a.name in {'Idle','Walk','Run','Seated','EnterCar','ExitCar'}}
assert len(actions)==6
rig.animation_data.action=None
for track in rig.animation_data.nla_tracks:track.mute=True
for bone in rig.pose.bones:bone.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()

# The canonical atlas was reduced to 1024px for the distant body. Recover the
# original mapped skin at up to 2048px for the driver's much closer viewpoint.
# Only the body's diffuse/normal maps are retained from this temporary import.
before=set(scene.objects); before_actions=set(bpy.data.actions)
bpy.ops.import_scene.fbx(filepath=str(OUT/'person-source-remy.fbx'))
temporary=set(scene.objects)-before
source_body=next(o for o in temporary if o.type=='MESH' and 'Body' in o.name)
skin=body.data.materials[0]
source_nodes={n.image.name.split('.')[0]:n.image for m in source_body.data.materials for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image}
restored=[]
for node in skin.node_tree.nodes:
    if node.type!='TEX_IMAGE' or not node.image:continue
    name=node.image.name.split('.')[0]
    if not any(label in name for label in ['Diffuse','Normal']):continue
    image=source_nodes.get(name)
    if not image:continue
    if max(image.size)>2048:
        ratio=2048/max(image.size);image.scale(round(image.size[0]*ratio),round(image.size[1]*ratio))
    node.image=image;image.pack();restored.append(dict(image=name,size=list(image.size)))
for obj in temporary:bpy.data.objects.remove(obj,do_unlink=True)
for action in set(bpy.data.actions)-before_actions:bpy.data.actions.remove(action)
pbs=next(n for n in skin.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
pbs.inputs['Roughness'].default_value=.61
pbs.inputs['Specular IOR Level'].default_value=.28
for node in skin.node_tree.nodes:
    if node.type=='NORMAL_MAP':node.inputs['Strength'].default_value=.72

# Split only edges with hand weights. Interpolated UVs and deform weights
# retain the authored anatomy while providing rounded phalanges under curl.
# The face, clothing, standing silhouette and other body regions are untouched.
original_vertices=len(body.data.vertices)
hand_groups={g.index for g in body.vertex_groups if 'Hand' in g.name}
bm=bmesh.new();bm.from_mesh(body.data)
deform=bm.verts.layers.deform.active
def hand_weight(v):return sum(weight for group,weight in v[deform].items() if group in hand_groups)
edges=[edge for edge in bm.edges if min(hand_weight(v) for v in edge.verts)>.06]
bmesh.ops.subdivide_edges(bm,edges=edges,cuts=1,use_grid_fill=True,smooth=.55,use_smooth_even=True)
bm.normal_update();bm.to_mesh(body.data);bm.free();body.data.update()
for face in body.data.polygons:face.use_smooth=True

# The nail plates follow the actual skin surface in bind space and are each
# weighted to their distal phalanx. Their thin convex surfaces catch a small
# natural highlight; nothing is parented to the wheel or to the camera.
inverse=body.matrix_world.inverted()
bvh=BVHTree.FromPolygons([body.matrix_world@v.co for v in body.data.vertices],
    [list(face.vertices) for face in body.data.polygons],all_triangles=False)
vertices=[];faces=[];weights=[];colors=[]
for side in ['Left','Right']:
    for finger in ['Thumb','Index','Middle','Ring','Pinky']:
        bone=rig.pose.bones[f'mixamorig:{side}Hand{finger}3']
        transform=rig.matrix_world@bone.matrix
        forward=(rig.matrix_world.to_3x3()@(bone.tail-bone.head)).normalized()
        dorsal=-transform.to_3x3().col[2].normalized()
        across=forward.cross(dorsal).normalized()
        head=rig.matrix_world@bone.head
        center=head+forward*(.016 if finger=='Thumb' else .017)
        width={'Thumb':.0064,'Index':.0049,'Middle':.0052,'Ring':.0048,'Pinky':.0040}[finger]
        length={'Thumb':.0075,'Index':.0078,'Middle':.0086,'Ring':.0082,'Pinky':.0066}[finger]
        rings=[]
        for radius in [0,.35,.68,1]:
            ring=[]
            for segment in range(16 if radius else 1):
                angle=2*pi*segment/16
                x=radius*cos(angle);y=radius*sin(angle)
                point=center+across*(x*width)+forward*(y*length)
                hit,normal,_,_=bvh.ray_cast(point+dorsal*.045,-dorsal,.09)
                if hit is None:
                    # Rounded tips occasionally put an oval's edge just past
                    # the ray silhouette. Clamp it to the nearby dorsal skin.
                    hit,normal,_,distance=bvh.find_nearest(point+dorsal*.009)
                    assert hit is not None and distance<.02,(side,finger,point)
                position=hit+dorsal*(.00013+.00034*(1-radius*radius))
                ring.append(len(vertices));vertices.append(inverse@position)
                weights.append(bone.name)
                # Muted pink bed and a short, softly pale natural free edge.
                tip=max(0,min(1,(y-.62)/.38))
                colors.append((.67+.07*tip,.45+.09*tip,.405+.10*tip,1))
            rings.append(ring)
        for i in range(16):faces.append((rings[0][0],rings[1][i],rings[1][(i+1)%16]))
        for a,b in zip(rings[1:-1],rings[2:]):
            for i in range(16):faces.append((a[i],b[i],b[(i+1)%16],a[(i+1)%16]))
mesh=bpy.data.meshes.new('Driver / thin rounded natural nail plates');mesh.from_pydata(vertices,[],faces);mesh.update()
nails=bpy.data.objects.new('Person / articulated natural fingernails',mesh);scene.collection.objects.link(nails)
nails.parent=body.parent;nails.matrix_world=body.matrix_world.copy()
for bone in sorted(set(weights)):
    nails.vertex_groups.new(name=bone).add([i for i,name in enumerate(weights) if name==bone],1,'REPLACE')
modifier=nails.modifiers.new('Original driver skeleton','ARMATURE');modifier.object=rig
color=mesh.color_attributes.new(name='Nail bed and natural tip',type='FLOAT_COLOR',domain='POINT')
for i,value in enumerate(colors):color.data[i].color_srgb=value
material=bpy.data.materials.new('Driver / satin natural nails');material.use_nodes=True
pbs=material.node_tree.nodes.get('Principled BSDF');pbs.inputs['Roughness'].default_value=.43;pbs.inputs['Specular IOR Level'].default_value=.3
vertex=material.node_tree.nodes.new('ShaderNodeVertexColor');vertex.layer_name=color.name
material.node_tree.links.new(vertex.outputs['Color'],pbs.inputs['Base Color'])
nails.data.materials.append(material)
for face in mesh.polygons:face.use_smooth=True
parts.append(nails)

root['hand_detail']='Localized hand topology; original mapped skin; thin articulated nail plates'
rig.animation_data.action=actions['Idle']
if len(actions['Idle'].slots):rig.animation_data.action_slot=actions['Idle'].slots[0]
scene.frame_set(0);bpy.context.view_layer.update()
bpy.ops.object.select_all(action='DESELECT');root.select_set(True);rig.select_set(True)
for part in parts:part.select_set(True)
bpy.context.view_layer.objects.active=rig
output=WEB/'person-detailed-hands.glb'
bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,export_yup=True,
    export_animations=True,export_animation_mode='ACTIONS',export_force_sampling=True,
    export_optimize_animation_size=True,export_def_bones=False,export_leaf_bone=False,
    export_image_format='JPEG',export_jpeg_quality=92,export_materials='EXPORT',export_extras=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'person-detailed-hands.blend'))
data=output.read_bytes();length,kind=struct.unpack_from('<II',data,12);gltf=json.loads(data[20:20+length])
stats=dict(name='Original civilian / refined driver hands',source='person.blend',sourceSha256=source_hash,
    url='/models/person/person-detailed-hands.glb',skinImages=restored,
    addedBodyVertices=len(body.data.vertices)-original_vertices,nailVertices=len(vertices),
    meshes=len(gltf['meshes']),triangles=sum(gltf['accessors'][p['indices']]['count']//3 for m in gltf['meshes'] for p in m['primitives']),
    glbBytes=len(data),clips=[a['name'] for a in gltf['animations']],
    bones=len(rig.data.bones),sourceUnchanged=source_hash==hashlib.sha256(SOURCE.read_bytes()).hexdigest())
assert stats['sourceUnchanged'] and set(stats['clips'])==set(actions)
assert stats['triangles']<60000
(WEB/'person-detailed-hands-manifest.json').write_text(json.dumps(stats,indent=2))
print('DRIVER_HANDS_COMPLETE',json.dumps(stats),flush=True)
