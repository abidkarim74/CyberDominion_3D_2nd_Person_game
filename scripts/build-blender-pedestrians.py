"""Author four winter pedestrians from the playable Remy source in Blender.

The source model is read, never overwritten. Clothing is edited from its fitted
shirt/cargo meshes and anatomical surface, retaining UVs, folds and skeleton.
Run Blender 5.2 --background --threads 4 --python this-file.
"""
from pathlib import Path
from math import pi, sin, cos, exp
import bpy, bmesh, json, struct, hashlib, sys
import numpy as np
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'; WEB=ROOT/'public'/'models'/'pedestrians'
OUT.mkdir(parents=True,exist_ok=True);WEB.mkdir(parents=True,exist_ok=True)
SOURCE=OUT/'person.blend'
SOURCE_HASH=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
STYLES={
 'parka':dict(coat=(.12,.20,.17),trousers=(.12,.14,.16),scarf=(.38,.25,.15),hat=(.19,.21,.16),hem=.74,pad=.022,head=(1.045,1.01,.98),jaw=1.08,nose=1.01,hair=.58,headwear='rib-knit beanie',face='broader jaw and cheeks; shorter face',hairStyle='cropped waves'),
 'puffer':dict(coat=(.11,.18,.27),trousers=(.19,.17,.15),scarf=(.32,.34,.32),hat=(.11,.18,.27),hem=.82,pad=.032,head=(.95,1.025,1.025),jaw=.9,nose=.96,hair=1.0,headwear='padded high collar; no hat',face='narrow oval face; fine jaw and longer forehead',hairStyle='textured swept crop'),
 'wool-coat':dict(coat=(.30,.23,.17),trousers=(.13,.14,.15),scarf=(.23,.31,.34),hat=(.30,.23,.17),hem=.64,pad=.018,head=(1.075,.99,1.0),jaw=1.025,nose=1.045,hair=.94,headwear='uncovered swept hair',face='wide cheekbones and prominent nose',hairStyle='side swept waves'),
 'anorak':dict(coat=(.30,.18,.12),trousers=(.16,.19,.17),scarf=(.20,.22,.26),hat=(.22,.19,.16),hem=.79,pad=.027,head=(.98,1.04,.97),jaw=.94,nose=1.08,hair=.58,headwear='knit trapper cap with ear flaps',face='rounded forehead; tapered jaw and deeper nose',hairStyle='short waves under cap'),
}

def bind(rig,action):
 rig.animation_data_create();rig.animation_data.action=action
 if len(action.slots):rig.animation_data.action_slot=action.slots[0]

def natural_walk(rig,action):
 # Keep the player's captured legs and grounded root; author civilian arms
 # in place of the reference motion's weapon-ready upper-body posture.
 from mathutils import Quaternion
 bind(rig,action)
 def aim(bone,direction):
  p=rig.pose.bones['mixamorig:'+bone]
  current=(rig.matrix_world.to_3x3()@(p.tail-p.head)).normalized()
  delta=current.rotation_difference(Vector(direction).normalized())
  world=rig.matrix_world@p.matrix;q=delta@world.to_quaternion()
  m=(rig.matrix_world.inverted().to_quaternion()@q).to_matrix().to_4x4();m.translation=p.matrix.translation
  p.matrix=m;bpy.context.view_layer.update()
 for frame in range(round(action.frame_range[1])+1):
  bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
  for side,sign in [('Left',1),('Right',-1)]:
   leg=rig.pose.bones['mixamorig:'+side+'UpLeg']
   direction=(rig.matrix_world.to_3x3()@(leg.tail-leg.head)).normalized()
   swing=-direction.y*.82
   aim(side+'Arm',(sign*.095,swing,-1))
   aim(side+'ForeArm',(-sign*.018,swing-.13,-1))
   aim(side+'Hand',(-sign*.035,swing-.16,-1))
   for suffix in ['Arm','ForeArm','Hand']:
    p=rig.pose.bones['mixamorig:'+side+suffix]
    p.keyframe_insert('location',frame=frame,group=p.name)
    p.keyframe_insert('rotation_quaternion',frame=frame,group=p.name)
    p.keyframe_insert('scale',frame=frame,group=p.name)

def ground_walk(rig,action,boots):
 bind(rig,action);hip=rig.pose.bones['mixamorig:Hips'];samples=[]
 for frame in range(round(action.frame_range[1])+1):
  bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
  lo,hi=bounds([boots]);delta=-lo[2]
  hip.location+=rig.matrix_world.inverted().to_3x3()@Vector((0,0,delta))
  hip.keyframe_insert('location',frame=frame,group=hip.name)
  bpy.context.view_layer.update();grounded=bounds([boots])[0][2]
  if frame%3==0:samples.append(dict(frame=frame,sourceMinZ=lo[2],correctionMeters=delta,groundedMinZ=grounded))
 return samples

def bounds(objects):
 dg=bpy.context.evaluated_depsgraph_get();pts=[]
 for o in objects:
  ev=o.evaluated_get(dg);m=ev.to_mesh();pts.extend(ev.matrix_world@v.co for v in m.vertices);ev.to_mesh_clear()
 return [min(p[i] for p in pts) for i in range(3)],[max(p[i] for p in pts) for i in range(3)]

def remove(o):bpy.data.objects.remove(o,do_unlink=True)

def subset(source,name,keep):
 o=source.copy();o.data=source.data.copy();bpy.context.scene.collection.objects.link(o);o.name=name
 bm=bmesh.new();bm.from_mesh(o.data);bm.faces.ensure_lookup_table()
 delete=[]
 for f in bm.faces:
  center=o.matrix_world@f.calc_center_median()
  if not keep(center):delete.append(f)
 bmesh.ops.delete(bm,geom=delete,context='FACES')
 unused=[v for v in bm.verts if not v.link_faces]
 if unused:bmesh.ops.delete(bm,geom=unused,context='VERTS')
 bm.to_mesh(o.data);bm.free();o.data.update()
 return o

def cloth_material(name,color,normal):
 m=bpy.data.materials.new(name);m.use_nodes=True;m.diffuse_color=(*color,1)
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1)
 p.inputs['Roughness'].default_value=.86;p.inputs['Specular IOR Level'].default_value=.23
 n=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=normal;n.interpolation='Linear'
 n.extension='REPEAT';uv=m.node_tree.nodes.new('ShaderNodeTexCoord')
 mapping=m.node_tree.nodes.new('ShaderNodeVectorMath');mapping.operation='SCALE';mapping.inputs[3].default_value=16
 m.node_tree.links.new(uv.outputs['UV'],mapping.inputs[0]);m.node_tree.links.new(mapping.outputs[0],n.inputs['Vector'])
 nm=m.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.19
 m.node_tree.links.new(n.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],p.inputs['Normal'])
 return m

def source_fabric_detail(mat,source,tint,color,label):
 p=source.node_tree.nodes.get('Principled BSDF')
 if not p or not p.inputs['Base Color'].is_linked:return
 node=p.inputs['Base Color'].links[0].from_node
 if node.type!='TEX_IMAGE' or not node.image:return
 image=node.image.copy();image.name='Pedestrian '+label+' fitted fabric diffuse'
 px=np.array(image.pixels[:],dtype=np.float32).reshape(-1,4)
 restored=px[:,:3]/np.array(tint,dtype=np.float32)
 gray=np.clip(restored@np.array([.2126,.7152,.0722]),.13,.96)
 px[:,:3]=gray[:,None];image.pixels.foreach_set(px.ravel());image.update();image.pack()
 nodes=mat.node_tree.nodes;links=mat.node_tree.links;pbs=nodes.get('Principled BSDF')
 tex=nodes.new('ShaderNodeTexImage');tex.image=image
 mult=nodes.new('ShaderNodeMixRGB');mult.blend_type='MULTIPLY';mult.inputs[0].default_value=1;mult.inputs[2].default_value=(*color,1)
 links.new(tex.outputs['Color'],mult.inputs[1]);links.new(mult.outputs[0],pbs.inputs['Base Color'])
 normals=[n for n in source.node_tree.nodes if n.type=='NORMAL_MAP']
 if normals and normals[0].inputs['Color'].is_linked:
  sn=normals[0].inputs['Color'].links[0].from_node
  if sn.type=='TEX_IMAGE' and sn.image:
   nt=nodes.new('ShaderNodeTexImage');nt.image=sn.image
   nm=nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.42
   links.new(nt.outputs['Color'],nm.inputs['Color']);links.new(nm.outputs['Normal'],pbs.inputs['Normal'])
 return image

def neutral_cloth_uv(o,cloth,uvname,center):
 # Sample an actual source chest UV, not empty white atlas background whose
 # normal map can be black and falsely turn a correctly tinted sleeve dark.
 uv=o.data.uv_layers.active or o.data.uv_layers.new(name=uvname);uv.name=uvname
 for loop in o.data.loops:
  p=o.matrix_world@o.data.vertices[loop.vertex_index].co
  uv.data[loop.index].uv=(center[0]+.007*sin(p.x*15),center[1]+.007*sin(p.z*15))

def knit_detail(mat,color,image):
 nodes=mat.node_tree.nodes;links=mat.node_tree.links;p=nodes.get('Principled BSDF')
 t=nodes.new('ShaderNodeTexImage');t.image=image
 uv=nodes.new('ShaderNodeTexCoord');links.new(uv.outputs['UV'],t.inputs['Vector'])
 mult=nodes.new('ShaderNodeMixRGB');mult.blend_type='MULTIPLY';mult.inputs[0].default_value=1;mult.inputs[2].default_value=(*color,1)
 links.new(t.outputs['Color'],mult.inputs[1]);links.new(mult.outputs[0],p.inputs['Base Color'])

def setmat(o,m):o.data.materials.clear();o.data.materials.append(m)

def weld(o):
 bm=bmesh.new();bm.from_mesh(o.data)
 bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.001)
 bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
 bm.to_mesh(o.data);bm.free();o.data.update()

def smooth(o):
 for p in o.data.polygons:p.use_smooth=True

def newgeo(name,vertices,faces,mat,template,weight_func):
 mesh=bpy.data.meshes.new(name+' / fitted topology')
 mesh.from_pydata([template.matrix_world.inverted()@Vector(v) for v in vertices],[],faces);mesh.update()
 o=template.copy();o.data=mesh;bpy.context.scene.collection.objects.link(o);o.name=name
 for group in list(o.vertex_groups):o.vertex_groups.remove(group)
 groups={b.name:o.vertex_groups.new(name=b.name) for b in rig.data.bones}
 for i,v in enumerate(vertices):
  weights=weight_func(Vector(v))
  for name,w in weights.items():
   if w>.001:groups[name].add([i],w,'REPLACE')
 setmat(o,mat);smooth(o)
 # World-sized planar UVs give every fitted addition a fine fabric weave.
 uv=mesh.uv_layers.new(name='FabricUV')
 for poly in mesh.polygons:
  for li in poly.loop_indices:
   v=vertices[mesh.loops[li].vertex_index];uv.data[li].uv=(v[0]*2,v[2]*2)
 return o

def rigid(bone):return lambda p:{'mixamorig:'+bone:1.}

def shell(name,rings,mat,template,weight_func,segments=48):
 # rings: center, X radius, Y radius. Tapered and elliptical, not primitives.
 verts=[];faces=[]
 for ri,(cx,cy,z,rx,ry) in enumerate(rings):
  for j in range(segments):
   a=2*pi*j/segments;fold=1+.006*sin(a*13+ri*.7)
   verts.append((cx+rx*cos(a)*fold,cy+ry*sin(a)*fold,z))
 for i in range(len(rings)-1):
  for j in range(segments):faces.append((i*segments+j,i*segments+(j+1)%segments,(i+1)*segments+(j+1)%segments,(i+1)*segments+j))
 return newgeo(name,verts,faces,mat,template,weight_func)

def ribbon(name,points,width,depth,mat,template,weight_func):
 verts=[];faces=[]
 for i,p in enumerate(points):
  p=Vector(p)
  # A softly folded flattened strip, with three cross-section columns.
  for x,bulge in [(-width*.5,0),(0,-depth),(width*.5,0)]:verts.append(tuple(p+Vector((x,bulge,0))))
 for i in range(len(points)-1):
  for j in range(2):faces.append((i*3+j,i*3+j+1,(i+1)*3+j+1,(i+1)*3+j))
 return newgeo(name,verts,faces,mat,template,weight_func)

def seam(name,points,radius,mat,template,weight_func):
 verts=[];faces=[];n=6
 for i,p in enumerate(points):
  tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
  tangent.normalize();u=tangent.cross(Vector((0,1,0))).normalized();v=tangent.cross(u).normalized()
  for j in range(n):verts.append(tuple(Vector(p)+radius*(u*cos(j*2*pi/n)+v*sin(j*2*pi/n))))
 for i in range(len(points)-1):
  for j in range(n):faces.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
 return newgeo(name,verts,faces,mat,template,weight_func)

def fit_weights(o):
 for g in list(o.vertex_groups):o.vertex_groups.remove(g)
 groups={b.name:o.vertex_groups.new(name=b.name) for b in rig.data.bones}
 for v in o.data.vertices:
  ws=nearest_weights(o.matrix_world@v.co)
  for name,w in ws.items():
   if w>.001:groups[name].add([v.index],w,'REPLACE')

def garment_surface_weights(p):
 # Remy's skin only exists where visible: it has no anatomical torso/thigh
 # below the source tee/shorts. Explicit anatomical regions are essential.
 if p.z>1.48:return {'mixamorig:Neck':.65,'mixamorig:Head':.35}
 if p.z>1.36:return {'mixamorig:Spine2':1.}
 if p.z>1.20:
  t=(p.z-1.20)/.16;return {'mixamorig:Spine1':1-t,'mixamorig:Spine2':t}
 if p.z>1.06:
  t=(p.z-1.06)/.14;return {'mixamorig:Spine':1-t,'mixamorig:Spine1':t}
 return {'mixamorig:Hips':1.}

def trouser_weights(p):
 side='Left' if p.x>0 else 'Right';up='mixamorig:'+side+'UpLeg';leg='mixamorig:'+side+'Leg'
 if p.z>.83:
  t=max(0,min(1,(p.z-.83)/.12));return {up:1-t,'mixamorig:Hips':t}
 if p.z>.54:return {up:1.}
 if p.z>.39:
  t=(p.z-.39)/.15;return {up:t,leg:1-t}
 return {leg:1.}

def assign_weights(o,weight_func):
 for g in list(o.vertex_groups):o.vertex_groups.remove(g)
 groups={b.name:o.vertex_groups.new(name=b.name) for b in rig.data.bones}
 for v in o.data.vertices:
  for name,w in weight_func(o.matrix_world@v.co).items():
   if w>.001:groups[name].add([v.index],w,'REPLACE')

def sculpt_head(o,cfg,hair=False):
 inv=o.matrix_world.inverted()
 for v in o.data.vertices:
  p=o.matrix_world@v.co
  if p.z<1.49 or abs(p.x)>.2:continue
  t=min(1,max(0,(p.z-1.49)/.10));sx,sy,sz=cfg['head']
  jaw=1+(cfg['jaw']-1)*exp(-((p.z-1.59)/.065)**2)
  p.x=(p.x-.004)*(1+(sx*jaw-1)*t)+.004
  p.y=(p.y+.008)*(1+(sy-1)*t)-.008
  p.z=1.60+(p.z-1.60)*(1+(sz-1)*t)
  if not hair and p.y<-.12:
   nose=exp(-((p.x-.005)/.028)**2-((p.z-1.654)/.034)**2)
   p.y-=(cfg['nose']-1)*.25*nose
  if hair:
   # Preserve the UV hair cards, crop volume toward the original scalp.
   if p.z>1.69:p.z=1.69+(p.z-1.69)*cfg['hair']
   if cfg['hair']<.7:
    p.x=.004+(p.x-.004)*.91;p.y=-.005+(p.y+.005)*.94
   else:p.x+=.018*max(0,(p.z-1.68)/.12)
  v.co=inv@p
 o.data.update()

def studio(name,objects):
 s=bpy.context.scene;s.render.engine='BLENDER_EEVEE';s.eevee.taa_render_samples=24
 s.render.resolution_x=780;s.render.resolution_y=1050;s.render.resolution_percentage=100
 s.render.image_settings.file_format='PNG';s.world.color=(.15,.15,.15);s.view_settings.view_transform='AgX'
 coll=bpy.data.collections.new('Studio / preview only');s.collection.children.link(coll)
 def move(o):
  for c in list(o.users_collection):c.objects.unlink(o)
  coll.objects.link(o)
 for loc,en,size,col in [((2,-3,4),350,3,(1,.86,.76)),((-3,-1,2),220,3,(.68,.80,1)),((1,2,3),450,2,(.9,.94,1))]:
  bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;move(l);l.data.energy=en;l.data.shape='DISK';l.data.size=size;l.data.color=col;l.rotation_euler=(Vector((0,0,1))-l.location).to_track_quat('-Z','Y').to_euler()
 bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.004));floor=bpy.context.object;move(floor)
 m=bpy.data.materials.new('Studio neutral');m.diffuse_color=(.08,.09,.11,1);floor.data.materials.append(m)
 bpy.ops.object.camera_add(location=(2.5,-5,2.7));cam=bpy.context.object;move(cam)
 cam.rotation_euler=(Vector((0,0,.92))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=2.2;s.camera=cam
 bpy.ops.wm.save_as_mainfile(filepath=str(OUT/f'pedestrians-{name}.blend'))
 if '--skip-renders' in sys.argv:return
 s.render.filepath=str(OUT/f'pedestrians-{name}.png');bpy.ops.render.render(write_still=True)
 cam.location=(.3,-3,1.84);cam.rotation_euler=(Vector((0,-.025,1.60))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.56
 s.render.resolution_x=700;s.render.resolution_y=700;s.render.filepath=str(OUT/f'pedestrians-{name}-head.png');bpy.ops.render.render(write_still=True)
 bind(rig,bpy.data.actions['Walk']);s.frame_set(8);bpy.context.view_layer.update()
 cam.location=(2.5,-5,2.7);cam.rotation_euler=(Vector((0,0,.92))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=2.2
 s.render.resolution_x=780;s.render.resolution_y=1050;s.render.filepath=str(OUT/f'pedestrians-{name}-walk.png');bpy.ops.render.render(write_still=True)
 bind(rig,bpy.data.actions['Idle']);s.frame_set(0);bpy.context.view_layer.update()

wanted=next((arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--only=')),None)
allstats=[]
if wanted and (WEB/'pedestrian-manifest.json').exists():
 allstats=[v for v in json.loads((WEB/'pedestrian-manifest.json').read_text())['variants'] if v['name']!=wanted]
for name,cfg in STYLES.items():
 if wanted and name!=wanted:continue
 bpy.ops.wm.open_mainfile(filepath=str(SOURCE));scene=bpy.context.scene
 rig=bpy.data.objects['PersonRig'];root=bpy.data.objects['PersonRoot']
 source=[o for o in scene.objects if o.type=='MESH' and o.name.startswith('Person /')]
 for o in list(scene.objects):
  if o not in source and o not in {rig,root}:remove(o)
 for track in list(rig.animation_data.nla_tracks):rig.animation_data.nla_tracks.remove(track)
 rig.animation_data.action=None
 for a in list(bpy.data.actions):
  if a.name not in {'Idle','Walk'}:bpy.data.actions.remove(a)
 for p in rig.pose.bones:p.matrix_basis=Matrix.Identity(4)
 bpy.context.view_layer.update()
 body=next(o for o in source if 'Body' in o.name);shirt=next(o for o in source if 'Tops' in o.name)
 trousers=next(o for o in source if 'Bottoms' in o.name);shoes=next(o for o in source if 'Shoes' in o.name)
 hair=next(o for o in source if 'Hair' in o.name)
 for o in [shirt,trousers]:weld(o)
 # Unmodified anatomical skin is the weight-transfer surface for long garments.
 kd=KDTree(len(body.data.vertices));skin_weights=[]
 for v in body.data.vertices:
  kd.insert(body.matrix_world@v.co,v.index)
  skin_weights.append({body.vertex_groups[g.group].name:g.weight for g in v.groups})
 kd.balance()
 def nearest_weights(p):
  found=kd.find_n(p,4);weights={};den=0
  for co,i,d in found:
   f=1/max(.0003,d)**2;den+=f
   for b,w in skin_weights[i].items():weights[b]=weights.get(b,0)+w*f
  weights={b:w/den for b,w in weights.items()};total=sum(weights.values())
  return {b:w/total for b,w in weights.items() if w/total>.001}
 # Woven fabric normal, stored as a real image so glTF carries the detail.
 im=bpy.data.images.new('Pedestrian woven fabric normal',width=128,height=128)
 yy,xx=np.mgrid[:128,:128];noise=np.random.default_rng(7).normal(0,.005,(128,128))
 pix=np.ones((128,128,4),dtype=np.float32);pix[:,:,0]=.5+.045*sin(0.)
 pix[:,:,0]=.5+.035*np.sin(xx*pi/2)+noise;pix[:,:,1]=.5+.035*np.sin(yy*pi/2)-noise;pix[:,:,2]=.995
 im.pixels.foreach_set(pix.ravel());im.colorspace_settings.name='Non-Color';im.pack()
 mats={k:cloth_material('Pedestrian_'+k,v,im) for k,v in [('Coat',cfg['coat']),('Trousers',cfg['trousers']),('Boots',(.055,.057,.06)),('Scarf',cfg['scarf']),('Hat',cfg['hat'])]}
 coatimage=source_fabric_detail(mats['Coat'],shirt.data.materials[0],(.19,.25,.28),cfg['coat'],'coat')
 source_fabric_detail(mats['Trousers'],trousers.data.materials[0],(.40,.43,.33),cfg['trousers'],'trousers')
 knit=bpy.data.images.new('Pedestrian knitted wool diffuse',width=128,height=128)
 kp=np.ones((128,128,4),dtype=np.float32)
 knitgray=.80+.065*np.sin(xx*pi/3+.55*np.sin(yy*pi/4))+.022*np.cos(yy*pi/2)
 kp[:,:,:3]=knitgray[:,:,None];knit.pixels.foreach_set(kp.ravel());knit.pack()
 for key in ['Scarf','Hat']:knit_detail(mats[key],cfg[key.lower()],knit)
 skinmat=body.data.materials[0];skinmat.name='Pedestrian_Skin'
 hair.data.materials[0].name='Pedestrian_Hair'
 for o in source:
  if 'Eyelashes' in o.name:o.data.materials[0].name='Pedestrian_Eyelashes'
 # Source cloth topology retains its seams, creases and a naturally fitted torso.
 shirt.name='Winter '+name+' / fitted coat';inv=shirt.matrix_world.inverted()
 for v in shirt.data.vertices:
  p=shirt.matrix_world@v.co;n=(shirt.matrix_world.to_3x3().inverted().transposed()@v.normal).normalized()
  torso=abs(p.x)<.235
  if torso:
   p.x*=1.04 if name=='wool-coat' else 1.06;p.y*=1.06
   if p.z<1.10:p.z=1.10+(p.z-1.10)*(1.10-cfg['hem'])/(1.10-.85448)
   if p.z<1.05:
    flare=max(0,min(1,(1.05-p.z)/max(.12,1.05-cfg['hem'])))
    flare=flare*flare*(3-2*flare)
    p.x*=1+.12*flare;p.y=.015+(p.y-.015)*(1+.72*flare)
  # Avoid exaggerating the source shirt's doubled-over seam into a rolled rim.
  hem_padding=max(.18,min(1,(p.z-cfg['hem'])/.06)) if torso else 1
  p+=n*cfg['pad']*hem_padding
  if name=='puffer' and torso:
   # Sculpt actual shallow quilt channels around the torso, with soft baffles.
   q=.5+.5*cos((p.z-.85)*2*pi/.105);p+=n*.010*q
  v.co=inv@p
 shirt.data.update();setmat(shirt,mats['Coat'])
 # The lengthened coat hem follows a little of each thigh's swing so trousers
 # remain beneath the cloth instead of cutting through a pelvis-rigid skirt.
 for v in shirt.data.vertices:
  p=shirt.matrix_world@v.co
  if p.z>=.94:continue
  blend=.32*max(0,min(1,(.94-p.z)/max(.08,.94-cfg['hem'])))
  existing={shirt.vertex_groups[g.group].name:g.weight*(1-blend) for g in v.groups}
  left=max(0,min(1,.5+p.x/.10))
  existing['mixamorig:LeftUpLeg']=existing.get('mixamorig:LeftUpLeg',0)+blend*left
  existing['mixamorig:RightUpLeg']=existing.get('mixamorig:RightUpLeg',0)+blend*(1-left)
  for g in shirt.vertex_groups:g.remove([v.index])
  for key,w in existing.items():
   if w>.001:shirt.vertex_groups[key].add([v.index],w,'REPLACE')
 sleeves=subset(body,'Winter '+name+' / anatomical long sleeves',lambda p:.275<abs(p.x)<.733 and 1.23<p.z<1.60)
 weld(sleeves)
 inv=sleeves.matrix_world.inverted()
 for v in sleeves.data.vertices:
  p=sleeves.matrix_world@v.co;n=(sleeves.matrix_world.to_3x3().inverted().transposed()@v.normal).normalized()
  cuff=max(0,min(1,(.735-abs(p.x))/.09));thick=.012+cfg['pad']*.55*cuff
  p+=n*thick;v.co=inv@p
 sleeves.data.update();setmat(sleeves,mats['Coat'])
 # All exposed hand topology becomes fitted leather/knit gloves; no toy mittens.
 gloves=subset(body,'Winter '+name+' / fitted gloves',lambda p:abs(p.x)>.718 and p.z>1.20)
 setmat(gloves,mats['Boots'])
 # The original cargo mesh becomes full-length trousers, tapered at the ankle.
 inv=trousers.matrix_world.inverted()
 for v in trousers.data.vertices:
  p=trousers.matrix_world@v.co
  if p.z<.65:
   p.z=.65+(p.z-.65)*(.65-.055)/(.65-.37534)
   taper=.72+.28*max(0,min(1,(p.z-.055)/.595));cx=.09 if p.x>0 else -.09
   p.x=cx+(p.x-cx)*taper;p.y=.018+(p.y-.018)*taper
  v.co=inv@p
 trousers.name='Winter '+name+' / full length cargo trousers';trousers.data.update();setmat(trousers,mats['Trousers']);assign_weights(trousers,trouser_weights)
 if name=='wool-coat':
  # The longest coat permanently occludes the upper trousers. Omit that hidden
  # geometry, retaining an 8cm overlap above the hem throughout the stride.
  bm=bmesh.new();bm.from_mesh(trousers.data)
  cut=[f for f in bm.faces if (trousers.matrix_world@f.calc_center_median()).z>cfg['hem']+.08]
  bmesh.ops.delete(bm,geom=cut,context='FACES')
  unused=[v for v in bm.verts if not v.link_faces]
  if unused:bmesh.ops.delete(bm,geom=unused,context='VERTS')
  bm.to_mesh(trousers.data);bm.free();trousers.data.update()
 # Retain real shoe tread/toe/lace geometry, darken to snow footwear.
 shoes.name='Winter '+name+' / leather walking boots';setmat(shoes,mats['Boots'])
 inv=shoes.matrix_world.inverted()
 for v in shoes.data.vertices:
  p=shoes.matrix_world@v.co;cx=.09 if p.x>0 else -.09
  p.x=cx+(p.x-cx)*1.045
  if p.z>.015:p.z=.015+(p.z-.015)*1.17
  v.co=inv@p
 shoes.data.update()
 # Remove hidden anatomy rather than rendering a second body under garments.
 visible=subset(body,'Winter '+name+' / realistic face and neck',lambda p:p.z>1.475 and abs(p.x)<.19)
 remove(body);source.remove(body)
 # Facial changes are authored in source topology, including matching eyes/cards.
 for o in [visible,hair]+[o for o in source if 'Eyes' in o.name or 'Eyelashes' in o.name]:sculpt_head(o,cfg,hair=o==hair)
 head_top=max((hair.matrix_world@v.co).z for v in hair.data.vertices)
 extras=[]
 # A scarf wraps the neckline and covers the tee's V opening naturally.
 scarf=shell('Winter '+name+' / draped knit neck scarf',[(0,.006,1.455,.081,.094),(0,.004,1.485,.085,.092),(0,.006,1.522,.081,.083),(0,.008,1.55,.072,.075)],mats['Scarf'],visible,garment_surface_weights)
 extras.append(scarf)
 # A sweater inset closes the source V opening beneath the jacket collar.
 insetrows=[(1.505,.14,-.088),(1.455,.13,-.12),(1.405,.10,-.125),(1.345,.04,-.13),(1.31,.008,-.13)]
 iv=[];iff=[]
 for z,w,y in insetrows:
  iv.extend([(-w*.5,y,z),(0,y-.003,z),(w*.5,y,z)])
 for i in range(len(insetrows)-1):
  for j in range(2):iff.append((i*3+j,i*3+j+1,(i+1)*3+j+1,(i+1)*3+j))
 extras.append(newgeo('Winter '+name+' / warm closed neck inset',iv,iff,mats['Coat'],visible,garment_surface_weights))
 if name in {'parka','anorak','wool-coat'}:
  pts=[(-.025,-.101,1.51),(-.035,-.17,1.46),(-.04,-.199-cfg['pad'],1.405),(-.048,-.202-cfg['pad'],1.35),(-.06,-.198-cfg['pad'],1.29),(-.059,-.188-cfg['pad'],1.23),(-.055,-.183-cfg['pad'],1.18 if name=='wool-coat' else 1.20)]
  extras.append(ribbon('Winter '+name+' / folded scarf tail',pts,.065,.006,mats['Scarf'],visible,garment_surface_weights))
 # Tailored collar follows the shoulders with a real open neck, no exposed chest.
 extras.append(shell('Winter '+name+' / structured stand collar',[(0,.025,1.445,.108,.109),(0,.024,1.475,.103,.103),(0,.022,1.505,.090,.095)],mats['Coat'],visible,garment_surface_weights))
 if name=='puffer':
  extras.append(shell('Winter puffer / padded hood down',[(0,.064,1.425,.145,.13),(0,.070,1.465,.144,.13),(0,.060,1.502,.122,.113),(0,.044,1.521,.103,.10)],mats['Coat'],visible,garment_surface_weights))
 if name=='wool-coat':
  for sign in (-1,1):
   # Four-sided lapels with an extra fold along their outer edge.
   pts=[(sign*.073,-.115,1.49),(sign*.113,-.172,1.425),(sign*.13,-.19,1.365),(sign*.055,-.195,1.24)]
   extras.append(ribbon('Winter wool coat / notched lapel',pts,.064,.008,mats['Coat'],visible,garment_surface_weights))
 # Small visible closures and pocket welts add human-scale garment structure.
 front=-.19-cfg['pad']
 extras.append(seam('Winter '+name+' / front zipper',[(.005,front,1.435),(.005,front-.007,1.32),(.005,front-.007,1.12),(.005,front,cfg['hem']+.025)],.0028,mats['Boots'],visible,garment_surface_weights))
 for sign in (-1,1):
  extras.append(seam('Winter '+name+' / slanted pocket welt',[(sign*.095,front+.014,1.06),(sign*.145,front+.02,.985)],.0045,mats['Boots'],visible,garment_surface_weights))
 # Caps are fitted, ribbed ellipsoid cloth shells, weighted to the actual head.
 if name in {'parka','anorak'}:
  rings=[(.003,.003,1.713,.126,.116),(.003,.004,1.735,.128,.118),(.003,.005,1.757,.121,.113),(.003,.01,1.79,.113,.102),(.006,.016,1.825,.089,.083),(.008,.018,1.849,.055,.053),(.008,.018,1.858,.008,.008)]
  extras.append(shell('Winter '+name+' / fitted rib knit cap',rings,mats['Hat'],visible,rigid('Head'),segments=48))
  extras.append(shell('Winter '+name+' / folded ribbed hat cuff',[(.003,.003,1.712,.129,.120),(.003,.003,1.73,.132,.123),(.003,.004,1.753,.128,.120)],mats['Hat'],visible,rigid('Head'),segments=64))
  if name=='anorak':
   for sign in (-1,1):
    verts=[];faces=[]
    for i,(z,w,y) in enumerate([(1.743,.027,.005),(1.697,.031,.008),(1.655,.027,.012),(1.635,.013,.014)]):
     for j in range(5):
      a=(j/4-.5)*pi*.8;verts.append((sign*(.112+.010*cos(a)),y+w*sin(a),z))
    for i in range(3):
     for j in range(4):faces.append((i*5+j,i*5+j+1,(i+1)*5+j+1,(i+1)*5+j))
    extras.append(newgeo('Winter anorak / knit ear flaps',verts,faces,mats['Hat'],visible,rigid('Head')))
 objects=[shirt,trousers,shoes,hair,sleeves,gloves,visible]+[o for o in source if 'Eyes' in o.name or 'Eyelashes' in o.name]+extras
 # Anatomical forearm UVs sampled black empty regions of the shirt atlas.
 # Remap all newly fitted coat parts to a clean cloth patch and common UV set.
 bestloop=min(shirt.data.loops,key=lambda l:((shirt.matrix_world@shirt.data.vertices[l.vertex_index].co)-Vector((-.11,-.18,1.28))).length)
 clothcenter=shirt.data.uv_layers.active.data[bestloop.index].uv.copy()
 for o in objects:
  if o!=shirt and len(o.data.materials)==1 and o.data.materials[0]==mats['Coat']:
   neutral_cloth_uv(o,coatimage,shirt.data.uv_layers.active.name,clothcenter)
 # Join fitted garment sections by semantic material to limit draw calls.
 for mat in list(mats.values()):
  group=[o for o in objects if o.name in bpy.data.objects and len(o.data.materials)==1 and o.data.materials[0]==mat]
  if len(group)<2:continue
  bpy.ops.object.select_all(action='DESELECT')
  for o in group:o.select_set(True)
  bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join()
  objects=[o for o in objects if o not in group[1:]]
  if mat==mats['Scarf']:
   o=group[0];mod=o.modifiers.new('Soft knit drape','SUBSURF');mod.levels=1
   while list(o.modifiers).index(mod)>0:bpy.ops.object.modifier_move_up(modifier=mod.name)
   bpy.ops.object.modifier_apply(modifier=mod.name)
   mod=o.modifiers.new('Warm fabric thickness','SOLIDIFY');mod.thickness=.22
   # Source mesh coordinates are centimetres, so .22 is ~2.3mm in world space.
   while list(o.modifiers).index(mod)>0:bpy.ops.object.modifier_move_up(modifier=mod.name)
   bpy.ops.object.modifier_apply(modifier=mod.name)
 # The eyes retain their own UV layer and material binding; joining differing
 # source UV layer names can discard their pupil atlas in Blender's join op.
 for o in objects:
  if 'Eyes' in o.name:
   m=o.data.materials[0].copy();m.name='Pedestrian_Eyes';o.data.materials[0]=m
 for o in objects:
  smooth(o)
  # A conservative collapse on dense source hair/shoes reduces crowd triangles.
  if o==hair or o==shoes:
   bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
   mod=o.modifiers.new('Crowd topology optimization','DECIMATE');mod.ratio=.56 if o==hair else .62
   while list(o.modifiers).index(mod)>0:bpy.ops.object.modifier_move_up(modifier=mod.name)
   bpy.ops.object.modifier_apply(modifier=mod.name)
 for image in bpy.data.images:
  if image.name not in {'Render Result','Viewer Node'}:
   try:image.pack()
   except RuntimeError:pass
 idle=bpy.data.actions['Idle'];walk=bpy.data.actions['Walk']
 natural_walk(rig,walk)
 grounding=ground_walk(rig,walk,shoes)
 for action in [idle,walk]:
  action.use_fake_user=True;t=rig.animation_data.nla_tracks.new();t.name=action.name;t.mute=True
  s=t.strips.new(action.name,0,action)
  if len(action.slots):s.action_slot=action.slots[0]
 bind(rig,idle);scene.frame_set(0);bpy.context.view_layer.update()
 lo,hi=bounds(objects)
 root.name='PedestrianRoot';rig.name='PedestrianRig'
 root['derived_from']='Editable player person.blend / Mixamo Remy';root['wardrobe']=name;root['head_sculpt']=cfg['face']
 root['asset_contract']='Player scale; forward +Z in glTF, up +Y; feet origin; in-place Idle and Walk'
 bpy.ops.object.select_all(action='DESELECT');root.select_set(True);rig.select_set(True)
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=rig
 path=WEB/f'{name}.glb'
 # Blender bakes MixRGB colour multiplication into exported image bytes.
 # Runtime wardrobe colours must multiply a neutral albedo once. Keep the
 # editable source/preview colours, neutralize export, then restore them.
 export_palette=[]
 for mat in mats.values():
  pbs=mat.node_tree.nodes.get('Principled BSDF')
  state=dict(mat=mat,diffuse=tuple(mat.diffuse_color),pbs=tuple(pbs.inputs['Base Color'].default_value),mix=[])
  mat.diffuse_color=(1,1,1,1);pbs.inputs['Base Color'].default_value=(1,1,1,1)
  for node in mat.node_tree.nodes:
   if node.type=='MIX_RGB' and node.blend_type=='MULTIPLY':
    state['mix'].append((node,tuple(node.inputs[2].default_value)));node.inputs[2].default_value=(1,1,1,1)
  export_palette.append(state)
 bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='ACTIONS',export_force_sampling=True,export_optimize_animation_size=True,export_def_bones=False,export_leaf_bone=False,export_image_format='JPEG',export_jpeg_quality=85,export_materials='EXPORT',export_extras=True)
 for state in export_palette:
  state['mat'].diffuse_color=state['diffuse'];state['mat'].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=state['pbs']
  for node,color in state['mix']:node.inputs[2].default_value=color
 d=path.read_bytes();length,kind=struct.unpack_from('<II',d,12);g=json.loads(d[20:20+length])
 stat=dict(name=name,url=f'/models/pedestrians/{name}.glb',authoredHeightMeters=hi[2]-lo[2],idleBounds=dict(min=lo,max=hi),walkGrounding=grounding,headShapeDescription=cfg['face'],headwear=cfg['headwear'],hairStyle=cfg['hairStyle'],sourcePlayerModel='artifacts/blender/person.blend',sourcePlayerSHA256=SOURCE_HASH,sourceBlend=f'artifacts/blender/pedestrians-{name}.blend',sha256=hashlib.sha256(d).hexdigest(),meshes=len(g['meshes']),materials=[m['name'] for m in g['materials']],skins=len(g['skins']),textures=len(g.get('images',[])),vertices=sum(g['accessors'][p['attributes']['POSITION']]['count'] for m in g['meshes'] for p in m['primitives']),triangles=sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives']),glbBytes=len(d),clips=[dict(name=a['name'],durationSeconds=max(g['accessors'][s['input']]['max'][0] for s in a['samplers'])) for a in g['animations']])
 allstats.append(stat);allstats.sort(key=lambda v:list(STYLES).index(v['name']));print('PEDESTRIAN_EXPORTED',json.dumps(stat),flush=True)
 studio(name,objects)
 manifest=dict(sourcePlayerModel='artifacts/blender/person.blend',sourcePlayerSHA256=SOURCE_HASH,forward='+Z',up='+Y',anatomyStandingHeightMeters=1.8,runtimeBaseScale=.8464,materialTintNames=['Pedestrian_Coat','Pedestrian_Trousers','Pedestrian_Boots','Pedestrian_Scarf','Pedestrian_Hat','Pedestrian_Hair','Pedestrian_Skin'],variants=allstats)
 (WEB/'pedestrian-manifest.json').write_text(json.dumps(manifest,indent=2))

assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==SOURCE_HASH,'Player source was changed'
print('PEDESTRIANS_COMPLETE',len(allstats),flush=True)
