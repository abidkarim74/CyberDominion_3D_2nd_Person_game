"""Author a detailed, animation-compatible winter outfit for the playable driver.

Blender 5.2 --background --threads 4 --python scripts/build-player-winter.py
The canonical person.blend, person.glb and NPC assets are never modified.
"""
from pathlib import Path
from math import pi, sin, cos
import ast, hashlib, json, struct, sys
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'; WEB=ROOT/'public'/'models'/'person'
SOURCE=OUT/'person.blend'
SOURCE_HASH=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
ORIGINAL_GLB_HASH=hashlib.sha256((WEB/'person.glb').read_bytes()).hexdigest()
OUT.mkdir(parents=True,exist_ok=True); WEB.mkdir(parents=True,exist_ok=True)

# Reuse only the NPC author's fitted-geometry utilities, never its build loop.
# New meshes inherit the source object's armature modifier and original rig.
helpers=ast.parse((ROOT/'scripts'/'build-blender-pedestrians.py').read_text())
names={'bind','bounds','remove','subset','weld','smooth','newgeo','rigid',
       'shell','ribbon','seam','garment_surface_weights','trouser_weights',
       'assign_weights','neutral_cloth_uv'}
exec(compile(ast.Module(body=[n for n in helpers.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),str(ROOT/'scripts'/'build-blender-pedestrians.py'),'exec'))

bpy.ops.wm.open_mainfile(filepath=str(SOURCE)); scene=bpy.context.scene
rig=bpy.data.objects['PersonRig']; root=bpy.data.objects['PersonRoot']
source=[o for o in scene.objects if o.type=='MESH' and o.name.startswith('Person /')]
for o in list(scene.objects):
    if o not in source and o not in {rig,root}: remove(o)
original_bones=[b.name for b in rig.data.bones]
original_actions={a.name:a for a in bpy.data.actions if a.name in {'Idle','Walk','Run','Seated','EnterCar','ExitCar'}}
assert len(original_actions)==6, list(original_actions)
for t in list(rig.animation_data.nla_tracks):rig.animation_data.nla_tracks.remove(t)
rig.animation_data.action=None
for p in rig.pose.bones:p.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
body=next(o for o in source if 'Body' in o.name)
shirt=next(o for o in source if 'Tops' in o.name)
trousers=next(o for o in source if 'Bottoms' in o.name)
shoes=next(o for o in source if 'Shoes' in o.name)
hair=next(o for o in source if 'Hair' in o.name)
for o in [shirt,trousers]:weld(o)

yy,xx=np.mgrid[:256,:256]
normal=bpy.data.images.new('Player Winter / fine woven textile normal',width=256,height=256)
npix=np.ones((256,256,4),dtype=np.float32)
npix[:,:,0]=.5+.027*np.sin(xx*pi/2)+.007*np.sin(yy*.7)
npix[:,:,1]=.5+.027*np.sin(yy*pi/2)-.007*np.sin(xx*.7)
npix[:,:,2]=.996
normal.pixels.foreach_set(npix.ravel());normal.colorspace_settings.name='Non-Color';normal.pack()

def material(name,color,roughness=.86,metallic=0):
    m=bpy.data.materials.new('PlayerWinter_'+name);m.use_nodes=True
    m.diffuse_color=(*color,1)
    p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=roughness;p.inputs['Metallic'].default_value=metallic
    p.inputs['Specular IOR Level'].default_value=.25
    if metallic==0:
        n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=normal;n.extension='REPEAT'
        uv=m.node_tree.nodes.new('ShaderNodeTexCoord');scale=m.node_tree.nodes.new('ShaderNodeVectorMath');scale.operation='SCALE';scale.inputs[3].default_value=20
        nm=m.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.16
        m.node_tree.links.new(uv.outputs['UV'],scale.inputs[0]);m.node_tree.links.new(scale.outputs[0],n.inputs['Vector'])
        m.node_tree.links.new(n.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],p.inputs['Normal'])
    return m

palette={'Coat':(.25,.34,.45),'Trousers':(.26,.28,.32),'Boots':(.030,.036,.045),
         'Scarf':(.47,.29,.125),'Beanie':(.19,.22,.25),'Cuffs':(.080,.095,.12),
         'Seams':(.028,.043,.063),'Reflective':(.27,.34,.40),'Hardware':(.16,.19,.23)}
mats={k:material(k,c,.42 if k=='Hardware' else .52 if k=='Reflective' else .78 if k=='Boots' else .88,.7 if k=='Hardware' else .12 if k=='Reflective' else 0) for k,c in palette.items()}
mats['Gloves']=mats['Boots'].copy();mats['Gloves'].name='PlayerWinter_Gloves'

def setmat(o,m):o.data.materials.clear();o.data.materials.append(m)

def fabric_from_source(target,source_mat,tint,color,label):
    p=source_mat.node_tree.nodes.get('Principled BSDF')
    n=p.inputs['Base Color'].links[0].from_node
    image=n.image.copy();image.name='Player Winter / '+label+' baked woven albedo'
    px=np.array(image.pixels[:],dtype=np.float32).reshape(-1,4)
    gray=np.clip((px[:,:3]/np.array(tint))@np.array([.2126,.7152,.0722]),.20,.96)
    # Bake the actual navy/charcoal colour once. No runtime wardrobe tint needed.
    px[:,:3]=gray[:,None]*np.array(color);image.pixels.foreach_set(px.ravel());image.update();image.pack()
    p=target.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(1,1,1,1)
    target.diffuse_color=(1,1,1,1)
    tex=target.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
    target.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
    source_normals=[n for n in source_mat.node_tree.nodes if n.type=='NORMAL_MAP' and n.inputs['Color'].is_linked]
    if source_normals:
        source_tex=source_normals[0].inputs['Color'].links[0].from_node
        if source_tex.type=='TEX_IMAGE' and source_tex.image:
            tex=target.node_tree.nodes.new('ShaderNodeTexImage');tex.image=source_tex.image
            nm=target.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.42
            target.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color'])
            target.node_tree.links.new(nm.outputs['Normal'],p.inputs['Normal'])
    return image

coatimage=fabric_from_source(mats['Coat'],shirt.data.materials[0],(.19,.25,.28),palette['Coat'],'parka')
fabric_from_source(mats['Trousers'],trousers.data.materials[0],(.40,.43,.33),palette['Trousers'],'trousers')
knit=bpy.data.images.new('Player Winter / rib knit wool albedo',width=256,height=256)
kp=np.ones((256,256,4),dtype=np.float32)
g=.80+.075*np.sin(xx*pi/3+.65*np.sin(yy*pi/4))+.025*np.cos(yy*pi/2)
kp[:,:,:3]=g[:,:,None];knit.pixels.foreach_set(kp.ravel());knit.pack()
for key in ['Scarf','Beanie','Cuffs']:
    image=knit.copy();image.name='Player Winter / '+key+' knit';px=np.array(image.pixels[:],dtype=np.float32).reshape(-1,4)
    px[:,:3]*=np.array(palette[key]);image.pixels.foreach_set(px.ravel());image.update();image.pack()
    mat=mats[key];p=mat.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(1,1,1,1);mat.diffuse_color=(1,1,1,1)
    t=mat.node_tree.nodes.new('ShaderNodeTexImage');t.image=image
    mat.node_tree.links.new(t.outputs['Color'],p.inputs['Base Color'])

# Keep the player's original face, head and proportions. Insulation is only
# 12–20mm, so the seated silhouette stays close to the original driver.
shirt.name='Player Winter / quilted insulated parka'; inv=shirt.matrix_world.inverted()
for v in shirt.data.vertices:
    p=shirt.matrix_world@v.co;n=(shirt.matrix_world.to_3x3().inverted().transposed()@v.normal).normalized()
    torso=abs(p.x)<.235
    if torso:
        p.x*=1.025;p.y*=1.025
        # A short driving parka ends above the hip hinge, avoiding a rigid skirt.
        if p.z<1.10:p.z=1.10+(p.z-1.10)*(1.10-.86)/(1.10-.85448)
    padding=.012 if torso else .008
    quilt=.003*(.5+.5*cos((p.z-.88)*2*pi/.10)) if torso else .0025*(.5+.5*cos(p.x*2*pi/.085))
    p+=n*(padding+quilt);v.co=inv@p
shirt.data.update();setmat(shirt,mats['Coat'])

sleeves=subset(body,'Player Winter / insulated articulated sleeves',lambda p:.267<abs(p.x)<.740 and 1.23<p.z<1.60)
weld(sleeves);inv=sleeves.matrix_world.inverted()
for v in sleeves.data.vertices:
    p=sleeves.matrix_world@v.co;n=(sleeves.matrix_world.to_3x3().inverted().transposed()@v.normal).normalized()
    t=max(0,min(1,(.74-abs(p.x))/.38))
    p+=n*(.009+.010*t+.0025*(.5+.5*cos(p.x*2*pi/.085)));v.co=inv@p
sleeves.data.update();setmat(sleeves,mats['Coat'])
gloves=subset(body,'Player Winter / articulated leather gloves',lambda p:abs(p.x)>.718 and p.z>1.20)
setmat(gloves,mats['Gloves'])

inv=trousers.matrix_world.inverted()
for v in trousers.data.vertices:
    p=trousers.matrix_world@v.co
    if p.z<.65:
        p.z=.65+(p.z-.65)*(.65-.065)/(.65-.37534)
        taper=.72+.28*max(0,min(1,(p.z-.065)/.585));cx=.09 if p.x>0 else -.09
        p.x=cx+(p.x-cx)*taper;p.y=.018+(p.y-.018)*taper
    v.co=inv@p
trousers.name='Player Winter / woven lined cargo trousers';trousers.data.update();setmat(trousers,mats['Trousers']);assign_weights(trousers,trouser_weights)

shoes.name='Player Winter / substantial lug sole winter boots';setmat(shoes,mats['Boots']);inv=shoes.matrix_world.inverted()
for v in shoes.data.vertices:
    p=shoes.matrix_world@v.co;cx=.09 if p.x>0 else -.09
    p.x=cx+(p.x-cx)*1.035
    if p.z>.015:p.z=.015+(p.z-.015)*1.12
    v.co=inv@p
shoes.data.update()
face=subset(body,'Player Winter / original detailed face and neck',lambda p:p.z>1.475 and abs(p.x)<.19)
remove(body);source.remove(body)
# Let natural sideburns peek below the beanie, without hair cards through its top.
cropped=subset(hair,'Player Winter / original hair below knit cap',lambda p:p.z<1.707)
remove(hair);source.remove(hair);hair=cropped

extras=[]
def add(o):extras.append(o);return o

add(shell('Player Winter / amber scarf neck wrap',[(0,.006,1.452,.080,.094),(0,.004,1.482,.084,.091),(0,.006,1.518,.080,.083),(0,.008,1.544,.072,.075)],mats['Scarf'],face,garment_surface_weights,64))
add(ribbon('Player Winter / folded amber scarf end',[(-.027,-.103,1.510),(-.034,-.162,1.46),(-.038,-.211,1.405),(-.047,-.220,1.35),(-.051,-.213,1.29),(-.048,-.206,1.24)],.060,.005,mats['Scarf'],face,garment_surface_weights))
add(shell('Player Winter / padded high collar',[(0,.025,1.438,.105,.107),(0,.024,1.470,.101,.102),(0,.022,1.502,.088,.093)],mats['Coat'],face,garment_surface_weights,64))

# Down-folded hood: open front U section gives depth at shoulders without
# widening the driver's head or filling the space in front of the scarf.
verts=[];faces=[];segments=44
for i,(z,rx,ry,cy) in enumerate([(1.411,.145,.121,.056),(1.438,.150,.133,.061),(1.470,.133,.123,.062),(1.493,.110,.103,.044)]):
    for j in range(segments):
        a=-.10*pi+j/(segments-1)*1.20*pi
        verts.append((rx*cos(a),cy+ry*sin(a),z-.011*cos(a*2)))
for i in range(3):
    for j in range(segments-1):faces.append((i*segments+j,i*segments+j+1,(i+1)*segments+j+1,(i+1)*segments+j))
hood=add(newgeo('Player Winter / folded insulated hood',verts,faces,mats['Coat'],face,garment_surface_weights))
hood['first_person_hidden']=True

# Close the tee's V opening beneath the collar with a proper jacket placket.
rows=[(1.505,.108,-.092),(1.470,.104,-.117),(1.435,.090,-.143),(1.400,.070,-.164),(1.365,.044,-.185),(1.335,.010,-.196)]
iv=[];iff=[]
for z,w,y in rows:iv.extend([(-w*.5,y,z),(0,y-.004,z),(w*.5,y,z)])
for i in range(len(rows)-1):
    for j in range(2):iff.append(((i+1)*3+j,(i+1)*3+j+1,i*3+j+1,i*3+j))
add(newgeo('Player Winter / insulated zipper placket',iv,iff,mats['Coat'],face,garment_surface_weights))

# Surface fitting puts real seam piping, pocket openings and horizontal quilt
# channels on the jacket, rather than floating straight lines in front of it.
spoints=[shirt.matrix_world@v.co for v in shirt.data.vertices]
def surface(x,z,front=True,offset=.003):
    candidates=sorted(spoints,key=lambda p:abs(p.x-x)*1.8+abs(p.z-z)*2.3)[:18]
    p=min(candidates,key=lambda p:p.y) if front else max(candidates,key=lambda p:p.y)
    return (x,p.y+(-offset if front else offset),z)
for z,width in [(.95,.175),(1.05,.18),(1.15,.183),(1.25,.18),(1.35,.158)]:
    for front in (True,False):
        pts=[surface(-width+2*width*i/18,z,front,.0035) for i in range(19)]
        add(seam('Player Winter / horizontal quilt channel',pts,.0016,mats['Seams'],face,garment_surface_weights))
zippts=[surface(.004,z,True,.0045) for z in [1.43,1.38,1.32,1.24,1.14,1.04,.94,.89]]
add(seam('Player Winter / center front weatherproof zipper',zippts,.003,mats['Hardware'],face,garment_surface_weights))
for sign in (-1,1):
    pts=[surface(sign*x,z,True,.006) for x,z in [(.10,1.08),(.12,1.04),(.14,1.0)]]
    add(seam('Player Winter / zip handwarmer pocket opening',pts,.004,mats['Seams'],face,garment_surface_weights))
    pts=[surface(sign*x,z,True,.007) for x,z in [(.097,1.083),(.117,1.043),(.137,1.003)]]
    add(seam('Player Winter / pocket edge topstitch',pts,.0011,mats['Reflective'],face,garment_surface_weights))
    # A small shoulder strip catches night lighting without large luminous trim.
    pts=[surface(sign*x,1.366,True,.006) for x in [.10,.13,.16]]
    add(seam('Player Winter / subtle shoulder reflective tab',pts,.0020,mats['Reflective'],face,garment_surface_weights))
# Slim rectangular zipper pull, not an oversized glowing accessory.
zp=Vector(surface(.004,1.34,True,.010))
add(seam('Player Winter / zipper pull loop',[tuple(zp+Vector((-.004,0,.003))),tuple(zp+Vector((-.004,-.001,-.019))),tuple(zp+Vector((.004,-.001,-.019))),tuple(zp+Vector((.004,0,.003)))],.0014,mats['Hardware'],face,garment_surface_weights))

# Fitted hat with a folded ribbed cuff; highest point is only ~3cm above hair.
rings=[(.003,.003,1.716,.122,.112),(.003,.004,1.741,.124,.114),(.003,.006,1.764,.119,.109),(.004,.010,1.787,.108,.098),(.006,.016,1.802,.080,.073),(.008,.018,1.812,.043,.040),(.008,.018,1.815,.006,.006)]
add(shell('Player Winter / fitted wool beanie',rings,mats['Beanie'],face,rigid('Head'),64))
add(shell('Player Winter / folded beanie rib cuff',[(.003,.003,1.714,.125,.116),(.003,.003,1.730,.127,.118),(.003,.004,1.752,.124,.115)],mats['Beanie'],face,rigid('Head'),64))
for j in range(40):
    a=j*2*pi/40
    pts=[(.003+rx*cos(a),.003+ry*sin(a),z) for z,rx,ry in [(1.716,.126,.117),(1.731,.128,.119),(1.751,.125,.116)]]
    add(seam('Player Winter / knit cuff raised rib',pts,.00085,mats['Beanie'],face,rigid('Head')))

# Rib-knit cuffs follow the actual wrists. The retained high-top shoes already
# contain detailed toes/laces/tread; their original Foot skinning avoids loose
# decorative ankle rings when the driver's feet bend toward the pedals.
for sign,side in [(1,'Left'),(-1,'Right')]:
    # Source rest forearms run along X. Elliptical wrist rings share a 14mm
    # overlap with both glove and sleeve so relaxed and steering wrists close.
    v=[];f=[];seg=40
    wrist=rig.matrix_world@rig.pose.bones['mixamorig:'+side+'ForeArm'].tail
    for i,(along,ry,rz) in enumerate([(-.023,.035,.035),(-.004,.034,.034),(.012,.032,.032)]):
        for j in range(seg):
            a=j*2*pi/seg;v.append((wrist.x+sign*along,wrist.y+ry*cos(a),wrist.z+rz*sin(a)))
    for i in range(2):
        for j in range(seg):f.append((i*seg+j,i*seg+(j+1)%seg,(i+1)*seg+(j+1)%seg,(i+1)*seg+j))
    add(newgeo('Player Winter / ribbed sleeve cuff',v,f,mats['Cuffs'],face,rigid(side+'ForeArm')))

objects=[shirt,trousers,shoes,hair,sleeves,gloves,face]+[o for o in source if 'Eyes' in o.name or 'Eyelashes' in o.name]+extras
# Atlas sampling prevents a shirt's unused black UV regions on new sleeves.
best=min(shirt.data.loops,key=lambda l:((shirt.matrix_world@shirt.data.vertices[l.vertex_index].co)-Vector((-.11,-.18,1.28))).length)
clothcenter=shirt.data.uv_layers.active.data[best.index].uv.copy()
for o in objects:
    if o!=shirt and len(o.data.materials)==1 and o.data.materials[0]==mats['Coat']:
        neutral_cloth_uv(o,coatimage,shirt.data.uv_layers.active.name,clothcenter)
for mat in mats.values():
    group=[o for o in objects if len(o.data.materials)==1 and o.data.materials[0]==mat and not o.get('first_person_hidden')]
    if len(group)<2:continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in group:o.select_set(True)
    bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join()
    objects=[o for o in objects if o not in group[1:]]
    if mat==mats['Scarf']:
        o=group[0];mod=o.modifiers.new('Soft scarf folds','SUBSURF');mod.levels=1
        o['first_person_hidden']=True
        while list(o.modifiers).index(mod)>0:bpy.ops.object.modifier_move_up(modifier=mod.name)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        mod=o.modifiers.new('Warm wool thickness','SOLIDIFY');mod.thickness=.20
        while list(o.modifiers).index(mod)>0:bpy.ops.object.modifier_move_up(modifier=mod.name)
        bpy.ops.object.modifier_apply(modifier=mod.name)
for o in objects:smooth(o)
for a in original_actions.values():
    a.use_fake_user=True;t=rig.animation_data.nla_tracks.new();t.name=a.name;t.mute=True
    strip=t.strips.new(a.name,0,a)
    if len(a.slots):strip.action_slot=a.slots[0]
bind(rig,original_actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
lo,hi=bounds(objects)
root['wardrobe']='Detailed fitted navy quilted winter parka, amber scarf, ribbed beanie, gloves, cargo trousers and boots'
root['winter_source_sha256']=SOURCE_HASH
for image in bpy.data.images:
    if image.name not in {'Render Result','Viewer Node'}:
        try:image.pack()
        except RuntimeError:pass
bpy.ops.object.select_all(action='DESELECT');root.select_set(True);rig.select_set(True)
for o in objects:o.select_set(True)
bpy.context.view_layer.objects.active=rig
path=WEB/'person-winter.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='ACTIONS',export_force_sampling=True,export_optimize_animation_size=True,export_def_bones=False,export_leaf_bone=False,export_image_format='JPEG',export_jpeg_quality=90,export_materials='EXPORT',export_extras=True)

data=path.read_bytes();length,kind=struct.unpack_from('<II',data,12);g=json.loads(data[20:20+length])
clips=[dict(name=a['name'],durationSeconds=max(g['accessors'][s['input']]['max'][0] for s in a['samplers'])) for a in g['animations']]
assert {a['name'] for a in clips}==set(original_actions),clips
assert [b.name for b in rig.data.bones]==original_bones
samples={}
for name in original_actions:
    bind(rig,original_actions[name]);frames=[0,int(original_actions[name].frame_range[1]//2),int(original_actions[name].frame_range[1])]
    samples[name]=[]
    for frame in frames:
        scene.frame_set(frame);bpy.context.view_layer.update();mn,mx=bounds(objects)
        pelvis=rig.matrix_world@rig.pose.bones['mixamorig:Hips'].head
        samples[name].append(dict(frame=frame,min=mn,max=mx,pelvis=list(pelvis)))
bind(rig,original_actions['Idle']);scene.frame_set(0);bpy.context.view_layer.update()
manifest=dict(name='Winter driver / detailed insulated civilian outfit',url='/models/person/person-winter.glb',sourceBlend='artifacts/blender/person.blend',sourceSHA256=SOURCE_HASH,editableWinterBlend='artifacts/blender/person-winter.blend',standingHeightMeters=1.8,wardrobeHeightMeters=hi[2]-lo[2],idleBounds=dict(min=lo,max=hi),forward='+Z',up='+Y',root='feet centred, ground Y=0',seatedPelvisLocalY=.95,interactionDurationSeconds=1.3,clips=clips,bones=original_bones,animationPoseSamples=samples,meshes=len(g['meshes']),materials=[m['name'] for m in g['materials']],textures=len(g.get('images',[])),vertices=sum(g['accessors'][p['attributes']['POSITION']]['count'] for m in g['meshes'] for p in m['primitives']),triangles=sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives']),glbBytes=len(data),sha256=hashlib.sha256(data).hexdigest(),previewImages=['person-winter-fullbody.png','person-winter-closeup.png','person-winter-seated.png'],details=['shallow quilt baffles and seam piping','fine woven cloth and wool knit textures','fitted folded hood and high collar','muted amber scarf with folded tail','beanie folded cuff with raised ribs','articulated gloves retain all finger skinning','handwarmer pocket zips and edge stitching','zipper pull hardware','small reflective shoulder tabs','substantial lug sole high-top boots retaining source laces/tread'],preservedOriginalSkeletonAndSixActions=True)
(WEB/'person-winter-manifest.json').write_text(json.dumps(manifest,indent=2))
print('PLAYER_WINTER_EXPORTED',json.dumps({k:manifest[k] for k in ['url','wardrobeHeightMeters','idleBounds','clips','meshes','materials','textures','vertices','triangles','glbBytes']}),flush=True)

# Studio objects are excluded from the runtime GLB, retained in editable source.
scene.render.engine='BLENDER_EEVEE';scene.eevee.taa_render_samples=24
scene.render.resolution_x=900;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.world.color=(.15,.15,.15);scene.view_settings.view_transform='AgX'
coll=bpy.data.collections.new('Winter studio / preview only');scene.collection.children.link(coll)
def studio_object(o):
    for c in list(o.users_collection):c.objects.unlink(o)
    coll.objects.link(o)
for loc,en,size,col in [((2,-3,4),400,3,(1,.88,.78)),((-3,-1,2),260,3,(.68,.80,1)),((1,2,3),450,2,(.9,.94,1))]:
    bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;studio_object(l);l.data.energy=en;l.data.shape='DISK';l.data.size=size;l.data.color=col;l.rotation_euler=(Vector((0,0,1))-l.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.004));floor=bpy.context.object;studio_object(floor)
m=bpy.data.materials.new('Winter Studio neutral');m.diffuse_color=(.075,.085,.10,1);floor.data.materials.append(m)
bpy.ops.object.camera_add(location=(2.5,-5,2.7));cam=bpy.context.object;studio_object(cam)
cam.rotation_euler=(Vector((0,0,.92))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=2.20;scene.camera=cam
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'person-winter.blend'))
if '--skip-renders' not in sys.argv:
    scene.render.filepath=str(OUT/'person-winter-fullbody.png');bpy.ops.render.render(write_still=True)
    cam.location=(.3,-3,1.84);cam.rotation_euler=(Vector((0,-.025,1.60))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.58
    scene.render.resolution_x=850;scene.render.resolution_y=850;scene.render.filepath=str(OUT/'person-winter-closeup.png');bpy.ops.render.render(write_still=True)
    bind(rig,original_actions['Seated']);scene.frame_set(0);bpy.context.view_layer.update()
    cam.location=(2.5,-4,2.5);cam.rotation_euler=(Vector((0,-.20,1))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=2.1
    scene.render.resolution_x=900;scene.render.resolution_y=1000;scene.render.filepath=str(OUT/'person-winter-seated.png');bpy.ops.render.render(write_still=True)
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==SOURCE_HASH,'Original source changed'
assert hashlib.sha256((WEB/'person.glb').read_bytes()).hexdigest()==ORIGINAL_GLB_HASH,'Original GLB changed'
print('PLAYER_WINTER_COMPLETE',str(path),flush=True)
