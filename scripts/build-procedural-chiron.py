"""Build the game's Bugatti Chiron in Blender, then bake the game asset.

blender --background --factory-startup --python scripts/build-blender-car.py
Add -- --render for a studio render. X across, Y up, nose towards negative Z.
"""
import bpy
import bmesh
import math
import runpy
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts' / 'blender'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = 'METRIC'
body_collection = bpy.data.collections.new('Bugatti / game body')
preview_collection = bpy.data.collections.new('Bugatti / wheel and cabin reference')
studio_collection = bpy.data.collections.new('Studio / presentation')
for collection in (body_collection, preview_collection, studio_collection):
    bpy.context.scene.collection.children.link(collection)

def xyz(p):
    return (p[0], -p[2], p[1])

def material(name, color, metal=0, rough=.4, emission=0, alpha=1):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, alpha)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    p.inputs['Coat Weight'].default_value = .9 if name in ('paint', 'secondaryPaint', 'glass') else .12
    p.inputs['Coat Roughness'].default_value = .09
    if emission:
        p.inputs['Emission Color'].default_value = (*color, 1)
        p.inputs['Emission Strength'].default_value = emission
    m.diffuse_color = (*color, alpha)
    return m

M = {
    'paint': material('paint', (.015, .18, .49), .65, .23),
    'secondaryPaint': material('secondaryPaint', (.008, .015, .030), .55, .24),
    'carbon': material('carbon', (.017, .022, .030), .15, .35),
    'trim': material('trim', (.008, .012, .018), .20, .52),
    'alloy': material('alloy', (.60, .68, .76), .96, .20),
    'glass': material('glass', (.025, .065, .100), .15, .10, alpha=.9),
    'amber': material('amber', (1, .40, .08), emission=1.2),
    'redAccent': material('redAccent', (.56, .015, .022), .3, .28),
    'white': material('white', (.70, .85, 1), emission=3),
    'red': material('red', (.85, .008, .02), emission=2),
    'rubber': material('rubber', (.013, .016, .019), 0, .85),
    'leather': material('leather', (.21, .12, .055), 0, .72),
}

def move_collection(obj, collection):
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    collection.objects.link(obj)

def mesh(name, points, faces, mat='paint', collection=None, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata([xyz(p) for p in points], [], faces)
    data.update()
    bm = bmesh.new();bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(data);bm.free()
    obj = bpy.data.objects.new(name, data)
    (collection or body_collection).objects.link(obj)
    data.materials.append(M[mat])
    for polygon in data.polygons:polygon.use_smooth = smooth
    return obj

def bevel(obj, width=.008, segments=1):
    mod = obj.modifiers.new('Baked edge radius', 'BEVEL')
    mod.width = width;mod.segments = segments;mod.limit_method = 'ANGLE'
    mod.angle_limit = .48;mod.harden_normals = True
    normal = obj.modifiers.new('Baked panel normals', 'WEIGHTED_NORMAL');normal.keep_sharp = True
    return obj

def box(name, size, pos, mat='paint', radius=.008, collection=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz(pos))
    obj = bpy.context.object;obj.name = name
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    move_collection(obj, collection or body_collection);obj.data.materials.append(M[mat])
    if radius >= .012:bevel(obj, radius, 2 if radius >= .025 else 1)
    return obj

def plate(name, points, mat='paint', thickness=.015, radius=.004, collection=None):
    obj = mesh(name, points, [tuple(range(len(points)))], mat, collection)
    if thickness:
        mod = obj.modifiers.new('Panel thickness', 'SOLIDIFY');mod.thickness = thickness;mod.offset = -1
    if radius:bevel(obj, radius)
    return obj

def tube(name, points, radius, mat='trim', collection=None, sides=0):
    curve = bpy.data.curves.new(name, 'CURVE');curve.dimensions = '3D'
    curve.resolution_u = 1;curve.bevel_depth = radius;curve.bevel_resolution = sides
    spline = curve.splines.new('POLY');spline.points.add(len(points) - 1)
    for v, p in zip(spline.points, points):v.co = (*xyz(p), 1)
    obj = bpy.data.objects.new(name, curve)
    (collection or body_collection).objects.link(obj);obj.data.materials.append(M[mat])
    return obj

def cylinder(name, radius, depth, pos, mat='alloy', axis='x', collection=None, vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=xyz(pos))
    obj = bpy.context.object;obj.name = name
    if axis == 'x':obj.rotation_euler.y = math.pi / 2
    if axis == 'z':obj.rotation_euler.x = math.pi / 2
    move_collection(obj, collection or body_collection);obj.data.materials.append(M[mat])
    return obj

def subtract(obj, cutter):
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new('Recess / ' + cutter.name, 'BOOLEAN')
    mod.operation = 'DIFFERENCE';mod.solver = 'EXACT';mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cutter, do_unlink=True)

def smooth_path(points, steps=5):
    result = []
    for i in range(len(points)-1):
        a = Vector(points[max(0, i-1)]);b = Vector(points[i])
        c = Vector(points[i+1]);d = Vector(points[min(len(points)-1, i+2)])
        for j in range(steps):
            t = j / steps
            result.append(tuple(.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t)))
    return result + [points[-1]]

# Smooth fenders, low hood, broad rear haunches; retain game axle clearances.
# z, half width, sill, shoulder, crown.
RINGS = [
    (-2.52,.918,.235,.646,.795), (-2.28,.952,.215,.720,.836),
    (-1.97,.984,.210,.782,.903), (-1.43,1.031,.210,.873,.976),
    (-.98,.993,.210,.877,.986), (-.40,.946,.210,.858,.950),
    (.28,.949,.210,.867,.956), (.75,.996,.215,.895,.995),
    (1.43,1.045,.225,.911,1.035), (1.90,1.014,.232,.831,.958),
    (2.25,.978,.245,.759,.870), (2.50,.948,.255,.703,.809),
]

def section(z):
    i = next((i for i in range(len(RINGS)-1) if z <= RINGS[i+1][0]), len(RINGS)-2)
    t = max(0, min(1, (z-RINGS[i][0])/(RINGS[i+1][0]-RINGS[i][0])))
    values = []
    for k in range(1, 5):
        p, q = RINGS[i][k], RINGS[i+1][k]
        a = max(0,i-1);b = min(len(RINGS)-1,i+2)
        m = (RINGS[i+1][k]-RINGS[a][k])/(RINGS[i+1][0]-RINGS[a][0])
        n = (RINGS[b][k]-RINGS[i][k])/(RINGS[b][0]-RINGS[i][0])
        dz = RINGS[i+1][0]-RINGS[i][0]
        values.append((2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*m*dz+(-2*t**3+3*t*t)*q+(t**3-t*t)*n*dz)
    return values

points, faces = [], []
stations = 65
for i in range(stations):
    z = -2.52 + 5.02*i/(stations-1);w, bottom, belt, top = section(z)
    dip = .135*math.exp(-((z+1.7)/.82)**2)
    ring = [(-.79*w,bottom),(-.93*w,bottom+.025),(-.984*w,bottom+.10),
            (-w,belt-.13),(-w,belt-.03),(-.982*w,belt+.035),
            (-.943*w,top-.008),(-.84*w,top+.012),(-.66*w,top-.006-dip*.22),
            (-.35*w,top-.015-dip*.80),(0,top-.018-dip),
            (.35*w,top-.015-dip*.80),(.66*w,top-.006-dip*.22),(.84*w,top+.012),
            (.943*w,top-.008),(.982*w,belt+.035),(w,belt-.03),(w,belt-.13),
            (.984*w,bottom+.10),(.93*w,bottom+.025),(.79*w,bottom)]
    points.extend((x,y,z) for x,y in ring)
for i in range(stations-1):
    for j in range(21):
        a=i*21+j;b=i*21+(j+1)%21;faces.append((a,b,b+21,a+21))
faces += [tuple(reversed(range(21))), tuple((stations-1)*21+j for j in range(21))]
shell = mesh('01 / smooth two-tone Chiron monocoque',points,faces,smooth=True)
shell.data.materials.append(M['secondaryPaint'])
for polygon in shell.data.polygons:
    polygon.material_index = int(sum(shell.data.vertices[v].co.y for v in polygon.vertices)/len(polygon.vertices) < -.69)
for axle in (-1.43,1.43):
    subtract(shell,cylinder('Full wheel clearance',.421,3,(0,.385,axle),vertices=64))
    for side in (-1,1):
        verts, fs = [], []
        for i in range(33):
            a = math.pi*i/32
            for rad,inset in ((.421,.001),(.444,.008),(.444,-.016),(.421,-.027)):
                z=axle+math.cos(a)*rad;verts.append((side*(section(z)[0]+inset),.385+math.sin(a)*rad,z))
            if i<32:
                for j in range(4):
                    a0=i*4+j;b0=i*4+(j+1)%4;fs.append((a0,b0,b0+4,a0+4))
        mesh('02 / rolled wheelarch',verts,fs,'paint' if axle<0 else 'secondaryPaint',smooth=True)
        inner=[]
        for i in range(33):
            a=math.pi*i/32;z=axle+math.cos(a)*.42;y=.385+math.sin(a)*.42
            inner.extend(((side*.77,y,z),(side*(section(z)[0]-.015),y,z)))
        mesh('02 / shadowed wheelhouse',inner,[(2*i,2*i+1,2*i+3,2*i+2) for i in range(32)],'trim',smooth=True)
subtract(shell,box('Hollow passenger compartment',(1.49,1.5,1.80),(0,1.24,.065),radius=0))
subtract(shell,box('Mid-mounted engine bay',(1.28,.7,1.10),(0,1.17,1.64),radius=0))

# Genuine horseshoe bumper opening with recessed radiator mesh.
horseshoe=[(-.252,.290),(-.291,.420),(-.289,.619)]
for i in range(17):
    a=math.pi-math.pi*i/16;horseshoe.append((math.cos(a)*.289,.619+math.sin(a)*.222))
horseshoe += [(.291,.420),(.252,.290)]
hp=[(x,y,z) for z in (-2.72,-2.27) for x,y in horseshoe];hn=len(horseshoe)
hf=[tuple(reversed(range(hn))),tuple(hn+i for i in range(hn))]
hf += [(i,(i+1)%hn,(i+1)%hn+hn,i+hn) for i in range(hn)]
subtract(shell,mesh('Horseshoe opening cutter',hp,hf))
plate('03 / recessed horseshoe radiator',[(x,y,-2.285) for x,y in horseshoe],'trim',.016,0)
tube('03 / polished iconic horseshoe surround',[(x,y,-2.555) for x,y in horseshoe+[horseshoe[0]]],.015,'alloy',sides=1)
for i in range(17):
    x=(i-8)*.030;top=.619+math.sqrt(max(0,.222**2*(1-(x/.27)**2)))
    box('03 / fine vertical radiator mesh',(.003,top-.314,.006),(x,(top+.314)/2,-2.310),'alloy',0)
for i in range(10):
    y=.325+i*.047;w=.255 if y<.619 else .27*math.sqrt(max(0,1-((y-.619)/.222)**2))
    box('03 / fine horizontal radiator mesh',(2*w,.003,.005),(0,y,-2.315),'alloy',0)

def lettering(name,text,pos,size,mat='alloy',collection=None,side=0,front=False):
    curve=bpy.data.curves.new(name,'FONT');curve.body=text;curve.size=size;curve.align_x='CENTER'
    curve.extrude=0;curve.resolution_u=1
    obj=bpy.data.objects.new(name,curve);(collection or body_collection).objects.link(obj)
    obj.data.materials.append(M[mat]);obj.location=xyz(pos)
    if front:obj.rotation_euler=(math.pi/2,0,0)
    elif side:obj.rotation_euler=(math.pi/2,0,side*math.pi/2)
    return obj

badge=cylinder('04 / red enamel Bugatti macaron',.063,.007,(0,.809,-2.569),'redAccent','z',vertices=32)
badge.scale.z=.55
lettering('04 / silver BUGATTI wordmark','BUGATTI',(0,.802,-2.575),.016,front=True)
lettering('04 / EB radiator crest','EB',(0,.595,-2.332),.092,front=True)
for side in (-1,1):
    subtract(shell,box('Outer bumper air duct',(.46,.20,.38),(side*.645,.426,-2.49),radius=0))
    box('05 / deep front side radiator',(.468,.212,.018),(side*.645,.426,-2.307),'trim',.014)
    for i in range(7):box('05 / side grille ribs',(.425,.005,.010),(side*.645,.343+i*.027,-2.329),'alloy',0)
    tube('05 / painted air duct lower lip',[(side*.39,.31,-2.557),(side*.78,.314,-2.555),(side*.894,.377,-2.518)],.016,'paint',sides=1)
    box('06 / four-eye headlight pocket',(.532,.086,.028),(side*.645,.699,-2.544),'trim',.016)
    tube('06 / headlight brow',smooth_path([(side*.355,.757,-2.537),(side*.638,.76,-2.544),(side*.921,.744,-2.481)],6),.009,'paint',sides=1)
    tube('06 / corner turn signal',[(side*.901,.687,-2.517),(side*.953,.716,-2.378)],.005,'amber')
plate('07 / front carbon splitter',[(-.935,.248,-2.615),(.935,.248,-2.615),(1.026,.23,-2.12),(.95,.21,-1.98),(-.95,.21,-1.98),(-1.026,.23,-2.12)],'carbon',.035,.008)
for side in (-1,1):
    hood=[]
    for i in range(30):
        z=-2.37+1.41*i/29;w,_,_,top=section(z);dip=.135*math.exp(-((z+1.7)/.82)**2)
        hood.append((side*w*.66,top-.005-dip*.22,z))
    tube('08 / hood perimeter shut line',hood,.003,'trim')
    tube('08 / hood sculpted ridge',smooth_path([(side*.09,.776,-2.35),(side*.19,.785,-1.94),(side*.22,.875,-1.36),(side*.20,.962,-.98)],7),.006,'paint')

def flank(side,y,z,offset=.006):
    w,bottom,belt,top=section(z)
    x=w*(.984+.016*max(0,min(1,(y-bottom-.10)/(belt-bottom-.13)))) if y<belt-.03 else w*(1-.06*max(0,min(1,(y-belt+.03)/(top-belt+.03))))
    return (side*(x+offset),y,z)

for side in (-1,1):
    door=[(.334,-.965),(.834,-.916),(.913,-.72),(.913,.40),(.831,.57),(.355,.49),(.334,-.965)]
    tube('09 / precise door panel shut line',[flank(side,y,z) for y,z,_ in smooth_path([(y,z,0) for y,z in door],4)],.003,'trim')
    box('09 / flush door handle recess',(.015,.032,.135),(side*.958,.827,.23),'trim',.005)
    box('09 / polished door handle',(.019,.013,.105),(side*.970,.834,.23),'alloy',.003)
    box('09 / full carbon sill',(.115,.065,1.90),(side*.958,.239,.03),'carbon',.015)
    tube('09 / sculpted blue lower door edge',[flank(side,.316,-.91),flank(side,.322,-.24),flank(side,.337,.52)],.014,'paint',sides=1)
    subtract(shell,box('Side engine intake cavity',(.44,.50,.33),(side*.988,.635,.77),radius=0))
    plate('10 / deep C-line intake pocket',[(side*.806,.37,.59),(side*.816,.83,.54),(side*.819,.975,.72),(side*.820,.863,.95),(side*.807,.429,.97)],'trim',.03,.008)
    for i in range(5):
        z=.65+i*.06;tube('10 / intake inner vertical vane',[(side*.853,.420,z),(side*.87,.833,z)],.007,'carbon')
    c=[(side*.659,1.407,-.29),(side*.650,1.43,.27),(side*.709,1.38,.69),
       (side*.821,1.235,.98),(side*.964,.96,1.10),(side*1.007,.692,1.05),
       (side*.995,.467,.87),(side*.964,.345,.57),(side*.969,.322,.06),(side*1.002,.317,-.91)]
    tube('10 / iconic polished Bugatti C-line',smooth_path(c,6),.015,'alloy')

def grid_surface(name,rows,cols,point,mat,smooth=True,thickness=0):
    p=[point(u/cols,v/rows) for v in range(rows+1) for u in range(cols+1)];f=[]
    for v in range(rows):
        for u in range(cols):
            a=v*(cols+1)+u;f.append((a,a+1,a+cols+2,a+cols+1))
    obj=mesh(name,p,f,mat,smooth=smooth)
    if thickness:
        mod=obj.modifiers.new('Laminated thickness','SOLIDIFY');mod.thickness=thickness
    return obj

def windpoint(u,v):
    return ((2*u-1)*(.776*(1-v)+.614*v),.998*(1-v)+1.412*v+.026*math.sin(math.pi*u)*math.sin(math.pi*v),-.974*(1-v)-.280*v-.029*math.sin(math.pi*u))
grid_surface('11 / curved laminated windshield',8,16,windpoint,'glass')
for v in (0,1):tube('11 / bonded windshield seal',[windpoint(i/16,v) for i in range(17)],.008,'trim')
for side in (-1,1):
    tube('11 / sculpted A pillar',smooth_path([(side*.806,.963,-1.006),(side*.757,1.092,-.819),(side*.683,1.282,-.493),(side*.636,1.443,-.254)],7),.026,'paint',sides=1)
    tube('11 / A pillar gasket',[windpoint(0 if side<0 else 1,i/12) for i in range(13)],.005,'trim')
    side_window=[(side*.788,1.003,-.862),(side*.626,1.397,-.232),(side*.631,1.401,.411),(side*.712,1.298,.698),(side*.810,1.047,.891)]
    plate('12 / frameless side glazing',side_window,'glass',.007,.004)
    tube('12 / glazing rubber perimeter',side_window+[side_window[0]],.006,'trim')
    tube('12 / window beltline',smooth_path([(side*.812,.983,-.925),(side*.836,1.01,-.30),(side*.83,1.016,.36),(side*.839,1.028,.89)],6),.016,'paint',sides=1)
    plate('12 / rear cabin pillar',[(side*.65,1.439,.38),(side*.699,1.414,.59),(side*.824,1.129,.963),(side*.806,1.047,.891),(side*.712,1.298,.698),(side*.631,1.401,.411)],'secondaryPaint',.025,.007)
    tube('13 / mirror aero stalk',[(side*.804,1.022,-.644),(side*.965,1.043,-.644)],.012,'trim')
    box('13 / smooth mirror housing',(.148,.074,.183),(side*.988,1.071,-.616),'paint',.032)
    box('13 / mirror lower carbon cap',(.144,.025,.16),(side*.990,1.038,-.616),'carbon',.012)
    box('13 / reflective mirror glass',(.111,.048,.008),(side*.988,1.073,-.520),'alloy',.010)
    box('13 / mirror indicator',(.116,.004,.007),(side*.988,1.072,-.713),'amber',.002)

def roofpoint(u,v):
    return ((2*u-1)*(.645-.025*math.sin(math.pi*v)),1.435+.039*math.sin(math.pi*u)+.018*math.sin(math.pi*v),-.278+.898*v)
grid_surface('14 / crowned coupe roof',6,12,roofpoint,'paint',thickness=.023)
tube('14 / Atlantic inspired central fin',[(0,1.473,-.245),(0,1.491,.15),(0,1.474,.595),(0,1.247,.918)],.006,'paint')
def rearpoint(u,v):
    return ((2*u-1)*(.59+.167*v),1.42-.355*v+.012*math.sin(math.pi*u),.625+.432*v)
grid_surface('15 / rear curved glazing',6,12,rearpoint,'glass')
for v in (0,1):tube('15 / rear glass seal',[rearpoint(i/12,v) for i in range(13)],.007,'trim')
for side in (-1,1):
    plate('15 / rear flying buttress',[(side*.641,1.441,.60),(side*.764,1.075,1.071),(side*.903,1.022,1.70),(side*.785,1.168,.98)],'secondaryPaint',.018,.008)
    tube('15 / parked windshield wiper',[(side*.41,1.015,-.952),(side*.21,1.052,-.882),(side*.06,1.058,-.884)],.005,'trim')

plate('16 / recessed mid-engine bed',[(-.643,1.043,1.103),(.643,1.043,1.103),(.609,.866,2.14),(-.609,.866,2.14)],'trim',.022)
for side in (-1,1):
    cover=box('16 / brushed W16 bank cover',(.373,.043,.697),(side*.266,1.004,1.53),'alloy',.018);cover.rotation_euler.x=.13
    for i in range(8):
        z=1.215+i*.081;y=1.068-(z-1.18)*.14
        box('16 / engine cover transverse rib',(.338,.012,.015),(side*.266,y,z),'secondaryPaint',.003)
    for z in (1.23,1.84):
        for x in (.12,.42):cylinder('16 / engine cover fastener',.009,.007,(side*x,1.045-(z-1.18)*.14,z),'alloy','y',vertices=8)
    tube('16 / intake plenum',smooth_path([(side*.49,.953,1.17),(side*.55,.944,1.59),(side*.49,.897,1.97)],6),.029,'carbon',sides=1)
for i in range(7):
    z=1.35+i*.102;box('16 / engine heat extractor',(.122,.02,.019),(0,1.011-(z-1.35)*.15,z),'carbon',.003)
lettering('16 / W16 engine designation','W16',(0,1.096,1.204),.041)
plate('17 / raised active aerofoil',[(-.89,1.115,1.956),(.89,1.115,1.956),(.986,1.082,2.16),(.90,1.077,2.275),(-.90,1.077,2.275),(-.986,1.082,2.16)],'secondaryPaint',.04,.011)
for side in (-1,1):
    box('17 / active wing actuator',(.036,.203,.093),(side*.592,.992,2.105),'alloy',.006)
    box('17 / wing actuator fairing',(.134,.042,.25),(side*.591,.894,2.105),'secondaryPaint',.01)
subtract(shell,box('Rear grille cavity',(1.74,.251,.30),(0,.558,2.47),radius=0))
box('18 / deep rear cooling panel',(1.775,.279,.020),(0,.547,2.311),'trim',.016)
for i in range(31):box('18 / rear vertical grille mesh',(.004,.207,.008),((i-15)*.055,.548,2.334),'alloy',0)
for y in (.464,.511,.558,.605,.652):box('18 / rear horizontal grille mesh',(1.705,.003,.008),(0,y,2.338),'alloy',0)
box('18 / red ribbon recess',(1.843,.033,.020),(0,.715,2.525),'trim',.010)
lettering('18 / rear BUGATTI lettering','BUGATTI',(0,.570,2.343),.056)
bpy.data.objects['18 / rear BUGATTI lettering'].rotation_euler=(-math.pi/2,0,math.pi)
box('19 / quad-exhaust recess',(.915,.162,.035),(0,.349,2.51),'trim',.025)
plate('19 / carbon rear diffuser',[(-.956,.248,2.60),(.956,.248,2.60),(.893,.223,1.94),(-.893,.223,1.94)],'carbon',.035,.008)
for x in (-.88,-.52,0,.52,.88):plate('19 / diffuser strake',[(x,.218,1.94),(x,.235,2.593),(x,.368,2.55),(x,.311,2.01)],'carbon',.016,.004)

# Reference wheels and cabin make the .blend and GLB complete editable cars.
for side in (-1,1):
    for axle in (-1.43,1.43):
        center=(side*.895,.385,axle)
        bpy.ops.mesh.primitive_torus_add(major_segments=44,minor_segments=10,location=xyz(center),major_radius=.318,minor_radius=.06)
        tire=bpy.context.object;tire.name='Wheel / performance tire';tire.rotation_euler.y=math.pi/2;tire.scale.z=2.05
        move_collection(tire,preview_collection);tire.data.materials.append(M['rubber'])
        for p in tire.data.polygons:p.use_smooth=True
        face=side*1.003
        bpy.ops.mesh.primitive_torus_add(major_segments=44,minor_segments=6,location=xyz((face,.385,axle)),major_radius=.310,minor_radius=.012)
        rim=bpy.context.object;rim.name='Wheel / forged rim';rim.rotation_euler.y=math.pi/2
        move_collection(rim,preview_collection);rim.data.materials.append(M['alloy'])
        cylinder('Wheel / ceramic brake disc',.228,.018,(face-side*.032,.385,axle),collection=preview_collection,vertices=36)
        cylinder('Wheel / center hub',.055,.024,(face,.385,axle),collection=preview_collection,vertices=20)
        for i in range(10):
            a=i*math.tau/10
            inner=(face,.385+math.cos(a)*.062,axle+math.sin(a)*.062)
            mid=(face,.385+math.cos(a+.045)*.187,axle+math.sin(a+.045)*.187)
            for da in (-.07,.07):tube('Wheel / forged Y spoke',[inner,mid,(face,.385+math.cos(a+da)*.297,axle+math.sin(a+da)*.297)],.009,'alloy',preview_collection)
        box('Wheel / red brake caliper',(.045,.127,.074),(face-side*.025,.479,axle+.159),'redAccent',.012,preview_collection)
    for x in (.445,.57,.695,.82):box('Lamp / LED projector',(.067,.031,.009),(side*x,.700,-2.565),'white',.003,preview_collection)
for x in (-.30,-.10,.10,.30):
    cylinder('Exhaust / titanium outlet',.066,.13,(x,.350,2.51),'alloy','z',preview_collection,vertices=24)
    cylinder('Exhaust / dark interior',.053,.135,(x,.350,2.515),'trim','z',preview_collection,vertices=24)
box('Lamp / red rear ribbon',(1.80,.011,.010),(0,.715,2.550),'red',.003,preview_collection)
for side in (-1,1):
    box('Cabin / leather cushion',(.34,.105,.41),(side*.32,.485,.18),'leather',.025,preview_collection)
    seat=box('Cabin / leather seat back',(.34,.45,.08),(side*.32,.754,.40),'leather',.025,preview_collection);seat.rotation_euler.x=-.20
    box('Cabin / padded headrest',(.22,.15,.07),(side*.32,1.006,.465),'leather',.025,preview_collection)
box('Cabin / carbon dashboard',(1.22,.09,.24),(0,.906,-.66),'carbon',.02,preview_collection)
box('Cabin / center console',(.19,.15,.78),(0,.561,.04),'carbon',.015,preview_collection)

floor=box('Studio floor',(200,.06,200),(0,-.05,0),'trim',0,studio_collection)
floor.data.materials.clear();floor.data.materials.append(material('Studio floor',(.07,.085,.105),.18,.34))
def area(name,pos,power,size,color):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
    obj=bpy.data.objects.new(name,data);studio_collection.objects.link(obj);obj.location=xyz(pos)
    obj.rotation_euler=(Vector(xyz((0,.7,0)))-obj.location).to_track_quat('-Z','Y').to_euler()
area('Key softbox',(-3,5,-4),1300,5,(.83,.91,1));area('Rear rim',(3,4,2),1650,4,(1,.87,.7));area('Front fill',(1,3,-4),900,3,(.8,.91,1))
data=bpy.data.cameras.new('Bugatti hero camera');camera=bpy.data.objects.new('Bugatti hero camera',data)
studio_collection.objects.link(camera);camera.location=xyz((-6.4,2.8,-7.5))
camera.rotation_euler=(Vector(xyz((0,.74,0)))-camera.location).to_track_quat('-Z','Y').to_euler();data.lens=51
scene=bpy.context.scene;scene.camera=camera;scene.render.engine='CYCLES';scene.cycles.samples=24
scene.render.threads_mode='FIXED';scene.render.threads=8;scene.cycles.use_denoising=True
scene.render.resolution_x=1440;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.world.color=(.14,.14,.14);scene.view_settings.view_transform='AgX';scene.render.filepath=str(OUT/'bugatti-chiron-studio.png')
for screen in bpy.data.screens:
    for a in screen.areas:
        if a.type=='VIEW_3D':a.spaces.active.region_3d.view_perspective='CAMERA'
bpy.ops.object.select_all(action='DESELECT');shell.select_set(True);bpy.context.view_layer.objects.active=shell
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'bugatti-chiron.blend'))
runpy.run_path(str(ROOT/'scripts'/'export-blender-car.py'),run_name='__main__')
if '--render' in sys.argv:bpy.ops.render.render(write_still=True)
