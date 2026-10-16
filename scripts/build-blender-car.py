"""Prepare the licensed Chiron reference in Blender for the driving game.

blender --background --disable-autoexec --factory-startup --python scripts/build-blender-car.py
Source attribution: public/models/bugatti/ATTRIBUTION.md. Scripts in source files
are never executed. The original UVs and material boundaries are retained.
"""
import bpy
import bmesh
import json
import math
import runpy
import shutil
from pathlib import Path
from mathutils import Matrix, Vector

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'artifacts'/'blender'
SOURCE=OUT/'reference-assets'/'Bugatti Chiron 2017'/'Bugatti Chiron 2017_1.0.blend'
TEX=ROOT/'public'/'models'/'bugatti'
TEX.mkdir(parents=True,exist_ok=True)
if not SOURCE.exists():raise RuntimeError('Download the CC BY source listed in ATTRIBUTION.md first.')
bpy.ops.wm.open_mainfile(filepath=str(SOURCE),use_scripts=False,load_ui=False)

# Fit the existing collision volume, retaining the source's flowing surfaces.
# Source front is -Y and Z is up; destination Blender front is +Y.
transform=Matrix(((.85,0,0,0),(0,-.9261658,0,-.052*.9261658),(0,0,.96556,.61963),(0,0,0,1)))
driver_door=bpy.data.objects['door_rf_ok']
passenger_door=bpy.data.objects['door_lf_ok']
driver_hinge=transform@bpy.data.objects['door_rf_Pivot'].matrix_world.translation
skip={'Interior','Interior_badge','interiorlights','movsteer_0.5','steer_badge','speedook','wheel','hub_rf','hub_lf','hub_rb','hub_lb','bump_rear','dvorleft','dvorright'}
material_map={
    'primary':'paint','secondary':'secondaryPaint','speedook.0':'trim','speedook.1':'alloy',
    'movsteer_0.5.0':'carbon','movsteer_0.5.3':'trim','chassis_ok.1':'trim','chassis_ok.4':'trim',
    'chassis_ok.5':'alloy','chassis_ok.6':'alloy','dvorleft.1':'badge','glass':'glass',
    'grill.0':'grilleFine','grill.1':'grilleDense','grill2.0':'grille','lights.0':'lights',
    'interior':'interior','interior.001':'interior','interior.002':'interior',
}
lamp_map={'headlights':'white','drl':'white','taillights':'red','brakelights':'red','turnlights_f':'amber','turnlights_r':'amber','platelights':'white'}
groups={}

# Keep the authored driver door and all of its children separate from the
# chassis before simplification. Material batches must not erase moving parts.
for obj in list(bpy.data.objects):
    if obj.type!='MESH' or obj.name in skip:continue
    ancestor=obj
    while ancestor and ancestor!=driver_door:ancestor=ancestor.parent
    part='driverDoor' if ancestor else 'body'
    if part=='body':
        ancestor=obj
        while ancestor and ancestor!=passenger_door:ancestor=ancestor.parent
        if ancestor:part='passengerDoor'
    source_data=obj.data
    for polygon in source_data.polygons:
        old=source_data.materials[polygon.material_index].name
        key=lamp_map.get(obj.name,material_map.get(old,'amber' if old.startswith('indicator') else 'trim'))
        panel_part=part
        if part=='body' and obj.name=='chassis_Mesh':
            perimeter=[transform@(obj.matrix_world@source_data.vertices[index].co) for index in polygon.vertices]
            if any(abs(point.x)>.50 and .30<point.z<1.35 and -1.10<-point.y<.92 for point in perimeter):
                panel_part='doorSurround'
        group=groups.setdefault((panel_part,key),{'p':[],'f':[],'uv':[],'smooth':[],'normals':[]})
        face=[];uv=[];normals=[]
        normal_matrix=(transform@obj.matrix_world).to_3x3().inverted().transposed()
        for loop_index in polygon.loop_indices:
            p=transform@(obj.matrix_world@source_data.vertices[source_data.loops[loop_index].vertex_index].co)
            if any(not math.isfinite(v) or abs(v)>10 for v in p):raise RuntimeError(f'Invalid source geometry: {obj.name}')
            face.append(len(group['p']));group['p'].append(tuple(p))
            uv.append(tuple(source_data.uv_layers.active.data[loop_index].uv) if source_data.uv_layers.active else (0,0))
            normals.append(tuple((normal_matrix@source_data.corner_normals[loop_index].vector).normalized()))
        # The fitted world transformation reverses handedness.
        group['f'].append(tuple(reversed(face)));group['uv'].append(list(reversed(uv)))
        group['smooth'].append(polygon.use_smooth)
        group['normals'].extend(reversed(normals))

bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
for old_material in bpy.data.materials:old_material.name='Source / '+old_material.name
for collection in list(bpy.data.collections):
    if collection.users==0:bpy.data.collections.remove(collection)
body=bpy.data.collections.new('Bugatti / game body');bpy.context.scene.collection.children.link(body)
body['driverDoorHinge']=(driver_hinge.x,driver_hinge.z,-driver_hinge.y)
reference=bpy.data.collections.new('Bugatti / wheel and cabin reference');bpy.context.scene.collection.children.link(reference)
studio=bpy.data.collections.new('Studio / presentation');bpy.context.scene.collection.children.link(studio)
# Retain enough authored topology for continuous panel seams, intake edges and
# individual headlight fittings. These static material batches add no draws.
ratios={'paint':.52,'secondaryPaint':.52,'trim':.065,'carbon':.075,'alloy':.13,'lights':.20,'white':.65,'red':.16,'amber':.6,'badge':.8,'interior':.20,'glass':.50,'grille':1,'grilleFine':1,'grilleDense':1}
colors={'paint':(.075,.084,.100),'secondaryPaint':(.043,.050,.061),'trim':(.014,.018,.023),'carbon':(.018,.023,.027),'alloy':(.31,.34,.38),'glass':(.018,.033,.042),'white':(.8,.9,1),'red':(.6,.005,.01),'amber':(1,.27,.008)}
textures={'badge':'badge.png','grille':'grill1.png','grilleFine':'grill2.png','grilleDense':'grill3.png','lights':'lights.png','interior':'interior.png'}
stats=[];game_materials={}
door_ratios={'paint':.45,'secondaryPaint':.45,'trim':.16,'carbon':.16,'alloy':.22,'interior':.35,'glass':1}
for (part,key),g in groups.items():
    name='Chiron / '+(part+' / ' if part!='body' else '')+key
    data=bpy.data.meshes.new(name);data.from_pydata(g['p'],[],g['f']);data.update()
    layer=data.uv_layers.new(name='Original Chiron UV')
    for polygon,uv,smooth in zip(data.polygons,g['uv'],g['smooth']):
        polygon.use_smooth=smooth
        for loop_index,value in zip(polygon.loop_indices,uv):layer.data[loop_index].uv=value
    data.normals_split_custom_set(g['normals'])
    high_resolution=data.copy()
    normal_source=bpy.data.objects.new('Temporary / source normals',high_resolution)
    studio.objects.link(normal_source);normal_source.hide_render=True
    # Weld the per-corner import only where positions and UVs agree; preserve
    # boundary seams and smoothing. Source's redundant interior edges dominate.
    bm=bmesh.new();bm.from_mesh(data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
    bmesh.ops.dissolve_degenerate(bm,dist=.0000001,edges=list(bm.edges))
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(data);bm.free()
    obj=bpy.data.objects.new(name,data);body.objects.link(obj);obj['carPart']=part
    mat=game_materials.get(key)
    if mat is None:
        mat=bpy.data.materials.new(key);mat.use_nodes=True;game_materials[key]=mat
        p=mat.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*colors.get(key,(1,1,1)),1)
        p.inputs['Metallic'].default_value=.62 if key in ('paint','secondaryPaint','alloy') else .1
        p.inputs['Roughness'].default_value=.23 if key in ('paint','secondaryPaint','alloy') else .5
        if key in ('paint','secondaryPaint'):p.inputs['Coat Weight'].default_value=1
        if key in ('white','red','amber'):
            p.inputs['Emission Color'].default_value=(*colors[key],1);p.inputs['Emission Strength'].default_value=2
        if key in textures:
            shutil.copyfile(SOURCE.parent/textures[key],TEX/textures[key])
            im=bpy.data.images.load(str(TEX/textures[key]),check_existing=True)
            texture=mat.node_tree.nodes.new('ShaderNodeTexImage');texture.image=im
            mat.node_tree.links.new(texture.outputs['Color'],p.inputs['Base Color'])
            if key=='badge':mat.node_tree.links.new(texture.outputs['Alpha'],p.inputs['Alpha'])
    data.materials.append(mat)
    raw=sum(len(p.vertices)-2 for p in data.polygons)
    ratio=door_ratios.get(key,ratios[key]) if part in ('driverDoor','passengerDoor') else ratios[key]
    preserve_seams=part in ('driverDoor','passengerDoor','doorSurround') or key=='glass'
    if preserve_seams:
        boundary_mesh=bmesh.new();boundary_mesh.from_mesh(data)
        boundary_positions={tuple(round(value,6) for value in vertex.co)
                            for edge in boundary_mesh.edges if edge.is_boundary for vertex in edge.verts}
        protected={vertex for edge in boundary_mesh.edges if edge.is_boundary for vertex in edge.verts}
        # Collapse decimation moves each material's border independently and
        # tears the shared shut lines/window seals. Dissolve only interior
        # coplanar edges. If Blender also removes a perimeter vertex, keep
        # that panel's source mesh so neighboring materials still meet exactly.
        # Only the retained bitmap cabin material needs interior UV seams.
        # Other panels use solid/procedural materials and retain their perimeter
        # UVs; baked source normals restore the original smooth reflections.
        interior_vertices=[vertex for vertex in boundary_mesh.verts if vertex not in protected]
        interior_edges=[edge for edge in boundary_mesh.edges if all(vertex not in protected for vertex in edge.verts)]
        bmesh.ops.dissolve_limit(boundary_mesh,verts=interior_vertices,edges=interior_edges,
                               angle_limit=math.radians(3),use_dissolve_boundaries=False,
                               delimit={'UV'} if key=='interior' else {'SHARP'})
        boundary_mesh.to_mesh(data);boundary_mesh.free()
        retained_positions={tuple(round(value,6) for value in vertex.co) for vertex in obj.data.vertices}
        if not boundary_positions.issubset(retained_positions):
            simplified=obj.data
            obj.data=high_resolution.copy();obj.data.materials.append(mat)
            bpy.data.meshes.remove(simplified)
            data=obj.data
        obj['protectedBoundaryVertices']=len(boundary_positions)
    elif ratio<1:
        bpy.context.view_layer.objects.active=obj
        mod=obj.modifiers.new('Game geometry optimization','DECIMATE');mod.ratio=ratio;mod.use_collapse_triangulate=True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # Reuse the artist's high-resolution surface normals after simplification.
    # This restores flowing automotive reflections without more GPU geometry.
    bpy.context.view_layer.objects.active=obj
    mod=obj.modifiers.new('Baked original surface normals','DATA_TRANSFER')
    mod.object=normal_source;mod.use_loop_data=True;mod.data_types_loops={'CUSTOM_NORMAL'}
    mod.loop_mapping='POLYINTERP_NEAREST'
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(normal_source,do_unlink=True);bpy.data.meshes.remove(high_resolution)
    obj.data.calc_loop_triangles();stats.append({'part':part,'material':key,'sourceTriangles':raw,'gameTriangles':len(obj.data.loop_triangles)})

# Thin parked blades follow the lower windshield instead of retaining the
# source's raised wiper arms, which obstruct the game's driver eye position.
for side in (-1,1):
    path=[(side*.035,.900,-1.414),(side*.23,.927,-1.337),(side*.39,.928,-1.286),(side*.53,.927,-1.210)]
    points=[];faces=[]
    for x,y,z in path:
        points.extend((x,-(z+dz),y+dy) for dz,dy in ((-.006,0),(.006,0),(.006,.005),(-.006,.005)))
    for i in range(len(path)-1):
        for j in range(4):
            a=4*i+j;b=4*i+(j+1)%4;faces.append((a,b,b+4,a+4))
    faces.extend(((3,2,1,0),(12,13,14,15)))
    data=bpy.data.meshes.new('Windshield / parked wiper');data.from_pydata(points,[],faces)
    bm=bmesh.new();bm.from_mesh(data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(data);bm.free()
    obj=bpy.data.objects.new('Windshield / parked wiper',data);body.objects.link(obj)
    data.materials.append(bpy.data.materials['trim'])

# The lightweight game cabin replaces the source interior. Close the deep
# quarter-window junction with a dark inner panel behind each seat.
for side in (-1,1):
    points=[(side*.635,-.38,1.18),(side*.680,-.60,1.16),(side*.760,-.86,1.065),(side*.795,-.73,.94),(side*.780,-.34,.95)]
    data=bpy.data.meshes.new('Cabin / inner quarter panel')
    data.from_pydata(points,[],[(0,1,2),(0,2,3),(0,3,4),(2,1,0),(3,2,0),(4,3,0)])
    obj=bpy.data.objects.new('Cabin / inner quarter panel',data);body.objects.link(obj)
    data.materials.append(bpy.data.materials['trim'])

# The reference photos' orange racing number is a small additional mesh.
curve=bpy.data.curves.new('Pur Sport grille number','FONT');curve.body='16';curve.align_x='CENTER';curve.size=.215;curve.resolution_u=1
number=bpy.data.objects.new('Pur Sport / orange grille 16',curve);body.objects.link(number)
number.location=(0,2.475,.278);number.rotation_euler=(math.pi/2,0,math.pi)
number.data.materials.append(bpy.data.materials['amber'])

# Complete reference wheels and cabin stay in their own collection. Runtime
# animates equivalent shared components without uploading duplicate body parts.
def game_mesh(name,points,faces,mat,smooth=False):
    data=bpy.data.meshes.new(name);data.from_pydata([(x,-z,y) for x,y,z in points],[],faces);data.update()
    obj=bpy.data.objects.new(name,data);reference.objects.link(obj);data.materials.append(mat)
    for p in data.polygons:p.use_smooth=smooth
    return obj
def ref_box(name,size,pos,mat):
    bpy.ops.mesh.primitive_cube_add(size=1,location=(pos[0],-pos[2],pos[1]))
    obj=bpy.context.object;obj.name=name;obj.dimensions=(size[0],size[2],size[1])
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    for c in list(obj.users_collection):c.objects.unlink(obj)
    reference.objects.link(obj);obj.data.materials.append(mat)
    mod=obj.modifiers.new('Soft edges','BEVEL');mod.width=.012;mod.segments=2
    return obj
def ref_mat(name,color,metal=0,rough=.5):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    p=mat.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    return mat
rubber=ref_mat('Reference rubber',(.013,.015,.018),rough=.87)
rim=ref_mat('Reference black forged alloy',(.028,.032,.039),.88,.21)
caliper=ref_mat('Reference orange ceramic brake',(.8,.19,.005),.32,.31)
leather=ref_mat('Reference black leather',(.027,.029,.034),rough=.8)
profile=[(.296,-.108),(.348,-.120),(.374,-.075),(.378,0),(.374,.075),(.348,.120),(.296,.108)]
for side in (-1,1):
    for axle in (-1,1):
        cx=side*(.827 if axle<0 else .8075);cz=axle*1.43
        points=[];faces=[]
        for i in range(48):
            angle=i*math.tau/48
            points.extend((cx+w,.385+math.cos(angle)*r,cz+math.sin(angle)*r) for r,w in profile)
        for i in range(48):
            for j in range(len(profile)-1):
                a=i*len(profile)+j;b=((i+1)%48)*len(profile)+j;faces.append((a,b,b+1,a+1))
        game_mesh('Reference / performance tire',points,faces,rubber,True)
        face=cx+side*.108
        bpy.ops.mesh.primitive_torus_add(major_segments=40,minor_segments=6,major_radius=.299,minor_radius=.008,location=(face,-cz,.385))
        obj=bpy.context.object;obj.name='Reference / black forged rim';obj.rotation_euler.y=math.pi/2
        for c in list(obj.users_collection):c.objects.unlink(obj)
        reference.objects.link(obj);obj.data.materials.append(rim)
        for i in range(5):
            a=i*math.tau/5
            for branch in (-1,1):
                angles=[a-.10,a+.10,a+branch*.16+.035,a+branch*.16-.035]
                radii=[.065,.065,.299,.299]
                pts=[(face,.385+math.cos(t)*r,cz+math.sin(t)*r) for t,r in zip(angles,radii)]
                game_mesh('Reference / forged Y spoke',pts,[(0,1,2,3)],rim)
        ref_box('Reference / orange brake caliper',(.045,.14,.085),(face-side*.03,.48,cz+.16),caliper)
    ref_box('Reference / leather seat',(.35,.10,.42),(side*.32,.49,.18),leather)
    back=ref_box('Reference / leather backrest',(.35,.44,.07),(side*.32,.76,.39),leather);back.rotation_euler.x=-.20
ref_box('Reference / dashboard',(1.16,.10,.25),(0,.84,-.67),leather)

# Presentation scene retained in the editable .blend.
def area(name,position,power,size):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
    obj=bpy.data.objects.new(name,data);studio.objects.link(obj);obj.location=position
    obj.rotation_euler=(Vector((0,0,.65))-obj.location).to_track_quat('-Z','Y').to_euler()
area('Front softbox',(-3,4,5),1200,5);area('Rear softbox',(3,-3,4),1450,4);area('Fill',(2,4,3),800,3)
data=bpy.data.cameras.new('Chiron hero camera');camera=bpy.data.objects.new('Chiron hero camera',data);studio.objects.link(camera)
camera.location=(-6,7,2.5);camera.rotation_euler=(Vector((0,0,.65))-camera.location).to_track_quat('-Z','Y').to_euler();data.lens=50
scene=bpy.context.scene;scene.camera=camera;scene.render.engine='CYCLES';scene.cycles.samples=24
scene.world.color=(.13,.13,.13);scene.render.resolution_x=1440;scene.render.resolution_y=900
scene.view_settings.view_transform='AgX'
for im in bpy.data.images:
    if im.users and im.size[0]>0:
        try:im.pack()
        except RuntimeError:pass
for screen in bpy.data.screens:
    for a in screen.areas:
        if a.type=='VIEW_3D':a.spaces.active.region_3d.view_perspective='CAMERA'
(OUT/'source-optimization.json').write_text(json.dumps(stats,indent=2))
print('Optimized source:',sum(s['gameTriangles'] for s in stats),'triangles',stats,flush=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'bugatti-chiron.blend'))
runpy.run_path(str(ROOT/'scripts'/'export-blender-car.py'),run_name='__main__')
