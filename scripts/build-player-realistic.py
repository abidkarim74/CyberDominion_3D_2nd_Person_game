"""Fit a scanned adult head and detailed civilian clothes to the playable rig.

Blender 5.2 --background --threads 4 --python scripts/build-player-realistic.py
Source head: Lee Perry-Smith / Infinite Realities, CC BY 3.0. See attribution.
The canonical Remy source, winter variant and NPC assets are never overwritten.
"""
from pathlib import Path
from math import pi, sin, cos, exp
import ast, hashlib, json, struct, sys, runpy
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'; WEB=ROOT/'public'/'models'/'person'
ASSETS=OUT/'realistic-source'; SOURCE=OUT/'person.blend'
SOURCE_HASH=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
helpers=ast.parse((ROOT/'scripts'/'build-blender-pedestrians.py').read_text())
names={'bind','bounds','remove','subset','weld','smooth','newgeo','rigid','shell','seam','garment_surface_weights','trouser_weights','assign_weights'}
exec(compile(ast.Module(body=[n for n in helpers.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),str(ROOT/'scripts'/'build-blender-pedestrians.py'),'exec'))
bpy.ops.wm.open_mainfile(filepath=str(SOURCE));scene=bpy.context.scene
rig=bpy.data.objects['PersonRig'];root=bpy.data.objects['PersonRoot']
source=[o for o in scene.objects if o.type=='MESH' and o.name.startswith('Person /')]
print('REALISTIC_STAGE source loaded',flush=True)
for o in list(scene.objects):
    if o not in source and o not in {root,rig}:remove(o)
actions={a.name:a for a in bpy.data.actions if a.name in {'Idle','Walk','Run','Seated','EnterCar','ExitCar'}}
assert len(actions)==6
for t in list(rig.animation_data.nla_tracks):rig.animation_data.nla_tracks.remove(t)
rig.animation_data.action=None
for p in rig.pose.bones:p.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
body=next(o for o in source if 'Body' in o.name)
shirt=next(o for o in source if 'Tops' in o.name)
trousers=next(o for o in source if 'Bottoms' in o.name)
shoes=next(o for o in source if 'Shoes' in o.name)
for o in list(source):
    if any(k in o.name for k in ['Hair','Eyes','Eyelashes']):remove(o);source.remove(o)

def setmat(o,m):o.data.materials.clear();o.data.materials.append(m)
def material(name,color,rough=.75,metal=0):
    m=bpy.data.materials.new('Realistic / '+name);m.use_nodes=True;m.diffuse_color=(*color,1)
    p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
    p.inputs['Specular IOR Level'].default_value=.28
    return m
def texture(m,image,socket):
    n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=image
    m.node_tree.links.new(n.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs[socket]);return n
def apply_before_armature(o,modifier):
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
    while list(o.modifiers).index(modifier)>0:bpy.ops.object.modifier_move_up(modifier=modifier.name)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
def subdivide(o,levels=1):
    weld(o);mod=o.modifiers.new('Anatomical surface refinement','SUBSURF');mod.levels=levels;apply_before_armature(o,mod)

# Keep articulated arms, fingers, upper chest and neck. Hidden torso/legs are
# omitted so the fitted clothes cannot reveal a second surface while bending.
skin=subset(body,'Realistic / fair skin neck shoulders arms hands',lambda p:p.z<1.555 and (p.z>1.34 or abs(p.x)>.25))
remove(body);source.remove(body)
inv=skin.matrix_world.inverted()
for v in skin.data.vertices:
    p=skin.matrix_world@v.co;x=abs(p.x)
    if .23<x<.72:
        strength=.25*exp(-((x-.355)/.102)**2)+.11*exp(-((x-.525)/.13)**2)
        # Muscle volume follows the original arm anatomy and bone centres.
        centerz=1.416+.014*exp(-((x-.29)/.1)**2)
        p.y=.008+(p.y-.008)*(1+strength)
        p.z=centerz+(p.z-centerz)*(1+strength)
    v.co=inv@p
skin.data.update();subdivide(skin)
skinmat=skin.data.materials[0].copy();skinmat.name='Realistic / fair living skin arms and neck';setmat(skin,skinmat)
pbs=skinmat.node_tree.nodes.get('Principled BSDF');pbs.inputs['Roughness'].default_value=.59
pbs.inputs['Subsurface Weight'].default_value=.065;pbs.inputs['Subsurface Radius'].default_value=(1,.45,.25)

# The dedicated body helper completes the source's absent upper-arm anatomy
# and authors a continuous tank with a rounded neck and true arm openings.
tank=shirt;tank.name='Realistic / washed dark olive sleeveless tank'
tankmat=tank.data.materials[0].copy();tankmat.name='Realistic / washed olive cotton jersey'
setmat(tank,tankmat);pbs=tankmat.node_tree.nodes.get('Principled BSDF')
pbs.inputs['Roughness'].default_value=.9
extras=runpy.run_path(str(ROOT/'scripts'/'realistic-body.py'))['refine_body'](rig,root,skin,tank,skinmat,tankmat)

# Full-length charcoal cargo trousers with existing mapped folds and pockets.
weld(trousers);inv=trousers.matrix_world.inverted()
for v in trousers.data.vertices:
    p=trousers.matrix_world@v.co
    if p.z<.65:
        p.z=.65+(p.z-.65)*(.65-.075)/(.65-.37534)
        t=max(0,min(1,(p.z-.075)/.575));taper=.74+.26*t;cx=.09 if p.x>0 else -.09
        p.x=cx+(p.x-cx)*taper;p.y=.018+(p.y-.018)*taper
    v.co=inv@p
trousers.data.update();assign_weights(trousers,trouser_weights)
trousers.name='Realistic / charcoal woven cargo trousers'
tm=trousers.data.materials[0].copy();tm.name='Realistic / worn charcoal cargo twill';setmat(trousers,tm)
p=tm.node_tree.nodes.get('Principled BSDF');p.inputs['Roughness'].default_value=.92
im=p.inputs['Base Color'].links[0].from_node.image.copy();im.name='Realistic cargo / mapped seams pockets and folds'
px=np.array(im.pixels[:],dtype=np.float32).reshape(-1,4)
gray=np.clip((px[:,:3]/np.array([.40,.43,.33]))@np.array([.2126,.7152,.0722]),.04,.96)
px[:,:3]=(.27+.73*gray[:,None])*np.array([.095,.105,.09]);im.pixels.foreach_set(px.ravel());im.update();im.pack();p.inputs['Base Color'].links[0].from_node.image=im
subdivide(trousers)
shoes.name='Realistic / textured leather lace up boots'
inv=shoes.matrix_world.inverted()
for v in shoes.data.vertices:
    q=shoes.matrix_world@v.co
    if q.z>.02:q.z=.02+(q.z-.02)*1.6
    v.co=inv@q
shoes.data.update()
bootmat=shoes.data.materials[0].copy();bootmat.name='Realistic / worn graphite leather and rubber';setmat(shoes,bootmat)
p=bootmat.node_tree.nodes.get('Principled BSDF');p.inputs['Roughness'].default_value=.69
if p.inputs['Base Color'].is_linked:
    im=p.inputs['Base Color'].links[0].from_node.image.copy();im.name='Realistic boots / leather laces and rubber albedo'
    px=np.array(im.pixels[:],dtype=np.float32).reshape(-1,4);gray=px[:,:3]@np.array([.2126,.7152,.0722])
    px[:,:3]=(.20+.8*gray[:,None])*np.array([.075,.068,.058]);im.pixels.foreach_set(px.ravel());im.update();im.pack();p.inputs['Base Color'].links[0].from_node.image=im

# High-frequency textile normal maps are embedded, so the runtime gets the
# same fine weave as Blender rather than a Blender-only procedural shader.
def weave_map(size=512):
    yy,xx=np.mgrid[:size,:size];p=np.ones((size,size,4),dtype=np.float32)
    p[:,:,0]=.5+.055*sin(pi/2)*np.sin(xx*pi/2)*(.65+.35*np.cos(yy*pi/2))
    p[:,:,1]=.5+.055*np.sin(yy*pi/2)*(.65+.35*np.cos(xx*pi/2));p[:,:,2]=.994
    im=bpy.data.images.new('Realistic / cotton micro weave normal',width=size,height=size);im.pixels.foreach_set(p.ravel());im.colorspace_settings.name='Non-Color';im.pack();return im
weave=weave_map()
# Keep original normal folds; weave is added into their pixels, preserving UVs.
for m in [tankmat,tm]:
    for n in m.node_tree.nodes:
        if n.type=='NORMAL_MAP' and n.inputs['Color'].is_linked:
            tex=n.inputs['Color'].links[0].from_node
            if tex.type!='TEX_IMAGE' or not tex.image:continue
            im=tex.image.copy();im.name=m.name+' / folds and woven micro normal'
            w,h=im.size;px=np.array(im.pixels[:],dtype=np.float32).reshape(h,w,4);yy,xx=np.mgrid[:h,:w]
            px[:,:,0]+=.018*np.sin(xx*pi/2)*np.cos(yy*pi/2);px[:,:,1]+=.018*np.sin(yy*pi/2)*np.cos(xx*pi/2)
            px[:,:,:3]=np.clip(px[:,:,:3],0,1);im.pixels.foreach_set(px.ravel());im.update();im.pack();tex.image=im;n.inputs['Strength'].default_value=.65

print('REALISTIC_STAGE garments and muscular skin complete',flush=True)
# Import a genuine scanned head. Its fitted neck blends into the original
# articulated neck; face/head follow the existing Head joint in every clip.
before=set(scene.objects);bpy.ops.import_scene.gltf(filepath=str(ASSETS/'head.glb'))
head=next(o for o in set(scene.objects)-before if o.type=='MESH')
head.name='Realistic / scanned bald adult face head and neck'
# Head preparation returns mesh objects in Blender metres, front -Y, with
# top at the original scalp and neck on the existing skeleton.
eye_helper=ROOT/'scripts'/'realistic-head-eyes.py'
prepared=runpy.run_path(str(eye_helper))['prepare_head'](head,rig,skin,ASSETS)
headparts=prepared if isinstance(prepared,list) else [head]
print('REALISTIC_STAGE scanned head and eyes fitted',flush=True)

headmat=material('scanned fair skin pores wrinkles stubble',(.65,.42,.33),.72)
p=headmat.node_tree.nodes.get('Principled BSDF');p.inputs['Subsurface Weight'].default_value=.055
p.inputs['Subsurface Radius'].default_value=(1,.42,.23);p.inputs['Specular IOR Level'].default_value=.22
im=bpy.data.images.load(str(ASSETS/'head-albedo.jpg'));im.name='Lee Perry-Smith / fair skin scanned albedo';im.pack();texture(headmat,im,'Base Color')
# A baked roughness map distinguishes dry stubble from the softer forehead,
# nose and lips in both Blender and the exported real-time material.
w,h=im.size;ap=np.array(im.pixels[:],dtype=np.float32).reshape(h,w,4);yy,xx=np.mgrid[:h,:w]
u=xx/w;v=yy/h;lum=ap[:,:,:3]@np.array([.2126,.7152,.0722])
rough=.69+.10*(1-lum)-.045*np.exp(-((u-.50)/.12)**2-((v-.64)/.18)**2)
rp=np.ones((h,w,4),dtype=np.float32);rp[:,:,:3]=np.clip(rough,.63,.80)[:,:,None]
roughmap=bpy.data.images.new('Realistic / scanned skin varied roughness',width=w,height=h)
roughmap.colorspace_settings.name='Non-Color';roughmap.pixels.foreach_set(rp.ravel());roughmap.update();roughmap.pack();texture(headmat,roughmap,'Roughness')
normal=bpy.data.images.load(str(ASSETS/'head-normal.jpg'));normal.name='Lee Perry-Smith / scanned pores wrinkles normal';normal.colorspace_settings.name='Non-Color';normal.pack()
n=headmat.node_tree.nodes.new('ShaderNodeTexImage');n.image=normal;nm=headmat.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.28
headmat.node_tree.links.new(n.outputs['Color'],nm.inputs['Color']);headmat.node_tree.links.new(nm.outputs['Normal'],p.inputs['Normal']);setmat(head,headmat)
runpy.run_path(str(ROOT/'scripts'/'realistic-skin.py'))['refine_skin'](skin,head,skinmat,headmat)
for o in headparts:
    if o.parent!=root:
        mw=o.matrix_world.copy();o.parent=root;o.matrix_world=mw
    if not any(m.type=='ARMATURE' for m in o.modifiers):
        m=o.modifiers.new('Original playable driver skeleton','ARMATURE');m.object=rig
        for vg in list(o.vertex_groups):o.vertex_groups.remove(vg)
        vg=o.vertex_groups.new(name='mixamorig:Head')
        if o is head:
            neck=o.vertex_groups.new(name='mixamorig:Neck')
            for vertex in o.data.vertices:
                z=(o.matrix_world@vertex.co).z
                t=max(0,min(1,(z-1.50)/(head.get('neck_head_blend_top',1.60)-1.50)));t=t*t*(3-2*t)
                if t>0:vg.add([vertex.index],t,'REPLACE')
                if t<1:neck.add([vertex.index],1-t,'REPLACE')
        else:vg.add(list(range(len(o.data.vertices))),1,'REPLACE')
    smooth(o)

# Consolidate same-material edge piping into one skinned draw, keeping all
# inherited weights. This is still editable geometry in the .blend.
if extras:
    bpy.ops.object.select_all(action='DESELECT')
    for o in extras:o.select_set(True)
    bpy.context.view_layer.objects.active=extras[0];bpy.ops.object.join();extras=[extras[0]]
objects=[skin,tank,trousers,shoes]+headparts+extras
gait_helper=ROOT/'scripts'/'realistic-gait.py'
runpy.run_path(str(gait_helper))['refine_gaits'](rig,actions)
for o in objects:smooth(o)
for a in actions.values():
    a.use_fake_user=True;t=rig.animation_data.nla_tracks.new();t.name=a.name;t.mute=True
    strip=t.strips.new(a.name,0,a)
    if len(a.slots):strip.action_slot=a.slots[0]
bind(rig,actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
lo,hi=bounds(objects)
root['appearance']='Fair-skinned adult male, scanned bald head, detailed stubble, dark olive sleeveless cotton top, charcoal cargo trousers, leather boots'
root['source_attribution']='Head: Infinite, 3D Head Scan by Lee Perry-Smith / Infinite Realities, CC BY 3.0. Body and movement: Adobe Mixamo Remy / Three.js.'
for im in bpy.data.images:
    if im.name not in {'Render Result','Viewer Node'}:
        try:im.pack()
        except RuntimeError:pass
bpy.ops.object.select_all(action='DESELECT');root.select_set(True);rig.select_set(True)
for o in objects:o.select_set(True)
bpy.context.view_layer.objects.active=rig
path=WEB/'person-realistic.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='ACTIONS',export_force_sampling=True,export_optimize_animation_size=True,export_def_bones=False,export_leaf_bone=False,export_image_format='JPEG',export_jpeg_quality=94,export_materials='EXPORT',export_extras=True)
d=path.read_bytes();length=struct.unpack_from('<I',d,12)[0];g=json.loads(d[20:20+length])
stats=dict(name='Realistic scanned adult male driver',url='/models/person/person-realistic.glb',editableBlend='artifacts/blender/person-realistic.blend',idleBounds=dict(min=lo,max=hi),standingHeightMeters=hi[2]-lo[2],seatedPelvisLocalY=.95,forward='+Z',up='+Y',clips=[dict(name=a['name'],durationSeconds=max(g['accessors'][s['input']]['max'][0] for s in a['samplers'])) for a in g['animations']],bones=[b.name for b in rig.data.bones],meshes=len(g['meshes']),materials=[m['name'] for m in g['materials']],textures=len(g.get('images',[])),triangles=sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives']),glbBytes=len(d),sha256=hashlib.sha256(d).hexdigest(),headLicense='CC BY 3.0 / Lee Perry-Smith, Infinite Realities',details=['scanned facial anatomy, ears, wrinkles, pores, eyebrows and stubble','fair skin with soft specular response','shaved bald scalp following reference','articulated muscular arms and individual fingers','washed dark olive sleeveless tank with fitted bound openings','woven charcoal cargo trousers with pockets and folds','leather lace-up boots','original compatible skeleton and six authored clips'])
(WEB/'person-realistic-manifest.json').write_text(json.dumps(stats,indent=2));print('REALISTIC_EXPORTED',json.dumps(stats),flush=True)

scene.render.engine='BLENDER_EEVEE';scene.eevee.taa_render_samples=32
scene.render.resolution_x=900;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.world.color=(.13,.13,.13);scene.view_settings.view_transform='AgX'
studio=bpy.data.collections.new('Realistic studio / preview only');scene.collection.children.link(studio)
def to_studio(o):
    for c in list(o.users_collection):c.objects.unlink(o)
    studio.objects.link(o)
for loc,en,size,col in [((2,-3,4),330,3,(1,.90,.82)),((-3,-1,2),240,3,(.75,.84,1)),((1,2,3),420,2,(.90,.95,1))]:
    bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;to_studio(l);l.data.energy=en;l.data.shape='DISK';l.data.size=size;l.data.color=col;l.rotation_euler=(Vector((0,0,1.25))-l.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.004));floor=bpy.context.object;to_studio(floor);floor.data.materials.append(material('studio floor',(.055,.065,.08)))
bpy.ops.object.camera_add(location=(2.5,-5,2.3));cam=bpy.context.object;to_studio(cam);cam.data.type='ORTHO';cam.data.ortho_scale=2.12;scene.camera=cam
def view(location,target,scale,name,width=900,height=1100):
    cam.location=location;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale
    scene.render.resolution_x=width;scene.render.resolution_y=height;scene.render.filepath=str(OUT/name);bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'person-realistic.blend'))
if '--skip-renders' not in sys.argv:
    view((.15,-4,1.0),(0,0,.91),2.03,'person-realistic-fullbody.png')
    view((.24,-3,1.78),(0,-.02,1.59),.60,'person-realistic-closeup.png',1000,1000)
    bind(rig,actions['Seated']);scene.frame_set(0);bpy.context.view_layer.update()
    view((2.5,-4,2.5),(0,-.2,1),2.1,'person-realistic-seated.png')
    bind(rig,actions['Walk']);scene.frame_set(12);bpy.context.view_layer.update()
    view((2,-4,2.1),(0,0,.91),2.12,'person-realistic-walk.png')
bind(rig,actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
cam.location=(.15,-4,1);cam.rotation_euler=(Vector((0,0,.91))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=2.03
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'person-realistic.blend'))
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==SOURCE_HASH
print('REALISTIC_COMPLETE',str(path),flush=True)
