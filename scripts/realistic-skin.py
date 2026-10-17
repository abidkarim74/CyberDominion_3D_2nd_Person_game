"""Keep scanned skin detail while removing the old cropped-arm material seam.

The source normal map baked a fold at the end of its short sleeve. Its arm
has since been extended, so that fold would look like a dark cuff on bare
skin. Only broad normal-map shading around that former boundary is softened;
the original freckles, pores, fine wrinkles and finger anatomy are retained.
"""
import bpy
import numpy as np


def _image(material, socket):
    p = material.node_tree.nodes.get('Principled BSDF')
    if not p or not p.inputs[socket].is_linked:
        return None
    node = p.inputs[socket].links[0].from_node
    if node.type == 'NORMAL_MAP':
        node = node.inputs['Color'].links[0].from_node
    return node if node.type == 'TEX_IMAGE' else None


def _samples(obj, image, predicate):
    w, h = image.size
    pixels = np.asarray(image.pixels[:], dtype=np.float32).reshape(h, w, 4)
    uv = obj.data.uv_layers.active
    samples = []
    for loop in obj.data.loops:
        p = obj.matrix_world @ obj.data.vertices[loop.vertex_index].co
        if predicate(p):
            u, v = uv.data[loop.index].uv
            samples.append(pixels[min(h-1, max(0, int(v*h))), min(w-1, max(0, int(u*w))), :3])
    return np.median(samples, axis=0) if samples else None


def _blur(array, radius):
    # A separable box filter avoids a dependency on SciPy in Blender Python.
    out = array
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode='edge')
        integral = np.cumsum(padded, axis=axis, dtype=np.float64)
        shape = list(integral.shape)
        shape[axis] = 1
        integral = np.concatenate((np.zeros(shape), integral), axis=axis)
        a = [slice(None)] * out.ndim
        b = [slice(None)] * out.ndim
        a[axis] = slice(2*radius+1, None)
        b[axis] = slice(None, -(2*radius+1))
        out = ((integral[tuple(a)]-integral[tuple(b)])/(2*radius+1)).astype(np.float32)
    return out


def _arm_mask(obj, size):
    """Rasterize a soft mask from anatomical coordinates onto the source UVs."""
    w, h = size
    mask = np.zeros((h, w), dtype=np.float32)
    uv = obj.data.uv_layers.active
    obj.data.calc_loop_triangles()
    for triangle in obj.data.loop_triangles:
        points = [obj.matrix_world @ obj.data.vertices[i].co for i in triangle.vertices]
        # The sleeve cut sat at x=.33 m in the source T-pose.
        weights = np.asarray([np.exp(-((abs(p.x)-.328)/.047)**4) if 1.25 < p.z < 1.56 else 0 for p in points])
        if max(weights) < .002:
            continue
        coords = np.asarray([uv.data[i].uv[:] for i in triangle.loops]) * (w, h)
        low = np.maximum(0, np.floor(coords.min(axis=0)).astype(int)-1)
        high = np.minimum((w-1, h-1), np.ceil(coords.max(axis=0)).astype(int)+1)
        if np.any(high < low):
            continue
        a, b, c = coords
        determinant = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(determinant) < 1e-8:
            continue
        yy, xx = np.mgrid[low[1]:high[1]+1, low[0]:high[0]+1]
        s = ((b[1]-c[1])*(xx+.5-c[0])+(c[0]-b[0])*(yy+.5-c[1]))/determinant
        t = ((c[1]-a[1])*(xx+.5-c[0])+(a[0]-c[0])*(yy+.5-c[1]))/determinant
        q = 1-s-t
        inside = (s >= -.02) & (t >= -.02) & (q >= -.02)
        value = np.clip(s*weights[0]+t*weights[1]+q*weights[2], 0, 1)*inside
        part = mask[low[1]:high[1]+1, low[0]:high[0]+1]
        np.maximum(part, value, out=part)
    # Cover the filtering footprint of the narrow, shared boundary texels.
    for _ in range(3):
        mask = np.maximum.reduce((mask, np.roll(mask,1,0),np.roll(mask,-1,0),np.roll(mask,1,1),np.roll(mask,-1,1)))
    return _blur(mask, 2)


def refine_skin(skin, head, skinmat, headmat):
    base = _image(skinmat, 'Base Color')
    scanned = _image(headmat, 'Base Color')
    if not base or not scanned:
        raise RuntimeError('Detailed source and scanned skin albedos are required')
    body_color = _samples(skin, base.image, lambda p: abs(p.x) < .09 and 1.42 < p.z < 1.51)
    zmin = min((head.matrix_world @ v.co).z for v in head.data.vertices)
    head_color = _samples(head, scanned.image, lambda p: zmin+.009 < p.z < zmin+.040 and p.y < .025)
    gain = np.clip(head_color/body_color, .82, 1.12) if body_color is not None and head_color is not None else np.ones(3)
    im = base.image.copy()
    im.name = 'Realistic / matched detailed arms chest and hands albedo'
    w, h = im.size
    pixels = np.asarray(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    pixels[:,:,:3] = np.clip(pixels[:,:,:3]*gain, 0, 1)
    im.pixels.foreach_set(pixels.ravel());im.update();im.pack();base.image = im

    normal = _image(skinmat, 'Normal')
    if normal:
        im = normal.image.copy()
        im.name = 'Realistic / skin pores with healed former sleeve boundary'
        w, h = im.size
        pixels = np.asarray(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        mask = _arm_mask(skin, (w, h))[:,:,None]
        xy = pixels[:,:,:2]-.5
        broad = _blur(xy, 7)
        # Keep pore-scale variation; suppress the source's unrelated broad fold.
        pixels[:,:,:2] = np.clip(.5+xy-.88*broad*mask, 0, 1)
        xyn = (pixels[:,:,:2]-.5)*2
        pixels[:,:,2] = np.sqrt(np.clip(1-(xyn*xyn).sum(axis=2), .01, 1))*.5+.5
        im.colorspace_settings.name = 'Non-Color'
        im.pixels.foreach_set(pixels.ravel());im.update();im.pack();normal.image = im
    p = skinmat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Roughness'].default_value = .65
    p.inputs['Specular IOR Level'].default_value = .24
    print('REALISTIC_SKIN_COMPLETE', {'bodyToScanGain': gain.tolist(), 'healedSleeveNormal': bool(normal)}, flush=True)
