"""Create the game's realistic rigged person in Blender 5.2.

Run:
  blender --background --threads 4 --python scripts/build-blender-person.py

Sources (download once into artifacts/blender):
  person-source-remy.fbx: https://huggingface.co/datasets/GbotHQ/mixamo-characters/resolve/main/Remy.fbx
  person-source-motion.glb: https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb
The human is Adobe Mixamo Remy; movement is the official Three.js example's
Mixamo capture. Both are permitted inside video-game projects. See the shipped
ATTRIBUTION.md for source and Adobe usage terms. No standalone asset license is
claimed. The Blender source retains editable materials, skeleton and actions.
"""
from pathlib import Path
import bpy
from math import pi, sin
from mathutils import Vector, Matrix, Quaternion
import json, struct
import numpy as np

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'
WEB=ROOT/'public'/'models'/'person'
OUT.mkdir(parents=True,exist_ok=True); WEB.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for action in list(bpy.data.actions): bpy.data.actions.remove(action)
scene=bpy.context.scene
scene.render.fps=30
scene.unit_settings.system='METRIC'
bpy.ops.import_scene.fbx(filepath=str(OUT/'person-source-remy.fbx'))
rig=next(o for o in scene.objects if o.type=='ARMATURE')
rig.name='PersonRig'
body_meshes=[o for o in scene.objects if o.type=='MESH']
for o in body_meshes:
    o.name='Person / '+o.name
    for p in o.data.polygons:p.use_smooth=True
    while len(o.data.uv_layers)>1:o.data.uv_layers.remove(o.data.uv_layers[-1])
rig.animation_data_clear()
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
for p in rig.pose.bones:p.rotation_mode='QUATERNION'; p.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()

# An explicit root provides a stable 1.8 metre model and a feet-centred origin.
def bounds(objects):
    dg=bpy.context.evaluated_depsgraph_get(); pts=[]
    for o in objects:
        ev=o.evaluated_get(dg); mesh=ev.to_mesh()
        pts.extend(ev.matrix_world@v.co for v in mesh.vertices)
        ev.to_mesh_clear()
    return Vector([min(p[i] for p in pts) for i in range(3)]),Vector([max(p[i] for p in pts) for i in range(3)])
lo,hi=bounds(body_meshes)
scale=1.8/(hi.z-lo.z)
root=bpy.data.objects.new('PersonRoot',None);scene.collection.objects.link(root)
rig.parent=root
root.scale=(scale,)*3
root.location=(-((hi.x+lo.x)*.5)*scale,0,-lo.z*scale)
bpy.context.view_layer.update()
print('PERSON_REST_BOUNDS',bounds(body_meshes), 'PELVIS',tuple(rig.matrix_world@rig.pose.bones['mixamorig:Hips'].head),flush=True)

# Preserve texture-mapped anatomy, eyes, hair cards, fabric folds and seams.
# Downsize only textures over 1024px, then tint the garments into a civilian
# charcoal T-shirt / olive cargo-short palette. Eye and hair alpha remain intact.
for image in bpy.data.images:
    if image.size[0]>1024 or image.size[1]>1024:
        factor=1024/max(image.size);image.scale(round(image.size[0]*factor),round(image.size[1]*factor))
for o in body_meshes:
    print('MATERIAL',o.name,[(m.name,[(n.type,n.image.name if n.type=='TEX_IMAGE' and n.image else '') for n in m.node_tree.nodes]) for m in o.data.materials],flush=True)
    for m in o.data.materials:
        if not m or not m.use_nodes:continue
        pbs=next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
        if not pbs:continue
        # Legacy FBX gloss/specular maps override slider values unless their
        # links are removed. Cloth uses matte PBR constants; skin keeps a soft
        # highlight. The diffuse, normals and alpha carry the visual detail.
        for socket in ('Metallic','Roughness','Specular IOR Level'):
            for link in list(pbs.inputs[socket].links):m.node_tree.links.remove(link)
        pbs.inputs['Metallic'].default_value=0
        pbs.inputs['Roughness'].default_value=(.82 if 'Tops' in o.name else .88 if 'Bottoms' in o.name else .8 if 'Hair' in o.name else .75 if 'Shoes' in o.name else .62)
        pbs.inputs['Specular IOR Level'].default_value=.28
        if 'Body' in o.name:pbs.inputs['Subsurface Weight'].default_value=.06
        for node in m.node_tree.nodes:
            if node.type=='NORMAL_MAP':node.inputs['Strength'].default_value=.4 if ('Tops' in o.name or 'Bottoms' in o.name) else .55
        # FBX import builds an image->Base Color connection; edit that diffuse
        # image so the exact same tint survives the glTF exporter.
        if 'Tops' in o.name or 'Bottoms' in o.name:
            color_socket=pbs.inputs['Base Color']
            if color_socket.is_linked:
                node=color_socket.links[0].from_node
                if node.type=='TEX_IMAGE' and node.image:
                    image=node.image
                    pixels=np.array(image.pixels[:],dtype=np.float32).reshape(-1,4)
                    tint=np.array([.19,.25,.28] if 'Tops' in o.name else [.40,.43,.33],dtype=np.float32)
                    pixels[:,:3]*=tint
                    image.pixels.foreach_set(pixels.ravel());image.update()
        # Hair and eyelashes are card geometry. Alpha clipping gives depth and
        # shadows without sorting artifacts in the game's transparent pass.
        if 'Hair' in o.name or 'Eyelashes' in o.name:
            m.surface_render_method='DITHERED'
            m.use_transparency_overlap=False
            for node in m.node_tree.nodes:
                if node.type=='TEX_IMAGE' and node.image:
                    # Eyelashes share the facial atlas, so make small copies
                    # instead of reducing the main face image's resolution.
                    limit=256 if 'Eyelashes' in o.name else 512
                    image=node.image.copy() if 'Eyelashes' in o.name else node.image
                    node.image=image
                    if max(image.size)>limit:
                        ratio=limit/max(image.size);image.scale(round(image.size[0]*ratio),round(image.size[1]*ratio))
        for n in m.node_tree.nodes:
            if n.type=='TEX_IMAGE' and n.image:n.image.pack()

# Import the small official motion source only as an animation reference.
before=set(scene.objects)
bpy.ops.import_scene.gltf(filepath=str(OUT/'person-source-motion.glb'))
source_objects=set(scene.objects)-before
src=next(o for o in source_objects if o.type=='ARMATURE')
source_actions={a.name:a for a in bpy.data.actions if a.name in {'Idle','Walk','Run'}}
for track in list(src.animation_data.nla_tracks):src.animation_data.nla_tracks.remove(track)
src.animation_data.action=None
# Source Vanguard faces +Y in Blender; the human faces -Y. Align global deltas.
align=Quaternion(Vector((0,0,1)),pi)

# World/rest-space retargeting handles the two models' different bone rolls,
# lengths and imported axes. Hips translations remain in place; slight capture
# bob is retained on the vertical axis and is scaled to the new proportions.
def bind_action(obj,action):
    obj.animation_data_create();obj.animation_data.action=action
    if len(action.slots):obj.animation_data.action_slot=action.slots[0]
def pose_snapshot():
    return {p.name:(p.location.copy(),p.rotation_quaternion.copy(),p.scale.copy()) for p in rig.pose.bones}
def set_snapshot(data):
    for p in rig.pose.bones:
        loc,rot,scl=data[p.name];p.location=loc;p.rotation_quaternion=rot;p.scale=scl
    bpy.context.view_layer.update()
def key_pose(frame):
    for p in rig.pose.bones:
        p.keyframe_insert('location',frame=frame,group=p.name)
        p.keyframe_insert('rotation_quaternion',frame=frame,group=p.name)
        p.keyframe_insert('scale',frame=frame,group=p.name)

target_actions={}
rig.animation_data_create()
for name in ('Idle','Walk','Run'):
    motion=source_actions[name]
    motion.name='Source / '+name
    bind_action(src,motion)
    duration=(motion.frame_range[1]-motion.frame_range[0])/scene.render.fps
    action=bpy.data.actions.new(name);bind_action(rig,action)
    frames=round(duration*scene.render.fps)
    first_hip=None
    for frame in range(frames+1):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for p in rig.pose.bones:p.matrix_basis=Matrix.Identity(4)
        bpy.context.view_layer.update()
        for p in rig.pose.bones:
            sb=src.pose.bones.get(p.name)
            if not sb:continue
            sr=(src.matrix_world@sb.bone.matrix_local).to_quaternion()
            sp=(src.matrix_world@sb.matrix).to_quaternion()
            delta=align@(sp@sr.inverted())@align.inverted()
            if name=='Idle' and p.name.split(':')[-1] in {'Hips','Spine','Spine1','Spine2','Neck','Head'}:
                delta=Quaternion((1,0,0,0)).slerp(delta,.28)
            tr=(rig.matrix_world@p.bone.matrix_local).to_quaternion()
            rot=rig.matrix_world.to_quaternion().inverted()@(delta@tr)
            m=rot.to_matrix().to_4x4()
            if p.parent:
                m.translation=(p.parent.matrix@p.parent.bone.matrix_local.inverted()@p.bone.matrix_local).translation
            else:
                m.translation=p.bone.matrix_local.translation
                # Restrict root capture to its height variation, centimetres
                # are converted using the source object's actual scale.
                world_hip=src.matrix_world@sb.head
                if first_hip is None:first_hip=world_hip.z
                local_delta=rig.matrix_world.inverted().to_3x3()@Vector((0,0,(world_hip.z-first_hip)*scale))
                m.translation+=local_delta
            p.matrix=m
            bpy.context.view_layer.update()
        key_pose(frame)
    action.use_fake_user=True
    target_actions[name]=action
    print('CLIP_BUILT',name,frames/30,flush=True)
# Source geometry is never included in the playable GLB or Blender deliverable.
for o in source_objects:bpy.data.objects.remove(o,do_unlink=True)
for a in list(bpy.data.actions):
    if a.name.startswith('Source /') or a.name=='TPose':bpy.data.actions.remove(a)

# Preserve the captured motion's original scale and the seated integration
# contract. The relaxed Idle authored below fits its straighter stance to 1.8m
# independently, without resizing the walking, running or driving clips.
bind_action(rig,target_actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
lo,hi=bounds(body_meshes)
fit=1.8/(hi.z-lo.z)
root.scale*=fit
root.location.z-=lo.z*fit
root.location.x-=((lo.x+hi.x)*.5)*fit
bpy.context.view_layer.update()
standing=pose_snapshot()
print('PERSON_STANDING_BOUNDS',bounds(body_meshes),flush=True)

# Edit the car poses in world coordinates rather than rotating guessed local
# bone axes. Aim an existing bone towards an explicit vector, retaining its roll.
def aim_bone(name,world_direction):
    p=rig.pose.bones['mixamorig:'+name]
    current=(rig.matrix_world.to_3x3()@(p.tail-p.head)).normalized()
    delta=current.rotation_difference(Vector(world_direction).normalized())
    world=rig.matrix_world@p.matrix
    q=delta@world.to_quaternion()
    m=(rig.matrix_world.inverted().to_quaternion()@q).to_matrix().to_4x4()
    m.translation=p.matrix.translation
    p.matrix=m;bpy.context.view_layer.update()

# Author a civilian standing Idle instead of retaining Soldier.glb's crouched
# combat-ready capture. Keep the existing root/other actions unchanged: the
# standing-only pelvis scale fits this straighter stance to the 1.8m contract.
def author_relaxed_idle():
    rig.animation_data.action=None
    for p in rig.pose.bones:p.matrix_basis=Matrix.Identity(4)
    bpy.context.view_layer.update()
    aim_bone('Spine',(0,.035,1));aim_bone('Spine1',(0,.03,1));aim_bone('Spine2',(0,-.025,1))
    aim_bone('Neck',(0,-.06,1));aim_bone('Head',(0,-.06,1))
    for side,sign in (('Left',1),('Right',-1)):
        # Nearly straight knees with the soles facing the floor. Arms hang
        # beside the thighs with a small, comfortable bend at the elbows.
        aim_bone(side+'UpLeg',(sign*.055,-.022,-1));aim_bone(side+'Leg',(-sign*.012,.047,-1))
        aim_bone(side+'Foot',(sign*.115,-1,-.875));aim_bone(side+'ToeBase',(sign*.015,-1,.008))
        aim_bone(side+'Arm',(sign*.065,.025,-1));aim_bone(side+'ForeArm',(-sign*.015,-.085,-1))
        aim_bone(side+'Hand',(-sign*.035,-.055,-1))
        for finger in ('Index','Middle','Ring','Pinky'):
            for joint,flex in ((1,.08),(2,.23),(3,.42)):
                aim_bone(f'{side}Hand{finger}{joint}',(-sign*flex,-.025,-1))
        for joint,flex in ((1,.25),(2,.35),(3,.45)):
            aim_bone(f'{side}HandThumb{joint}',(-sign*.12,-flex,-1))
    hips=rig.pose.bones['mixamorig:Hips']
    lo,hi=bounds(body_meshes);fit=1.8/(hi.z-lo.z);hips.scale=(fit,)*3
    bpy.context.view_layer.update();lo,hi=bounds(body_meshes)
    hips.location+=rig.matrix_world.inverted().to_3x3()@Vector((0,0,-lo.z))
    bpy.context.view_layer.update()
    # Correct the few millimetres of asymmetry between the imported shoes.
    # Keep each sole on the floor throughout the authored upper-body sway.
    shoes=next(o for o in body_meshes if 'Shoes' in o.name)
    for side,sign in (('Left',1),('Right',-1)):
        dg=bpy.context.evaluated_depsgraph_get();ev=shoes.evaluated_get(dg);mesh=ev.to_mesh()
        pts=[ev.matrix_world@v.co for v in mesh.vertices]
        sole=min(p.z for p in pts if p.x*sign>0);ev.to_mesh_clear()
        leg=rig.pose.bones['mixamorig:'+side+'UpLeg'];m=leg.matrix.copy()
        m.translation+=rig.matrix_world.inverted().to_3x3()@Vector((0,0,-sole));leg.matrix=m
        bpy.context.view_layer.update()
    neutral=pose_snapshot()
    previous=target_actions['Idle'];previous.name='Previous / Idle'
    action=bpy.data.actions.new('Idle');bind_action(rig,action)
    for frame in range(241):
        set_snapshot(neutral);t=frame/240
        # Breathing and a small upper-body weight shift loop in eight seconds.
        # Pelvis, legs and feet stay fixed; the runtime adds larger non-periodic
        # glances and hand adjustments on top of this continuous living pose.
        spine=rig.pose.bones['mixamorig:Spine']
        spine.rotation_quaternion @= Quaternion(Vector((1,0,0)),.008*sin(t*2*pi))
        chest=rig.pose.bones['mixamorig:Spine2']
        chest.rotation_quaternion @= Quaternion(Vector((0,0,1)),.005*sin(t*4*pi))
        for side,phase in (('Left',0),('Right',pi)):
            arm=rig.pose.bones['mixamorig:'+side+'Arm']
            arm.rotation_quaternion @= Quaternion(Vector((0,0,1)),.012*sin(t*2*pi+phase))
        key_pose(frame)
    action.use_fake_user=True;target_actions['Idle']=action
    # Existing editable sources may have an Idle NLA strip. Rebind it before
    # deleting the soldier-derived action; fresh builds create tracks later.
    for track in rig.animation_data.nla_tracks:
        for strip in track.strips:
            if strip.action==previous:
                strip.action=action
                if len(action.slots):strip.action_slot=action.slots[0]
                strip.action_frame_start=0;strip.action_frame_end=240
    bpy.data.actions.remove(previous)
    bind_action(rig,action);scene.frame_set(0);bpy.context.view_layer.update()
    print('CLIP_REPLACED','Idle',8.0,flush=True)
    print('PERSON_RELAXED_IDLE_BOUNDS',bounds(body_meshes),flush=True)
    return neutral

interaction_standing=standing
standing=author_relaxed_idle()

def seated_pose():
    set_snapshot(interaction_standing)
    # Pelvis height is a deliberate integration contract. The controller moves
    # PersonRoot to the car seat; its path supplies all global root translation.
    hips=rig.pose.bones['mixamorig:Hips']
    point=rig.matrix_world@hips.head
    hips.location+=rig.matrix_world.inverted().to_3x3()@Vector((-point.x,-point.y,.95-point.z))
    bpy.context.view_layer.update()
    aim_bone('Spine',(0,.11,1))
    aim_bone('Spine1',(0,.10,1))
    aim_bone('Spine2',(0,.05,1))
    aim_bone('Neck',(0,-.05,1));aim_bone('Head',(0,0,1))
    for side,sign in (('Left',1),('Right',-1)):
        # Hip->knee extends forward (-Y = +Z in glTF) with a small splay;
        # shin slopes toward the pedals. Hands are forward on the wheel.
        aim_bone(side+'UpLeg',(sign*.035,-1,-.07))
        aim_bone(side+'Leg',(0,-.20,-1))
        aim_bone(side+'Foot',(0,-1,-.07))
        aim_bone(side+'ToeBase',(0,-1,0))
        aim_bone(side+'Arm',(sign*.10,-.40,-.65))
        aim_bone(side+'ForeArm',(-sign*.15,-.72,.20))
        aim_bone(side+'Hand',(0,-.70,.15))
    return pose_snapshot()
rig.animation_data.action=None
seated=seated_pose()
# A low bend / door-reaching pose makes transitions read as a deliberate human
# movement as the controller moves along the doorway's collision-safe path.
set_snapshot(interaction_standing)
aim_bone('Spine',(0,-.35,1));aim_bone('Spine1',(0,-.32,1));aim_bone('Spine2',(0,-.25,1))
aim_bone('Head',(0,.18,1));aim_bone('LeftArm',(.60,-.45,-.35));aim_bone('LeftForeArm',(.50,-.65,.16))
aim_bone('RightArm',(-.18,-.35,-.75));aim_bone('RightForeArm',(.18,-.70,.18))
aim_bone('LeftUpLeg',(.05,-.46,-1));aim_bone('LeftLeg',(0,.33,-1))
aim_bone('RightUpLeg',(-.05,-.13,-1));aim_bone('RightLeg',(0,.16,-1))
bend=pose_snapshot()

def interpolate_pose(a,b,t):
    for p in rig.pose.bones:
        al,aq,asc=a[p.name];bl,bq,bsc=b[p.name]
        p.location=al.lerp(bl,t);p.rotation_quaternion=aq.slerp(bq,t);p.scale=asc.lerp(bsc,t)
    bpy.context.view_layer.update()

for name in ('Seated','EnterCar','ExitCar'):
    action=bpy.data.actions.new(name);bind_action(rig,action)
    n=30 if name=='Seated' else 39
    for frame in range(n+1):
        t=frame/n
        if name=='Seated':
            set_snapshot(seated)
            # Subtle head/shoulder breathing makes a held driving pose natural.
            hips=rig.pose.bones['mixamorig:Hips'];hips.location+=rig.matrix_world.inverted().to_3x3()@Vector((0,0,.0015*sin(t*2*pi)))
        else:
            if name=='ExitCar':t=1-t
            if t<.50:
                u=t/.50;u=u*u*(3-2*u);interpolate_pose(standing,bend,u)
            else:
                u=(t-.50)/.50;u=u*u*(3-2*u);interpolate_pose(bend,seated,u)
        key_pose(frame)
    action.use_fake_user=True;target_actions[name]=action
    print('CLIP_BUILT',name,n/30,flush=True)

# Tracks remain individually muted for editing; the exporter samples each
# action independently. The standing Idle is the useful opening editor pose.
rig.animation_data.action=None
for name,action in target_actions.items():
    track=rig.animation_data.nla_tracks.new();track.name=name
    strip=track.strips.new(name,0,action);strip.action_frame_start=0;strip.action_frame_end=action.frame_range[1]
    if len(action.slots):strip.action_slot=action.slots[0]
    track.mute=True
bind_action(rig,target_actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
root['asset_contract']='1.8m standing; feet Y=0; forward +Z; in-place root; seated pelvis Y=.95'
root['idle_posture']='Upright civilian stance; arms relaxed by thighs; softly curled fingers; fixed soles'
root['source']='Adobe Mixamo Remy; retargeted capture from Three.js Soldier.glb'
root['interaction_duration_seconds']=1.3
rig['animation_clips']='Idle,Walk,Run,Seated,EnterCar,ExitCar'

# Pack all source images into the .blend, including normals and alpha cards.
for image in bpy.data.images:
    if image.name not in {'Render Result','Viewer Node'}:
        try:image.pack()
        except RuntimeError:pass

bpy.ops.object.select_all(action='DESELECT')
root.select_set(True);rig.select_set(True)
for o in body_meshes:o.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(WEB/'person.glb'),export_format='GLB',use_selection=True,export_yup=True,
    export_animations=True,export_animation_mode='ACTIONS',export_force_sampling=True,
    export_optimize_animation_size=True,export_def_bones=False,export_leaf_bone=False,
    export_image_format='JPEG',export_jpeg_quality=88,export_materials='EXPORT',export_extras=True)

# A studio stage lives only in the editable source, never the runtime GLB.
scene.render.engine='BLENDER_EEVEE'
scene.eevee.taa_render_samples=16
scene.render.resolution_x=900;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.world.color=(.11,.11,.11)
scene.view_settings.view_transform='AgX'
studio=bpy.data.collections.new('Studio / preview only');scene.collection.children.link(studio)
def to_studio(o):
    for c in list(o.users_collection):c.objects.unlink(o)
    studio.objects.link(o)
def camera(location,target,scale):
    bpy.ops.object.camera_add(location=location);cam=bpy.context.object;to_studio(cam)
    cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=scale;scene.camera=cam
    return cam
for loc,en,size,col in [((2,-3,4),300,3,(1,.86,.76)),((-3,-1,2),180,3,(.68,.80,1)),((1,2,3),500,2,(.9,.94,1))]:
    bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;to_studio(l);l.data.energy=en;l.data.shape='DISK';l.data.size=size;l.data.color=col;l.rotation_euler=(Vector((0,0,1))-l.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.004));floor=bpy.context.object;floor.name='Studio ground';to_studio(floor)
mat=bpy.data.materials.new('Studio neutral');mat.diffuse_color=(.075,.085,.10,1);floor.data.materials.append(mat)
cam=camera((2.5,-5,2.7),(0,0,.92),2.25)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'person.blend'))
scene.render.filepath=str(OUT/'person-fullbody.png');bpy.ops.render.render(write_still=True)
cam.location=(.45,-3,1.83);cam.rotation_euler=(Vector((0,-.04,1.57))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.64
scene.render.resolution_x=900;scene.render.resolution_y=900
scene.render.filepath=str(OUT/'person-closeup.png');bpy.ops.render.render(write_still=True)
bind_action(rig,target_actions['Seated']);scene.frame_set(0);bpy.context.view_layer.update()
cam.location=(2.5,-4,2.5);cam.rotation_euler=(Vector((0,-.20,1))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=2.1
scene.render.resolution_x=900;scene.render.resolution_y=1000
scene.render.filepath=str(OUT/'person-seated.png');bpy.ops.render.render(write_still=True)
bind_action(rig,target_actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
cam.location=(2.5,-5,2.7);cam.rotation_euler=(Vector((0,0,.92))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=2.25
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'person.blend'))

# Record the exported contract and compact counts without a Blender dependency.
d=(WEB/'person.glb').read_bytes();length,kind=struct.unpack_from('<II',d,12);g=json.loads(d[20:20+length])
triangles=sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives'])
vertices=sum(g['accessors'][p['attributes']['POSITION']]['count'] for m in g['meshes'] for p in m['primitives'])
stats={'name':'Civilian driver / Adobe Mixamo Remy','url':'/models/person/person.glb','standingHeightMeters':1.8,'forward':'+Z','up':'+Y','root':'feet centred, ground Y=0','seatedPelvisLocalY':.95,'interactionDurationSeconds':1.3,'clips':[{ 'name':a['name'],'durationSeconds':max(g['accessors'][s['input']]['max'][0] for s in a['samplers'])} for a in g['animations']],'bones':[b.name for b in rig.data.bones],'meshes':len(g['meshes']),'materials':len(g['materials']),'textures':len(g.get('images',[])),'vertices':vertices,'triangles':triangles,'glbBytes':len(d),'sourceBlend':'artifacts/blender/person.blend','previewImages':['person-fullbody.png','person-closeup.png','person-seated.png']}
stats['idlePosture']='relaxed upright standing with hanging arms and softly curled fingers'
(WEB/'person-manifest.json').write_text(json.dumps(stats,indent=2))
print('PERSON_COMPLETE',json.dumps(stats),flush=True)
