"""Fit Lee Perry-Smith scan and replace its closed scan lids with open eyes.

API: prepare_head(head, rig, skin, assets) -> [head, eye meshes...].
Input is the unmodified glTF import. Output uses world metres, front -Y,
scalp 1.749m, neck join 1.50m. The caller assigns the scanned head
material and binds returned meshes to its existing Head joint.
"""
import bpy
import bmesh
from math import sin, cos, pi, sqrt, atan2
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


def _material(name, color, roughness):
    m=bpy.data.materials.new(name);m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=roughness
    p.inputs['Specular IOR Level'].default_value=.30
    return m


def _mesh(name, verts, faces, mat):
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob)
    if mat:me.materials.append(mat)
    for p in me.polygons:p.use_smooth=True
    return ob


def _complete_upper_torso(head, skin, rig):
    """Replace clothing-hidden source fragments with a continuous shoulder girdle.

    The source body omits wedges underneath its original shirt, including a
    centimetre-wide gap at the neck cut. Remapping those disconnected pieces
    to an ellipse cannot close their missing faces. This loft covers the
    complete upper chest and meets the scan at one shared contour.
    """
    skin.data.calc_loop_triangles()
    matrix=skin.matrix_world.copy();inverse=matrix.inverted()
    source=[matrix@v.co for v in skin.data.vertices]
    triangles=[tuple(triangle.vertices) for triangle in skin.data.loop_triangles]
    uv=skin.data.uv_layers.active.data
    triangle_uv=[tuple(Vector((*uv[index].uv,0)) for index in triangle.loops)
                 for triangle in skin.data.loop_triangles]
    tree=BVHTree.FromPolygons(source,triangles,all_triangles=True)

    # Preserve the actual fitted scan border rather than assuming its sparse
    # clipped triangles describe a perfect mathematical ellipse.
    bottom=min(v.co.z for v in head.data.vertices)
    border=[v.co.copy() for v in head.data.vertices if abs(v.co.z-bottom)<1e-5]
    cx,cy=.0032,.010
    ordered=sorted(((atan2(p.y-cy,p.x-cx)%(2*pi),p) for p in border),key=lambda value:value[0])
    contour=[]
    for angle,p in ordered:
        if not contour or angle-contour[-1][0]>1e-6:contour.append((angle,p))
    assert len(contour)>32,'The scan must retain a complete clipped neck contour'

    def scan_border(angle):
        angle%=2*pi
        for index,(a,p) in enumerate(contour):
            b,q=contour[(index+1)%len(contour)]
            if b<=a:b+=2*pi
            query=angle if angle>=a else angle+2*pi
            if a<=query<=b:
                direction=Vector((cos(angle),sin(angle)))
                start=Vector((p.x-cx,p.y-cy));delta=Vector((q.x-p.x,q.y-p.y))
                denominator=delta.x*direction.y-delta.y*direction.x
                t=-(start.x*direction.y-start.y*direction.x)/denominator if abs(denominator)>1e-10 else 0
                return p.lerp(q,max(0,min(1,t)))
        raise AssertionError('Could not sample the scan neck contour')

    profile=[(1.34,.200,.115,.025),(1.405,.202,.114,.024),
             (1.44,.198,.110,.022),(1.470,.135,.086,.017),
             (1.490,.080,.063,.012),(bottom,.057,.053,.010)]
    def shape(z):
        for a,b in zip(profile,profile[1:]):
            if a[0]<=z<=b[0]:
                t=(z-a[0])/(b[0]-a[0]);t=t*t*(3-2*t)
                return tuple(a[index]*(1-t)+b[index]*t for index in (1,2,3))
        return profile[0][1:]
    def smoothstep(a,b,value):
        t=max(0,min(1,(value-a)/(b-a)));return t*t*(3-2*t)

    groups={name:(skin.vertex_groups.get('mixamorig:'+name) or
                  skin.vertex_groups.new(name='mixamorig:'+name)).index
            for name in ['Spine2','Neck','LeftShoulder','RightShoulder']}
    torso_groups={group.index for group in skin.vertex_groups
                  if any(name in group.name for name in ['Spine','Neck','Head'])}
    bm=bmesh.new();bm.from_mesh(skin.data)
    deform=bm.verts.layers.deform.verify();uv_layer=bm.loops.layers.uv.active
    remove=[]
    for face in bm.faces:
        point=matrix@face.calc_center_median()
        original_torso=sum(sum(weight for index,weight in v[deform].items()
                               if index in torso_groups) for v in face.verts)/len(face.verts)
        if point.z>1.34 and (abs(point.x)<.165 or
                           (abs(point.x)<.245 and original_torso>.05)):
            remove.append(face)
    bmesh.ops.delete(bm,geom=remove,context='FACES')
    unused=[v for v in bm.verts if not v.link_faces]
    if unused:bmesh.ops.delete(bm,geom=unused,context='VERTS')

    rows=[];row_uv=[];segments=160
    # Include the profile knots exactly; extra intermediate rings avoid hard
    # planar shoulder steps when the character is viewed from the side.
    heights=sorted(set([entry[0] for entry in profile]+
                       [1.34+(bottom-1.34)*index/40 for index in range(41)]))
    for z in heights:
        rx,ry,center_y=shape(z);ring=[];coordinates=[]
        for index in range(segments):
            angle=2*pi*index/segments
            point=Vector((cx+rx*cos(angle),center_y+ry*sin(angle),z))
            if z>bottom-.010:
                top=scan_border(angle);t=smoothstep(bottom-.010,bottom,z)
                point.x=point.x*(1-t)+top.x*t;point.y=point.y*(1-t)+top.y*t
            vertex=bm.verts.new(inverse@point)
            neck=smoothstep(1.435,bottom,point.z)
            shoulder=.30*smoothstep(.12,.20,abs(point.x))*(1-smoothstep(1.445,1.480,point.z))
            vertex[deform][groups['Neck']]=neck
            vertex[deform][groups['LeftShoulder' if point.x>0 else 'RightShoulder']]=shoulder*(1-neck)
            vertex[deform][groups['Spine2']]=(1-shoulder)*(1-neck)
            nearest,normal,face,distance=tree.find_nearest(point)
            tex=barycentric_transform(nearest,*[source[i] for i in triangles[face]],*triangle_uv[face])
            ring.append(vertex);coordinates.append(Vector((tex.x,tex.y)))
        if rows:
            for index in range(segments):
                following=(index+1)%segments
                face=bm.faces.new((rows[-1][index],rows[-1][following],ring[following],ring[index]))
                face.smooth=True
                for loop,coord in zip(face.loops,[row_uv[-1][index],row_uv[-1][following],
                                                coordinates[following],coordinates[index]]):
                    loop[uv_layer].uv=coord
        rows.append(ring);row_uv.append(coordinates)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(skin.data);bm.free();skin.data.update()
    skin['continuous_upper_torso']='Complete chest and trapezius loft meeting the exact scanned neck contour'
    print('REALISTIC_CONTINUOUS_UPPER_TORSO',dict(rows=len(rows),segments=segments,
                                               replacedSourceFaces=len(remove)),flush=True)


def prepare_head(head, rig, skin, assets):
    def neck_profile(z):
        t=max(0,min(1,(z-1.50)/.115))
        # A broad base tapers into the throat. The jaw keeps its own contour;
        # there is no second flared ring underneath it.
        rx=.057-.008*sin(pi*t*.75);ry=.053-.006*sin(pi*t*.75)
        return .0032,.010-.005*t,rx,ry

    # The old cropped face/neck and scan now meet on an exact shared horizontal
    # ring. Move the last three centimetres of source neck gradually onto that
    # ellipse and give both sides the same Neck weights at the join.
    bm=bmesh.new();bm.from_mesh(skin.data);mw=skin.matrix_world.copy();inv=mw.inverted()
    for v in bm.verts:v.co=mw@v.co
    for v in bm.verts:
        x=abs(v.co.x)
        if .045<x<.19 and 1.42<v.co.z<1.50:
            t=max(0,min(1,(v.co.z-1.42)/.06));t=t*t*(3-2*t)
            fade=max(0,min(1,(1.50-v.co.z)/.02));fade=fade*fade*(3-2*fade)
            v.co.z+=.024*__import__('math').exp(-((x-.085)/.050)**2)*t*fade
    neck_faces=[f for f in bm.faces if all(abs(v.co.x)<.13 for v in f.verts)]
    neck_edges=list({e for f in neck_faces for e in f.edges})
    neck_vertices=list({v for f in neck_faces for v in f.verts})
    bmesh.ops.bisect_plane(bm,geom=neck_vertices+neck_edges+neck_faces,
        dist=1e-7,plane_co=(0,0,1.50),plane_no=(0,0,1),clear_outer=True,clear_inner=False)
    for v in bm.verts:
        if v.co.z>1.470 and abs(v.co.x)<.12:
            t=max(0,min(1,(v.co.z-1.470)/.030));t=t*t*(3-2*t)
            cx,cy,rx,ry=neck_profile(1.50)
            angle=atan2((v.co.y-cy)/ry,(v.co.x-cx)/rx)
            v.co.x=v.co.x*(1-t)+(cx+rx*cos(angle))*t
            v.co.y=v.co.y*(1-t)+(cy+ry*sin(angle))*t
        v.co=inv@v.co
    bm.to_mesh(skin.data);bm.free();skin.data.update()
    neck_group=skin.vertex_groups.get('mixamorig:Neck') or skin.vertex_groups.new(name='mixamorig:Neck')
    for v in skin.data.vertices:
        p=mw@v.co
        if p.z<=1.470 or abs(p.x)>=.12:continue
        t=max(0,min(1,(p.z-1.470)/.030));t=t*t*(3-2*t)
        weights={g.group:g.weight for g in v.groups};neck_weight=weights.get(neck_group.index,0)
        for index,weight in weights.items():
            skin.vertex_groups[index].add([v.index],weight*(1-t),'REPLACE')
        neck_group.add([v.index],neck_weight*(1-t)+t,'REPLACE')
    # The original three.js scan imports into Blender facing -Y.
    world=head.matrix_world.copy()
    for v in head.data.vertices:
        p=world@v.co
        p=Vector((p.x*.04+.0032,p.y*.04,1.6301+p.z*.04))
        # Broaden the adult jaw very gently without moving the scalp or ears.
        jaw=__import__('math').exp(-((p.z-1.622)/.038)**2)
        p.x=.0032+(p.x-.0032)*(1.055+.035*jaw)
        # Replace only the shoulder plinth with a smooth, elliptical neck.
        # The smooth radial fit has zero slope at either end: hard component
        # clamps create a projecting shelf exactly where the head rotates.
        if p.z<1.635:
            cx,cy,rx,ry=neck_profile(min(p.z,1.615))
            angle=atan2((p.y-cy)/ry,(p.x-cx)/rx)
            t=max(0,min(1,(1.635-p.z)/.050));t=t*t*(3-2*t)
            p.x=p.x*(1-t)+(cx+rx*cos(angle))*t
            p.y=p.y*(1-t)+(cy+ry*sin(angle))*t
        v.co=p
    head.matrix_world=Matrix.Identity(4)
    # The textureless source glTF retains Three.js image coordinates. Blender
    # image nodes use bottom-origin UVs for the separately supplied scan maps.
    for loop in head.data.uv_layers.active.data:
        loop.uv.y=1-loop.uv.y
    bm=bmesh.new();bm.from_mesh(head.data)
    bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
        dist=1e-7,plane_co=(0,0,1.50),plane_no=(0,0,1),clear_outer=False,clear_inner=True)
    # A denser scan permits a clean small aperture without changing silhouette.
    bmesh.ops.subdivide_edges(bm,edges=list(bm.edges),cuts=1,use_grid_fill=True)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(head.data);bm.free();head.data.update()
    original_vertices=[v.co.copy() for v in head.data.vertices]
    original_faces=[tuple(p.vertices) for p in head.data.polygons]
    bvh=BVHTree.FromPolygons(original_vertices,original_faces,all_triangles=False)
    uv_layer=head.data.uv_layers.active
    uv_data=uv_layer.data
    original_uvs=[[uv_data[li].uv.copy() for li in p.loop_indices] for p in head.data.polygons]

    def sample(x,z,fallback):
        hit,n,face,dist=bvh.ray_cast(Vector((x,-.25,z)),Vector((0,1,0)),.45)
        if hit is None:return Vector((x,fallback,z)),(.5,.3)
        # Interpolate UVs on the nearest source face, preserving skin scan.
        vs=[original_vertices[i] for i in original_faces[face]]
        weights=[1/max(1e-8,(v-hit).length) for v in vs];total=sum(weights)
        uv=sum((uv*w for uv,w in zip(original_uvs[face],weights)),Vector((0,0)))/total
        return hit,tuple(uv)

    centers=[]
    for x,z in [(-.0314,1.6956),(.0314,1.6952)]:
        surface,_=sample(x,z,-.076)
        # A real globe sits behind the lids; the visible spherical cap is
        # limited to the almond opening, so it never protrudes over a cheek.
        centers.append(Vector((x,surface.y+.0115,z)))
    radius=.0124;opening_width=.0119;upper=.0040;lower=.0031
    # Remove closed central lids. A rounded anatomical ring overlaps this cut,
    # so the boundary is never visible or left as a row of polygon teeth.
    bm=bmesh.new();bm.from_mesh(head.data)
    remove=[]
    for f in bm.faces:
        p=f.calc_center_median()
        for c in centers:
            if p.y<-.049 and ((p.x-c.x)/.0144)**2+((p.z-c.z)/.0066)**2<1:
                remove.append(f);break
    bmesh.ops.delete(bm,geom=remove,context='FACES')
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(head.data);bm.free();head.data.update()

    lidverts=[];lidfaces=[];liduv=[];segments=64;rows=5
    for c in centers:
        base=len(lidverts)
        for row in range(rows):
            t=row/(rows-1)
            for j in range(segments):
                a=2*pi*j/segments
                width=opening_width*(1-t)+.0185*t
                height=(upper if sin(a)>0 else lower)*(1-t)+.0090*t
                dx=width*cos(a);dz=height*sin(a)
                outer,uv=sample(c.x+dx,c.z+dz,-.071)
                inner_y=c.y-sqrt(max(.000004,radius**2-dx*dx-dz*dz))-.00016
                y=inner_y*(1-t)+(outer.y-.00025)*t
                lidverts.append((c.x+dx,y,c.z+dz));liduv.append(uv)
        for row in range(rows-1):
            for j in range(segments):
                a=base+row*segments+j;b=base+row*segments+(j+1)%segments
                lidfaces.append((a+segments,b+segments,b,a))
    lids=_mesh('Realistic / opened upper and lower scan eyelids',lidverts,lidfaces,None)
    layer=lids.data.uv_layers.new(name='UVMap')
    for l in lids.data.loops:layer.data[l.index].uv=liduv[l.vertex_index]
    # Join lids into the scan so the caller's skin texture and normal apply.
    scan_vertex_count=len(head.data.vertices)
    for ob in bpy.context.selected_objects:ob.select_set(False)
    head.select_set(True);lids.select_set(True);bpy.context.view_layer.objects.active=head
    bpy.ops.object.join()
    # Export a real eyelid morph for subtle runtime blinking. The outer scan
    # stays fixed; the inner upper/lower boundaries meet over the cornea.
    head.shape_key_add(name='Basis')
    blink=head.shape_key_add(name='Blink');blink.value=0
    for index in range(len(lidverts)):
        eye=index//(rows*segments);local=index%(rows*segments);row=local//segments
        c=centers[eye];weight=(1-row/(rows-1))**2
        vertex=blink.data[scan_vertex_count+index].co
        dx=vertex.x-c.x
        close_y=c.y-sqrt(max(.000004,radius**2-dx*dx))-.00035
        vertex.z+=(c.z+.00015-vertex.z)*weight
        vertex.y+=(close_y-vertex.y)*weight

    eye_material=_material('Realistic / inset moist sclera blue grey iris and pupil',(.65,.67,.62),.30)
    # One spherical cap and a baked anatomical eye atlas avoids intersecting
    # full spheres or iris disks. The upper lid naturally covers the iris.
    import numpy as np
    size=512;yy,xx=np.mgrid[:size,:size]
    x=(xx+.5-size/2)/(size/2)*radius;y=(yy+.5-size/2)/(size/2)*radius
    r=np.sqrt(x*x+y*y)/.00525;a=np.arctan2(y,x)
    fibers=.72+.13*np.sin(a*73+r*28)+.10*np.sin(a*131-r*41)+.06*np.sin(a*241+r*17)
    arr=np.ones((size,size,4),dtype=np.float32)
    arr[:,:,:3]=np.array([.44,.47,.44])[None,None,:]
    iris=fibers[:,:,None]*np.array([.24,.34,.37])[None,None,:]
    iris*=(1-.60*np.exp(-((r-.94)/.075)**2))[:,:,None]
    blend=np.clip((1-r)*50,0,1)
    arr[:,:,:3]=arr[:,:,:3]*(1-blend[:,:,None])+iris*blend[:,:,None]
    pupil=np.clip((.32-r)*80,0,1)
    arr[:,:,:3]=arr[:,:,:3]*(1-pupil[:,:,None])+np.array([.003,.005,.006])*pupil[:,:,None]
    # A restrained warm tear-duct tint and off-white sclera keep the eye from
    # reading as a bright white marble under the studio and city lights.
    veins=np.exp(-((np.abs(x)-.010)/.002)**2)
    arr[:,:,0]+=.06*veins;arr[:,:,1]-=.025*veins
    im=bpy.data.images.new('Realistic / baked inset eye iris sclera pupil',width=size,height=size)
    im.pixels.foreach_set(arr.ravel());im.update();im.pack()
    tex=eye_material.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
    eye_material.node_tree.links.new(tex.outputs['Color'],eye_material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    upper_rim=_material('Realistic / fine brown upper eyelid lash rim',(.060,.037,.028),.72)
    lower_rim=_material('Realistic / warm lower eyelid waterline',(.36,.21,.18),.52)
    eyes=[]
    for eye,c in enumerate(centers):
        side='left' if eye==0 else 'right'
        verts=[(c.x,c.y-radius,c.z)];faces=[];rings=16;seg=64
        for k in range(1,rings+1):
            t=k/rings
            for j in range(seg):
                a=2*pi*j/seg;dx=opening_width*t*cos(a)
                dz=(upper if sin(a)>=0 else lower)*t*sin(a)
                verts.append((c.x+dx,c.y-sqrt(max(.000001,radius**2-dx*dx-dz*dz)),c.z+dz))
        for j in range(seg):faces.append((0,1+j,1+(j+1)%seg))
        for k in range(rings-1):
            for j in range(seg):
                aa=1+k*seg+j;bb=1+k*seg+(j+1)%seg
                faces.append((aa+seg,bb+seg,bb,aa))
        ob=_mesh('Realistic / '+side+' inset anatomical eye',verts,faces,eye_material)
        uv=ob.data.uv_layers.new(name='UVMap')
        for l in ob.data.loops:
            p=ob.data.vertices[l.vertex_index].co
            uv.data[l.index].uv=((p.x-c.x)/(2*radius)+.5,(p.z-c.z)/(2*radius)+.5)
        ob.shape_key_add(name='Basis');blink=ob.shape_key_add(name='Blink');blink.value=0
        for vertex in blink.data:
            vertex.co.z=c.z+(vertex.co.z-c.z)*.04
            vertex.co.y+=.001
        eyes.append(ob)
        for upper_lid,mat in [(True,upper_rim),(False,lower_rim)]:
            vv=[];ff=[];count=48;sides=6
            for k in range(count):
                angle=.09+(pi-.18)*k/(count-1)
                if not upper_lid:angle=-angle
                dx=opening_width*cos(angle);dz=(upper if upper_lid else lower)*sin(angle)
                center=Vector((c.x+dx,c.y-sqrt(max(.000002,radius**2-dx*dx-dz*dz))-.00022,c.z+dz))
                across=Vector((cos(angle),0,sin(angle))).normalized()
                thickness=.00022 if upper_lid else .00016
                for j in range(sides):
                    a=2*pi*j/sides
                    vv.append(tuple(center+Vector((0,-thickness*cos(a),0))+across*(thickness*sin(a))))
            for k in range(count-1):
                for j in range(sides):
                    a=k*sides+j;b=k*sides+(j+1)%sides;ff.append((a,b,b+sides,a+sides))
            rim=_mesh('Realistic / '+side+(' upper lid lash rim' if upper_lid else ' lower lid waterline'),vv,ff,mat)
            bm=bmesh.new();bm.from_mesh(rim.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(rim.data);bm.free()
            rim.shape_key_add(name='Basis');blink=rim.shape_key_add(name='Blink');blink.value=0
            for vertex in blink.data:
                dx=vertex.co.x-c.x
                vertex.co.z=c.z+(vertex.co.z-c.z)*.04
                vertex.co.y=c.y-sqrt(max(.000002,radius**2-dx*dx))-.0005
            eyes.append(rim)
    head['source']='Lee Perry-Smith / Infinite Realities, CC BY 3.0'
    head['eye_preparation']='Inset spherical eye caps inside small anatomical apertures, textured iris pupil sclera and scan-textured lids'
    # Fit an adult-sized head, then lower it 4 cm into the shoulder girdle.
    # Compress only the throat below it so facial features, eyes and blink
    # morphs keep their proportions and the shared neck ring stays closed.
    head_drop=.040
    blend_top=1.789+(1.60-1.789)*1.22-head_drop
    def proportion(point):
        p=point.copy();z=p.z
        t=max(0,min(1,(z-1.50)/.095));t=t*t*(3-2*t)
        p.x=.0032+(p.x-.0032)*(1+.10*t)
        if z>=1.60:p.z=1.789+(z-1.789)*1.22-head_drop
        else:p.z=1.50+(z-1.50)*(blend_top-1.50)/.10
        return p
    for obj in [head]+eyes:
        positions=[v.co.copy() for v in obj.data.vertices]
        keys=[(key,[v.co.copy() for v in key.data]) for key in obj.data.shape_keys.key_blocks] if obj.data.shape_keys else []
        for vertex,p in zip(obj.data.vertices,positions):vertex.co=proportion(p)
        for key,positions in keys:
            for vertex,p in zip(key.data,positions):vertex.co=proportion(p)
        obj.data.update()
    # Keep a 50 mm skinning transition after shortening the visible throat.
    # Reusing the vertically compressed scan landmark would squeeze the old
    # Head/Neck rotation difference into only 18 mm and tear the lower jaw
    # during the captured run and door-entry head turns.
    head['neck_head_blend_top']=1.550
    head['anatomical_head_drop_meters']=head_drop
    _complete_upper_torso(head,skin,rig)
    return [head]+eyes
