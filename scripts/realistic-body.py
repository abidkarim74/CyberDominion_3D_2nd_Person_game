"""Complete sleeveless anatomy and tailor a clean continuous athletic tank.

All positions are authored in the canonical 1.8 m T-pose and skinned to the
original Mixamo joints. No disconnected rigid shoulder primitives are used.
"""
from math import pi, sin, cos, sqrt, exp
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


def refine_body(rig, root, skin, tank, skinmat, tankmat):
    # The old body's cropped chin must not remain in front of the scanned neck.
    bm=bmesh.new();bm.from_mesh(skin.data)
    cut=[]
    for face in bm.faces:
        p=skin.matrix_world@face.calc_center_median()
        if abs(p.x)<.125 and ((p.z>1.50 and p.y<-.060) or p.z>1.535):cut.append(face)
    bmesh.ops.delete(bm,geom=cut,context='FACES')
    unused=[v for v in bm.verts if not v.link_faces]
    if unused:bmesh.ops.delete(bm,geom=unused,context='VERTS')
    bm.to_mesh(skin.data);bm.free();skin.data.update()
    def smoothstep(a, b, x):
        t = max(0, min(1, (x-a)/(b-a)))
        return t*t*(3-2*t)

    def make(name, vertices, faces, material, weights, uvs=None):
        mesh = bpy.data.meshes.new(name + ' / anatomical quad topology')
        mesh.from_pydata(vertices, [], faces); mesh.update()
        obj = bpy.data.objects.new(name, mesh); bpy.context.scene.collection.objects.link(obj)
        obj.parent = root; obj.matrix_world = Matrix.Identity(4)
        obj.data.materials.append(material)
        groups = {}
        for index, point in enumerate(vertices):
            for name, weight in weights(Vector(point)).items():
                if weight < .0001: continue
                if name not in groups: groups[name] = obj.vertex_groups.new(name=name)
                groups[name].add([index], weight, 'REPLACE')
        arm = obj.modifiers.new('Continuous original anatomical skinning', 'ARMATURE'); arm.object = rig
        for polygon in mesh.polygons: polygon.use_smooth = True
        if uvs:
            layer = mesh.uv_layers.new(name='Detailed surface UV')
            for loop in mesh.loops: layer.data[loop.index].uv = uvs[loop.vertex_index]
        bm = bmesh.new(); bm.from_mesh(mesh); bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces)); bm.to_mesh(mesh); bm.free()
        return obj

    def torso_weights(p):
        if p.z < .95: return {'mixamorig:Hips': 1}
        t = smoothstep(.95, 1.18, p.z)
        high = smoothstep(1.18, 1.40, p.z)
        if t < 1: return {'mixamorig:Hips': 1-t, 'mixamorig:Spine': t}
        return {'mixamorig:Spine': 1-high, 'mixamorig:Spine2': high}

    # Weld new deltoids into the original proximal arm boundary. Keeping the
    # exact existing boundary vertices and UVs removes any elbow cuff or color
    # seam and preserves the forearm's mapped anatomy down to the fingertips.
    bm=bmesh.new();bm.from_mesh(skin.data);bm.verts.ensure_lookup_table();bm.verts.index_update()
    deform=bm.verts.layers.deform.verify();uvlayer=bm.loops.layers.uv.active
    adjacency={}
    for edge in bm.edges:
        if edge.is_boundary:
            a,b=[v.index for v in edge.verts];adjacency.setdefault(a,[]).append(b);adjacency.setdefault(b,[]).append(a)
    visited=set();armloops=[]
    for start in adjacency:
        if start in visited:continue
        current=start;last=None;loop=[]
        while current not in visited:
            visited.add(current);loop.append(bm.verts[current]);candidates=[n for n in adjacency[current] if n!=last]
            if not candidates:break
            last,current=current,candidates[0]
        points=[skin.matrix_world@v.co for v in loop]
        if len(points)>8 and min(abs(p.x) for p in points)>.25 and max(abs(p.x) for p in points)<.39:armloops.append(loop)
    inverse=skin.matrix_world.inverted()
    for boundary in armloops:
        points=[skin.matrix_world@v.co for v in boundary]
        side='Left' if points[0].x>0 else 'Right';sign=1 if side=='Left' else -1
        center=sum(points,Vector())/len(points);rx=abs(center.x)
        boundary_uv=[v.link_loops[0][uvlayer].uv.copy() for v in boundary]
        groupids={name:skin.vertex_groups['mixamorig:'+side+name].index for name in ['Shoulder','Arm']}
        previous=boundary;previous_uv=boundary_uv
        for step in range(1,29):
            t=step/28;x=rx-(rx-.115)*t
            radius= .063 + .025*exp(-((x-.195)/.052)**2)-.028*exp(-((x-.112)/.026)**2)
            ring=[];ringuv=[]
            for j,p in enumerate(points):
                dy=p.y-center.y;dz=p.z-center.z;length=sqrt(dy*dy+dz*dz)
                blend=smoothstep(0,.32,t)
                target=Vector((sign*x,center.y+dy/length*radius,center.z+dz/length*radius))
                # The source sleeve cut is curved in X. Flattening its first
                # new ring folds some quads backwards into a visible cuff.
                # Carry that contour through the transition in all axes.
                target.x+=(p.x-sign*rx)*(1-blend)
                target.y+=(p.y-(center.y+dy/length*.063))*(1-blend)
                target.z+=(p.z-(center.z+dz/length*.063))*(1-blend)
                v=bm.verts.new(inverse@target);shoulder=1-smoothstep(.115,.185,x)
                v[deform][groupids['Shoulder']]=shoulder;v[deform][groupids['Arm']]=1-shoulder
                tex=boundary_uv[j].copy()
                tangent=boundary_uv[(j+1)%len(boundary)]-boundary_uv[j-1]
                if tangent.length>.00001:
                    tangent.normalize();tex.x-=tangent.y*.002*t;tex.y+=tangent.x*.002*t
                ring.append(v);ringuv.append(tex)
            for j in range(len(boundary)):
                k=(j+1)%len(boundary)
                face=bm.faces.new((previous[j],previous[k],ring[k],ring[j]));face.smooth=True
                for loop,coord in zip(face.loops,[previous_uv[j],previous_uv[k],ringuv[k],ringuv[j]]):loop[uvlayer].uv=coord
            previous=ring;previous_uv=ringuv
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(skin.data);bm.free();skin.data.update()
    # Imported FBX split normals were authored when the arm was an open cut.
    # Rebuild smooth normals across the welded rings instead of retaining that
    # old cut edge as a dark cuff in the completed continuous skin.
    for polygon in skin.data.polygons:polygon.use_smooth=True
    if skin.data.has_custom_normals:
        bpy.ops.object.select_all(action='DESELECT');skin.select_set(True);bpy.context.view_layer.objects.active=skin
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    assert len(armloops)==2,'Both anatomical arm boundaries must be bridged'

    # Project the original shirt's real cloth folds and UV atlas onto the new
    # sleeveless tailoring, retaining its detailed albedo and normal textures.
    tank.data.calc_loop_triangles()
    source_points=[tank.matrix_world@v.co for v in tank.data.vertices]
    triangles=[tuple(tri.vertices) for tri in tank.data.loop_triangles]
    source_uv=[tuple(tank.data.uv_layers.active.data[i].uv) for i in range(len(tank.data.loops))]
    triangle_uv=[tuple(Vector((*source_uv[i],0)) for i in tri.loops) for tri in tank.data.loop_triangles]
    source_tree=BVHTree.FromPolygons(source_points,triangles,all_triangles=True)
    def project(point):
        nearest,_,index,_=source_tree.find_nearest(Vector(point))
        tri=triangles[index];coords=triangle_uv[index]
        tex=barycentric_transform(nearest,*[source_points[i] for i in tri],*coords)
        return nearest,(tex.x,tex.y)

    # Replace the source's ragged sleeve cuts and deep V with one continuous
    # tailored garment: front/back panels meet below armpits and over shoulders.
    # The three remaining boundaries are the hem, neck and true arm openings.
    vertices=[]; faces=[]; uv=[]; nx=48; ny=40; panels={}
    for back in (False,True):
        grid=[]
        for row in range(ny+1):
            t=row/ny; indices=[]
            for col in range(nx+1):
                u=-1+2*col/nx; au=abs(u)
                neck=1-sqrt(max(0,1-min(1,au/.46)**2))
                # Straps follow the trapezius down to the deltoid instead of
                # forming a broad horizontal shelf beside a long bare neck.
                top=(1.488 if back else 1.446)+(.018 if back else .060)*neck-.045*smoothstep(.50,1,au)
                z=.855+(top-.855)*t
                chest=.023*exp(-((z-1.30)/.14)**2)
                rx=.192+chest-.008*smoothstep(1.34,1.49,z)
                x=u*rx
                arc=sqrt(max(0,1-u*u))
                depth=(.117 if back else .130)+.009*exp(-((z-1.30)/.13)**2)
                y=.027+(1 if back else -1)*depth*arc
                # Above the axilla, separate panel edges to follow the front
                # and back deltoid instead of closing a sleeve over the arm.
                y+=(1 if back else -1)*.041*smoothstep(1.28,1.49,z)*au**8
                mapped,tex=project((x,y,z))
                foldweight=(1-smoothstep(1.30,1.41,z))*(1-smoothstep(.90,1,au))
                y=y*(1-foldweight)+mapped.y*foldweight
                y+=.0022*sin(z*61+u*4)*sin(pi*t)**2+.0012*sin(u*31+z*24)
                indices.append(len(vertices));vertices.append((x,y,z));uv.append(tex)
            grid.append(indices)
        panels[back]=grid
        for row in range(ny):
            for col in range(nx):
                ids=(grid[row][col],grid[row][col+1],grid[row+1][col+1],grid[row+1][col])
                faces.append(tuple(reversed(ids)) if back else ids)
    for side_col in (0,nx):
        front=panels[False];back=panels[True]
        for row in range(ny):
            if vertices[front[row+1][side_col]][2] > 1.292:continue
            faces.append((front[row][side_col],back[row][side_col],back[row+1][side_col],front[row+1][side_col]))
    # Shared top edges form genuine shoulder straps; leave the central U open.
    for col in range(nx):
        if abs(-1+2*(col+.5)/nx)<.44:continue
        faces.append((panels[False][-1][col],panels[True][-1][col],panels[True][-1][col+1],panels[False][-1][col+1]))

    pbs=tankmat.node_tree.nodes.get('Principled BSDF')
    tex=pbs.inputs['Base Color'].links[0].from_node
    image=tex.image.copy();image.name='Realistic / mapped worn olive cotton folds'
    pixels=np.asarray(image.pixels[:],dtype=np.float32).reshape(-1,4)
    detail=np.clip((pixels[:,:3]/np.array([.19,.25,.28]))@np.array([.2126,.7152,.0722]),.04,.95)
    pixels[:,:3]=(detail[:,None]*.78+.22)*np.array([.14,.16,.095])
    image.pixels.foreach_set(pixels.ravel());image.update();image.pack();tex.image=image
    tailored=make('Realistic / tailored continuous olive athletic tank',vertices,faces,tankmat,torso_weights,uv)
    # Keep the caller's object identity while replacing geometry/weights.
    old=tank.data;tank.data=tailored.data.copy();tank.matrix_world=Matrix.Identity(4)
    for group in list(tank.vertex_groups):tank.vertex_groups.remove(group)
    for group in tailored.vertex_groups:tank.vertex_groups.new(name=group.name)
    for v in tailored.data.vertices:
        for group in v.groups:tank.vertex_groups[group.group].add([v.index],group.weight,'REPLACE')
    bpy.data.objects.remove(tailored,do_unlink=True)
    if old.users==0:bpy.data.meshes.remove(old)
    tank.name='Realistic / tailored continuous olive athletic tank'
    # Narrow, softly rounded binding follows the actual three opening loops.
    # It covers cut edges, including shoulder/side junctions, without hiding
    # the original skin or introducing the source shirt's cap-sleeve remnants.
    bm=bmesh.new();bm.from_mesh(tank.data);bm.verts.ensure_lookup_table();bm.verts.index_update()
    boundary=[e for e in bm.edges if e.is_boundary]
    adjacency={}
    for edge in boundary:
        a,b=[v.index for v in edge.verts]
        adjacency.setdefault(a,[]).append(b);adjacency.setdefault(b,[]).append(a)
    visited=set();loops=[]
    for start in adjacency:
        if start in visited:continue
        loop=[];last=None;current=start
        while current not in visited:
            visited.add(current);loop.append(current)
            candidates=[n for n in adjacency[current] if n!=last]
            if not candidates:break
            last,current=current,candidates[0]
        if len(loop)>3:loops.append(loop)
    rv=[];rf=[]
    for loop in loops:
        base=len(rv)
        for index,vertex in enumerate(loop):
            point=bm.verts[vertex].co.copy()
            tangent=(bm.verts[loop[(index+1)%len(loop)]].co-bm.verts[loop[index-1]].co).normalized()
            axis=tangent.cross(Vector((0,1,0)))
            if axis.length<.01:axis=tangent.cross(Vector((1,0,0)))
            axis.normalize();other=tangent.cross(axis).normalized()
            for j in range(6):rv.append(tuple(point+.0018*(axis*cos(j*pi/3)+other*sin(j*pi/3))))
        for index in range(len(loop)):
            for j in range(6):rf.append((base+index*6+j,base+index*6+(j+1)%6,base+((index+1)%len(loop))*6+(j+1)%6,base+((index+1)%len(loop))*6+j))
    bm.free()
    bindingmat=tankmat.copy();bindingmat.name='Realistic / olive cotton rib binding'
    bp=bindingmat.node_tree.nodes.get('Principled BSDF')
    for socket in ('Base Color','Normal'):
        for link in list(bp.inputs[socket].links):bindingmat.node_tree.links.remove(link)
    bp.inputs['Base Color'].default_value=(.074,.084,.049,1);bp.inputs['Roughness'].default_value=.93
    binding=make('Realistic / tailored bound neck armhole hem edges',rv,rf,bindingmat,torso_weights,[(0,0)]*len(rv))
    # A millimetre of cloth thickness produces a true interior at open edges.
    bpy.ops.object.select_all(action='DESELECT');tank.select_set(True);bpy.context.view_layer.objects.active=tank
    solid=tank.modifiers.new('Physical cotton fabric thickness','SOLIDIFY');solid.thickness=.0013;solid.offset=0
    while list(tank.modifiers).index(solid)>0:bpy.ops.object.modifier_move_up(modifier=solid.name)
    bpy.ops.object.modifier_apply(modifier=solid.name)
    print('REALISTIC_BODY_COMPLETE',dict(weldedArmBridges=len(armloops),tankVertices=len(tank.data.vertices)),flush=True)
    return [binding]
