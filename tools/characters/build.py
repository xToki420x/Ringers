#!/usr/bin/env python3
"""
Build the game's two signature pitchers, Cody and Sarah, as skinned GLB
models from MakeHuman's CC0 assets (base mesh, targets, skins, eyes, hair and
clothes), using the data packaged in the npm module `makehuman-data`:

    npm pack makehuman-data@0.0.2 && tar xzf makehuman-data-0.0.2.tgz
    python3 tools/characters/build.py package/public/data src/assets/characters [cody|sarah]

For each character this
  1. shapes the base body with MakeHuman's macro targets (gender, age,
     muscle, weight, height, proportions, ethnicity, breast) and a few face
     and body targets from the character sheet;
  2. fits eyes, eyebrows, eyelashes, hair, clothes and shoes (MakeHuman
     proxies) to the shaped body and hides the skin under the clothes;
  3. bakes a game rest pose — arms hanging by the sides, fingers relaxed —
     with MakeHuman's skin weights;
  4. folds MakeHuman's skeleton into the game's 17 bones (hips, spine, chest,
     neck, head, upper arm, forearm, hand, thigh, shin, foot) with translation-
     only joints, so the game's procedural delivery drives it unchanged;
  5. recolours garments to the character's colours (garment textures become
     neutral detail maps tinted by material colour, so other looks can reuse
     the same model), paints stubble onto Cody's skin, and writes a GLB.
"""

import io
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageFilter

DATA = sys.argv[1] if len(sys.argv) > 1 else 'package/public/data'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'src/assets/characters'
SRC = os.path.join(DATA, '..', '..', 'src', 'json')

# ---------------------------------------------------------------- base data

base = json.load(open(os.path.join(DATA, 'models', 'human_full_size.json')))
V0 = np.array(base['vertices'], dtype=np.float64).reshape(-1, 3)
NV = len(V0)
JOINTS = base['metadata']['joint_pos_idxs']
BONES_MH = base['bones']


def parse_faces(d):
    """Faces of a three.js JSON (format 3.1) model: (vertex idx, uv idx, material) per face."""
    f = d['faces']
    out = []
    i = 0
    nuv = len(d.get('uvs', [])) and (1 if d['uvs'][0] else 0)
    while i < len(f):
        t = f[i]
        i += 1
        n = 4 if t & 1 else 3
        vs = f[i:i + n]
        i += n
        mat = 0
        if t & 2:
            mat = f[i]
            i += 1
        if t & 4:
            i += nuv
        uvs = None
        if t & 8:
            uvs = f[i:i + n]
            i += n * max(nuv, 1)
        if t & 16:
            i += 1
        if t & 32:
            i += n
        if t & 64:
            i += 1
        if t & 128:
            i += n
        out.append((vs, uvs, mat))
    return out


BASE_FACES = parse_faces(base)
BASE_UV = np.array(base['uvs'][0], dtype=np.float64).reshape(-1, 2)
MATS = [m['DbgName'] for m in base['materials']]
BODY_MAT = MATS.index('body')

# Targets: Int16 rows (x1e-3) for every target, in sorted path order.
TARGET_PATHS = sorted(p.lower() for p in json.load(open(os.path.join(SRC, 'targets', 'target-list.json')))['targets'])
TARGET_INDEX = {p: i for i, p in enumerate(TARGET_PATHS)}
TARGETS = np.memmap(os.path.join(DATA, 'targets', 'targets.bin'), dtype=np.int16, mode='r').reshape(len(TARGET_PATHS), NV * 3)
assert int(TARGETS[3].astype(np.int64).sum()) == 2952, 'target data out of order'
CATEGORIES = json.load(open(os.path.join(SRC, 'targets', 'target-category-data.json')))


def macro_factors(s):
    """MakeHuman macro variable values (see makehuman's humanmodifier / factors)."""
    f = {}
    g = s['gender']
    f['female'], f['male'] = 1 - g, g
    a = s['age']
    if a < 0.5:
        f['old'] = 0
        f['baby'] = max(0, 1 - a * 5.333)
        f['young'] = max(0, (a - 0.1875) * 3.2)
        f['child'] = max(0, min(1, 5.333 * a) - f['young'])
    else:
        f['child'] = f['baby'] = 0
        f['old'] = max(0, a * 2 - 1)
        f['young'] = 1 - f['old']

    def tri(v, lo, mid, hi):
        f[hi] = max(0, v * 2 - 1)
        f[lo] = max(0, 1 - v * 2)
        f[mid] = 1 - max(f[hi], f[lo])

    tri(s['muscle'], 'minmuscle', 'averagemuscle', 'maxmuscle')
    tri(s['weight'], 'minweight', 'averageweight', 'maxweight')
    tri(s['height'], 'minheight', 'averageheight', 'maxheight')
    tri(s.get('cup', 0.5), 'mincup', 'averagecup', 'maxcup')
    tri(s.get('firmness', 0.5), 'minfirmness', 'averagefirmness', 'maxfirmness')
    tri(s.get('proportions', 0.5), 'uncommonproportions', 'regularproportions', 'idealproportions')
    race = s['race']
    tot = sum(race.values())
    for k in ('african', 'asian', 'caucasian'):
        f[k] = race.get(k, 0) / tot
    return f


def shaped(spec):
    """Base vertices with the character's targets applied (decimetres)."""
    f = macro_factors(spec)
    w = np.zeros(len(TARGET_PATHS))
    for i, p in enumerate(TARGET_PATHS):
        if '/macrodetails' in p or p.startswith('data/targets/breast/female-') or p.startswith('data/targets/breast/male-'):
            name = p.rsplit('/', 1)[1][:-len('.target')]
            val = 1.0
            for tok in name.split('-'):
                if tok in CATEGORIES:
                    val *= f.get(tok, 0)
            w[i] = val
    for path, val in spec['targets'].items():
        w[TARGET_INDEX[f'data/targets/{path}.target']] += val
    nz = np.nonzero(w)[0]
    d = (w[nz, None] * TARGETS[nz].astype(np.float64)).sum(0) * 1e-3
    return V0 + d.reshape(-1, 3)


# ------------------------------------------------------------ MH skeleton

MH_NAMES = [b['name'] for b in BONES_MH]
MH_REAL = [i for i, n in enumerate(MH_NAMES) if not n.endswith('____head')]


def mh_parent(i):
    """Real parent bone of real bone i (skipping the '____head' helpers)."""
    p = BONES_MH[i]['parent']
    while p >= 0 and MH_NAMES[p].endswith('____head'):
        p = BONES_MH[p]['parent']
    return p


def joint(V, name):
    return V[JOINTS[name]].mean(0)


def rot(axis, ang):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    x, y, z = axis
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def pose_transforms(V, rots):
    """World affine transforms (3x4) for every MH bone given per-bone rotations
    (in the rest frame, about the bone's head), composed down the hierarchy."""
    T = {}
    order = sorted(MH_REAL, key=lambda i: depth(i))
    for i in order:
        p = mh_parent(i)
        Mp = T[p] if p >= 0 else (np.eye(3), np.zeros(3))
        name = MH_NAMES[i]
        R = rots.get(name)
        if R is None:
            T[i] = Mp
            continue
        h = joint(V, name + '____head')
        # local: x -> R (x - h) + h ; then parent's.
        Rl, tl = R, h - R @ h
        T[i] = (Mp[0] @ Rl, Mp[0] @ tl + Mp[1])
    return T


_depth = {}


def depth(i):
    if i not in _depth:
        p = mh_parent(i)
        _depth[i] = 0 if p < 0 else depth(p) + 1
    return _depth[i]


def skin(P, idx, wts, T):
    """Linear blend skinning of points P with MH bone indices/weights."""
    out = np.zeros_like(P)
    for k in range(idx.shape[1]):
        for b in np.unique(idx[:, k]):
            if b not in T:
                continue
            m = (idx[:, k] == b) & (wts[:, k] > 0)
            if not m.any():
                continue
            R, t = T[b]
            out[m] += wts[m, k:k + 1] * (P[m] @ R.T + t)
    s = wts.sum(1, keepdims=True)
    lost = s[:, 0] < 1e-6
    out[lost] = P[lost]
    out[~lost] /= s[~lost]
    return out


# Weights reference the '____head' helper entries; point them at the real bones.
_REAL_OF = np.array([MH_NAMES.index(n[:-len('____head')]) if n.endswith('____head') and n[:-len('____head')] in MH_NAMES else i
                     for i, n in enumerate(MH_NAMES)])


def real_idx(idx):
    return _REAL_OF[np.asarray(idx)]


BASE_IDX = real_idx(np.array(base['skinIndices']).reshape(-1, 4))
BASE_W = np.array(base['skinWeights'], dtype=np.float64).reshape(-1, 4)

# ------------------------------------------------------------- game rig

GAME_BONES = [
    ('hips', None, 'spine05'), ('spine', 'hips', 'spine03'), ('chest', 'spine', 'spine01'),
    ('neck', 'chest', 'neck01'), ('head', 'neck', 'head'),
    ('upperArmL', 'chest', 'upperarm01.L'), ('forearmL', 'upperArmL', 'lowerarm01.L'), ('handL', 'forearmL', 'wrist.L'),
    ('upperArmR', 'chest', 'upperarm01.R'), ('forearmR', 'upperArmR', 'lowerarm01.R'), ('handR', 'forearmR', 'wrist.R'),
    ('thighL', 'hips', 'upperleg01.L'), ('shinL', 'thighL', 'lowerleg01.L'), ('footL', 'shinL', 'foot.L'),
    ('thighR', 'hips', 'upperleg01.R'), ('shinR', 'thighR', 'lowerleg01.R'), ('footR', 'shinR', 'foot.R'),
]
GAME_INDEX = {n: i for i, (n, _, _) in enumerate(GAME_BONES)}
# MakeHuman bones that open a game bone's region; everything below follows it.
REGION = {
    'root': 'hips', 'spine05': 'hips', 'pelvis.L': 'hips', 'pelvis.R': 'hips',
    'spine04': 'spine', 'spine03': 'spine',
    'spine02': 'chest', 'spine01': 'chest', 'clavicle.L': 'chest', 'clavicle.R': 'chest', 'breast.L': 'chest', 'breast.R': 'chest',
    'neck01': 'neck', 'head': 'head',
    'shoulder01.L': 'upperArmL', 'upperarm01.L': 'upperArmL', 'lowerarm01.L': 'forearmL', 'wrist.L': 'handL',
    'shoulder01.R': 'upperArmR', 'upperarm01.R': 'upperArmR', 'lowerarm01.R': 'forearmR', 'wrist.R': 'handR',
    'upperleg01.L': 'thighL', 'lowerleg01.L': 'shinL', 'foot.L': 'footL',
    'upperleg01.R': 'thighR', 'lowerleg01.R': 'shinR', 'foot.R': 'footR',
}


def game_bone_of(i):
    j = i
    while j >= 0:
        n = MH_NAMES[j]
        if n in REGION:
            return GAME_INDEX[REGION[n]]
        j = mh_parent(j)
    return 0


MH_TO_GAME = {i: game_bone_of(i) for i in MH_REAL}


def game_weights(idx, wts):
    """Fold MH weights into the game bones, keeping the four largest."""
    n = len(idx)
    acc = np.zeros((n, len(GAME_BONES)))
    for k in range(idx.shape[1]):
        g = np.array([MH_TO_GAME.get(int(b), 0) for b in idx[:, k]])
        np.add.at(acc, (np.arange(n), g), wts[:, k])
    order = np.argsort(-acc, axis=1)[:, :4]
    w = np.take_along_axis(acc, order, 1)
    s = w.sum(1, keepdims=True)
    s[s == 0] = 1
    w = w / s
    w[:, 0] += 1 - w.sum(1)  # exact sum
    return order.astype(np.uint16), w.astype(np.float32)


# ---------------------------------------------------------------- proxies

def load_proxy(rel):
    path = os.path.join(DATA, 'proxies', rel)
    d = json.load(open(path))
    d['_dir'] = os.path.dirname(path)
    return d


def fit_proxy(d, V):
    ref = np.array(d['ref_vIdxs'])
    w = np.array(d['weights'], dtype=np.float64)
    off = np.array(d['offsets'], dtype=np.float64)
    return (V[ref] * w[:, :, None]).sum(1) + off


# ------------------------------------------------------------- geometry

def outward(faces, P):
    """Wind each face so its normal points away from the centre of its eyeball."""
    out = []
    centre = {s: P[(P[:, 0] > 0) == (s > 0)].mean(0) for s in (1, -1)}
    for vs, uvs, m in faces:
        a, b, c = P[vs[0]], P[vs[1]], P[vs[2]]
        n = np.cross(b - a, c - a)
        mid = P[list(vs)].mean(0)
        if n @ (mid - centre[1 if mid[0] > 0 else -1]) < 0:
            vs, uvs = vs[::-1], (uvs[::-1] if uvs else uvs)
        out.append((vs, uvs, m))
    return out


def lift_over(P, faces, below_y, amount, mask=None):
    """Push the vertices of a garment that hang below `below_y` out along their
    normals, so a shirt's hem lies over the pants' waistband instead of through it."""
    tris = [t for t, k in zip(tri_faces(faces), mask or [True] * len(tri_faces(faces))) if k]
    N = vertex_normals(P, [t[0] for t in tris])
    used = np.zeros(len(P), bool)
    for vs, _ in tris:
        used[list(vs)] = True
    w = used & (P[:, 1] < below_y)
    out = P.copy()
    out[w] += N[w] * amount
    return out


def tri_faces(faces):
    """Split quads; returns list of (v-triple, uv-triple)."""
    out = []
    for vs, uvs, _ in faces:
        uvs = uvs or vs
        out.append(((vs[0], vs[1], vs[2]), (uvs[0], uvs[1], uvs[2])))
        if len(vs) == 4:
            out.append(((vs[0], vs[2], vs[3]), (uvs[0], uvs[2], uvs[3])))
    return out


def vertex_normals(P, tris):
    n = np.zeros_like(P)
    t = np.array(tris)
    a, b, c = P[t[:, 0]], P[t[:, 1]], P[t[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, t[:, k], fn)
    l = np.linalg.norm(n, axis=1, keepdims=True)
    bad = l[:, 0] < 1e-12
    n[bad] = [0, 1, 0]
    l[bad] = 1
    return n / l


def build_primitive(P, UV, faces, idx, wts, keep=None):
    """GL arrays for faces (vertex/uv index pairs), splitting vertices at UV seams.
    Normals are smooth across seams. Degenerate triangles are dropped."""
    tris = tri_faces(faces) if keep is None else [t for t, k in zip(tri_faces(faces), keep) if k]
    good = []
    for vs, uvs in tris:
        a, b, c = P[vs[0]], P[vs[1]], P[vs[2]]
        if np.linalg.norm(np.cross(b - a, c - a)) > 1e-10:
            good.append((vs, uvs))
    N = vertex_normals(P, [t[0] for t in good])
    key = {}
    pos, nor, uv, ji, jw, index = [], [], [], [], [], []
    for vs, uvs in good:
        for v, u in zip(vs, uvs):
            k = (v, u)
            if k not in key:
                key[k] = len(pos)
                pos.append(P[v])
                nor.append(N[v])
                uv.append(UV[u])
                ji.append(idx[v])
                jw.append(wts[v])
            index.append(key[k])
    return {
        'position': np.array(pos, dtype=np.float32), 'normal': np.array(nor, dtype=np.float32),
        'uv': np.array(uv, dtype=np.float32), 'joints': np.array(ji, dtype=np.uint16), 'weights': np.array(jw, dtype=np.float32),
        'index': np.array(index, dtype=np.uint32),
    }


# --------------------------------------------------------------- textures

def detail_map(img, strength=1.0):
    """Neutral (grey) detail from a garment texture: luminance relative to its
    smoothed self, so the material colour sets the hue and shade. Unused
    (transparent) texels take the average so seams don't bleed dark."""
    im = img.convert('RGBA')
    a = np.asarray(im).astype(np.float64) / 255
    lum = a[..., :3] @ np.array([0.299, 0.587, 0.114])
    used = a[..., 3] > 0.5
    lum[~used] = lum[used].mean()
    blur = np.asarray(Image.fromarray((lum * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(24))).astype(np.float64) / 255
    det = np.clip(0.8 + ((lum - blur) * 1.4 + (lum - lum[used].mean()) * 0.2) * strength, 0.6, 1)
    out = np.dstack([det, det, det, a[..., 3]])
    return Image.fromarray((out * 255).astype(np.uint8), 'RGBA')


def png_bytes(img, fmt='PNG', **kw):
    b = io.BytesIO()
    img.save(b, fmt, **kw)
    return b.getvalue()


# --------------------------------------------------------------- GLB writer

class GLB:
    def __init__(self):
        self.g = {'asset': {'version': '2.0', 'generator': 'Ringers character builder (MakeHuman CC0 assets)'},
                  'buffers': [], 'bufferViews': [], 'accessors': [], 'meshes': [], 'nodes': [], 'materials': [],
                  'textures': [], 'images': [], 'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
                  'skins': [], 'scenes': [{'nodes': []}], 'scene': 0}
        self.bin = bytearray()

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.g['bufferViews'].append(v)
        return len(self.g['bufferViews']) - 1

    def accessor(self, arr, kind, target=None, minmax=False):
        ct = {np.float32: 5126, np.uint16: 5123, np.uint32: 5125, np.uint8: 5121}[arr.dtype.type]
        bv = self.view(arr.tobytes(), target)
        a = {'bufferView': bv, 'componentType': ct, 'count': len(arr), 'type': kind}
        if minmax:
            a['min'] = arr.min(0).tolist()
            a['max'] = arr.max(0).tolist()
        self.g['accessors'].append(a)
        return len(self.g['accessors']) - 1

    def image(self, data, mime):
        bv = self.view(data)
        self.g['images'].append({'bufferView': bv, 'mimeType': mime})
        self.g['textures'].append({'sampler': 0, 'source': len(self.g['images']) - 1})
        return len(self.g['textures']) - 1

    def material(self, m):
        self.g['materials'].append(m)
        return len(self.g['materials']) - 1

    def write(self, path):
        self.g['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.g, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942))
            f.write(self.bin)


# ------------------------------------------------------------ characters

CHARACTERS = {
    'cody': {
        # 32, 6'1", lean athletic, broad shoulders, strong forearms, square jaw.
        'gender': 1.0, 'age': 0.554, 'muscle': 0.7, 'weight': 0.45, 'height': 0.62, 'proportions': 0.8,
        'race': {'caucasian': 0.85, 'african': 0.05, 'asian': 0.1},
        'targets': {
            'head/head-square': 0.45, 'chin/chin-width-max': 0.3, 'chin/chin-prominent-more': 0.25, 'chin/chin-height-max': 0.15,
            'torso/torso-vshape-more': 0.45, 'neck/neck-scale-horiz-more': 0.25,
            'armslegs/l-lowerarm-muscle-incr': 0.5, 'armslegs/r-lowerarm-muscle-incr': 0.5,
            'eyebrows/eyebrows-trans-vert-less': 0.25, 'nose/nose-scale-horiz-decr': 0.15,
        },
        'height_m': 1.85,
        'skin': 'skins/young_caucasian_male/textures/young_lightskinned_male_diffuse.png',
        'skin_tint': (1.0, 0.96, 0.92),
        'stubble': True,
        'eyes': 'blue_eye.png',
        'eyebrows': 'eyebrows/eyebrow001/eyebrow001.json',
        'hair': 'hair/short04/short04.json',  # close crop: it sits under his cap
        'clothes': [
            {'proxy': 'clothes/male_casualsuit04/male_casualsuit04.json', 'split': 'shirt_pants'},
            {'proxy': 'clothes/shoes02/shoes02.json', 'part': 'shoes'},
        ],
    },
    'sarah': {
        # 28, 5'8", athletic, strong lower body, toned arms, heart-shaped face.
        'gender': 0.0, 'age': 0.523, 'muscle': 0.64, 'weight': 0.44, 'height': 0.55, 'proportions': 0.85,
        'cup': 0.5, 'firmness': 0.65,
        'race': {'caucasian': 0.5, 'african': 0.15, 'asian': 0.35},
        'targets': {
            'head/head-invertedtriangular': 0.35, 'chin/chin-width-min': 0.15,
            'buttocks/buttocks-volume-incr': 0.2, 'armslegs/l-upperleg-muscle-incr': 0.3, 'armslegs/r-upperleg-muscle-incr': 0.3,
            'mouth/mouth-lowerlip-volume-inflate': 0.2, 'mouth/mouth-upperlip-volume-inflate': 0.15,
            'breast/breast-point-min': 0.8, 'breast/breast-volume-vert-up': 0.2,
        },
        'height_m': 1.73,
        'skin': 'skins/young_caucasian_female/textures/young_lightskinned_female_diffuse.png',
        'skin_tint': (0.93, 0.82, 0.7),
        'stubble': False,
        'eyes': 'brownlight_eye.png',
        'eyebrows': 'eyebrows/eyebrow010/eyebrow010.json',
        'hair': 'hair/Braid01/Braid01.json',
        'clothes': [
            {'proxy': 'clothes/Tank_Top_01/Tank_Top_01.json', 'part': 'shirt'},
            {'proxy': 'clothes/Tightjeans/Tightjeans.json', 'part': 'pants'},
            {'proxy': 'clothes/shoes06/shoes06.json', 'part': 'shoes'},
        ],
    },
}


def align(a, b):
    """Smallest rotation taking direction a onto direction b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    ax = np.cross(a, b)
    s = np.linalg.norm(ax)
    if s < 1e-9:
        return np.eye(3)
    return rot(ax, math.atan2(s, float(a @ b)))


def rest_pose_rots(V):
    """The game's rest pose: arms hanging by the sides with soft elbows, hands
    straight off the forearms, fingers relaxed and gently curled.

    Each segment is turned onto a target direction; rotations are in the rest
    frame about the bone's head, so a child's rotation undoes its parent's."""
    rots = {}
    for side, s in (('L', 1), ('R', -1)):
        sh, el = joint(V, f'upperarm01.{side}____head'), joint(V, f'lowerarm01.{side}____head')
        wr = joint(V, f'wrist.{side}____head')
        knuckle = joint(V, f'finger3-1.{side}____head')
        up_t = np.array([s * math.sin(math.radians(11)), -math.cos(math.radians(11)), -0.02])
        fore_t = np.array([s * 0.07, -0.97, 0.24])
        hand_t = np.array([s * 0.0, -0.97, 0.2])
        R_up = align(el - sh, up_t)
        # Share the shoulder's turn with the shoulder bone for a smoother deltoid.
        ax = np.cross(el - sh, up_t)
        ang = math.acos(np.clip(float((el - sh) @ up_t) / np.linalg.norm(el - sh) / np.linalg.norm(up_t), -1, 1))
        rots[f'shoulder01.{side}'] = rot(ax, ang * 0.2)
        rots[f'upperarm01.{side}'] = rot(ax, ang * 0.8)
        R_fore = R_up.T @ align(R_up @ (wr - el), fore_t) @ R_up
        rots[f'lowerarm01.{side}'] = R_fore
        R_arm = R_up @ R_fore
        rots[f'wrist.{side}'] = R_arm.T @ align(R_arm @ (knuckle - wr), hand_t) @ R_arm
        # Fingers: curl toward the palm about an axis across the knuckles.
        across = joint(V, f'finger2-1.{side}____head') - joint(V, f'finger5-1.{side}____head')
        along = knuckle - wr
        palm = np.cross(along, across) * s
        axis = np.cross(along, palm) if palm[1] < 0 else np.cross(along, -palm)
        for f, (a1, a2, a3) in {2: (0.3, 0.45, 0.3), 3: (0.35, 0.5, 0.3), 4: (0.4, 0.5, 0.3), 5: (0.45, 0.5, 0.3)}.items():
            rots[f'finger{f}-1.{side}'] = rot(axis, a1)
            rots[f'finger{f}-2.{side}'] = rot(axis, a2)
            rots[f'finger{f}-3.{side}'] = rot(axis, a3)
        rots[f'finger1-2.{side}'] = rot(axis, 0.2)
        rots[f'finger1-3.{side}'] = rot(axis, 0.25)
    return rots


def recolour_suit(img):
    """Male casual suit texture: paint out the chest print, keep fabric detail."""
    a = np.asarray(img.convert('RGB')).astype(np.float64)
    h, w, _ = a.shape
    # The print sits on the front panel (upper middle of the shirt region).
    x0, x1, y0, y1 = int(w * 0.47), int(w * 0.66), int(h * 0.06), int(h * 0.28)
    region = a[y0:y1, x0:x1]
    base_col = np.median(region.reshape(-1, 3), axis=0)
    mask = np.abs(region - base_col).sum(2) > 45
    m = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    mask = np.asarray(m) > 0
    region[mask] = base_col
    a[y0:y1, x0:x1] = region
    return Image.fromarray(a.astype(np.uint8))


def build(name, spec):
    print('building', name)
    V = shaped(spec)
    rots = rest_pose_rots(V)
    T = pose_transforms(V, rots)
    VP = skin(V, BASE_IDX, BASE_W, T)
    # Joint positions after posing.
    def pjoint(n):
        mh = n
        i = MH_NAMES.index(mh)
        p = mh_parent(i)
        h = joint(V, mh + '____head')
        if p < 0:
            return h
        R, t = T[p]
        return R @ h + t

    # Units: decimetres -> metres, feet on the ground, hips over the origin, then exact height.
    heads = {g: pjoint(mh) for g, _, mh in GAME_BONES}
    proxies = []
    for key in ['eyebrows', 'hair']:
        proxies.append((key, load_proxy(spec[key])))
    proxies.append(('eyes', load_proxy('eyes/HighPolyEyes/HighPolyEyes.json')))
    proxies.append(('eyelashes', load_proxy('eyelashes/Eyelashes01/Eyelashes01.json')))
    for c in spec['clothes']:
        proxies.append((c.get('part') or c['split'], load_proxy(c['proxy'])))
    fitted = []
    hide = np.zeros(NV, bool)
    for key, d in proxies:
        P = fit_proxy(d, VP)
        k = d.get('influencesPerVertex', 4)
        idx = real_idx(np.array(d['skinIndices']).reshape(-1, k))
        w = np.array(d['skinWeights'], dtype=np.float64).reshape(-1, k)
        fitted.append((key, d, P, idx, w))
        if d['metadata'].get('type') == 'Clothes' and key not in ('hair', 'eyebrows', 'eyes', 'eyelashes'):
            hide |= np.array(d['metadata']['deleteVerts'], bool)
    allP = [VP] + [f[2] for f in fitted]
    ymin = min(p[:, 1].min() for p in allP)
    crown = VP[:, 1].max()
    scale = spec['height_m'] / ((crown - ymin) * 0.1) * 0.1
    origin = np.array([0.0, ymin, heads['hips'][2]])

    def tx(p):
        return (p - origin) * scale

    glb = GLB()
    nodes = glb.g['nodes']
    # Skeleton: translation-only joints.
    for i, (g, parent, _) in enumerate(GAME_BONES):
        h = tx(heads[g])
        ph = tx(heads[parent]) if parent else np.zeros(3)
        nodes.append({'name': g, 'translation': (h - ph).tolist()})
    for i, (g, parent, _) in enumerate(GAME_BONES):
        if parent:
            nodes[GAME_INDEX[parent]].setdefault('children', []).append(i)
    ibm = np.zeros((len(GAME_BONES), 16), np.float32)
    for i, (g, _, _) in enumerate(GAME_BONES):
        h = tx(heads[g])
        m = np.eye(4)
        m[:3, 3] = -h
        ibm[i] = m.T.reshape(-1)
    skin_i = len(glb.g['skins'])
    glb.g['skins'].append({'joints': list(range(len(GAME_BONES))), 'inverseBindMatrices': glb.accessor(ibm, 'MAT4'), 'skeleton': 0})
    root = len(nodes)
    nodes.append({'name': name, 'children': [0]})
    glb.g['scenes'][0]['nodes'] = [root]

    def add_mesh(label, prim_arrays, material):
        if len(prim_arrays['index']) == 0:
            return
        a = prim_arrays
        attrs = {
            'POSITION': glb.accessor(a['position'], 'VEC3', 34962, True),
            'NORMAL': glb.accessor(a['normal'], 'VEC3', 34962),
            'TEXCOORD_0': glb.accessor(a['uv'], 'VEC2', 34962),
            'JOINTS_0': glb.accessor(a['joints'], 'VEC4', 34962),
            'WEIGHTS_0': glb.accessor(a['weights'], 'VEC4', 34962),
        }
        ind = a['index'].astype(np.uint16) if a['index'].max() < 65535 else a['index']
        prim = {'attributes': attrs, 'indices': glb.accessor(ind, 'SCALAR', 34963), 'material': material}
        glb.g['meshes'].append({'name': label, 'primitives': [prim]})
        nodes.append({'name': label, 'mesh': len(glb.g['meshes']) - 1, 'skin': skin_i})
        nodes[root]['children'].append(len(nodes) - 1)

    def uv_of(d):
        uv = np.array(d['uvs'][0], dtype=np.float64).reshape(-1, 2)
        uv[:, 1] = 1 - uv[:, 1]
        return uv

    # Body: skin texture (with stubble for Cody), skin hidden under clothes removed.
    skin_img = Image.open(os.path.join(DATA, spec['skin'])).convert('RGB')
    sk = np.asarray(skin_img).astype(np.float64) * np.array(spec['skin_tint'])
    gi, gw = game_weights(BASE_IDX, BASE_W)
    body_faces = [f for f in BASE_FACES if f[2] == BODY_MAT]
    keep = []
    for vs, uvs, _ in body_faces:
        k = not all(hide[v] for v in vs)
        keep.extend([k] * (2 if len(vs) == 4 else 1))
    buv = BASE_UV.copy()
    buv[:, 1] = 1 - buv[:, 1]
    body = build_primitive(tx(VP), buv, body_faces, gi, gw, keep)
    if spec['stubble']:
        sk = paint_stubble(sk, body)
    skin_tex = glb.image(png_bytes(Image.fromarray(np.clip(sk, 0, 255).astype(np.uint8)), 'JPEG', quality=88), 'image/jpeg')
    skin_mat = glb.material({'name': 'skin', 'pbrMetallicRoughness': {'baseColorTexture': {'index': skin_tex}, 'metallicFactor': 0, 'roughnessFactor': 0.62}})
    add_mesh('body', body, skin_mat)

    # Top of the pants (decimetres): shirts lie over it.
    pants_top = max((f[2][:, 1].max() for f in fitted if f[0] == 'pants'), default=None)
    for key, d, P, idx, w in fitted:
        gi, gw = game_weights(idx, w)
        faces = parse_faces(d)
        uv = uv_of(d)
        mat = d['materials'][0]
        tex_path = os.path.join(d['_dir'], mat['mapDiffuse'])
        if key == 'eyes':
            tex_path = os.path.join(d['_dir'], 'textures', spec['eyes'])
        img = Image.open(tex_path)
        norm = mat.get('mapNormal')
        nidx = None
        if norm and os.path.exists(os.path.join(d['_dir'], norm)):
            nimg = Image.open(os.path.join(d['_dir'], norm)).convert('RGB')
            nidx = glb.image(png_bytes(nimg, 'JPEG', quality=90), 'image/jpeg')
        # The eyes' outer (cornea) shell maps to clear texels: cut it away.
        alpha = key in ('hair', 'eyebrows', 'eyelashes', 'eyes')
        if key in ('shirt_pants', 'shirt', 'pants', 'shoes'):
            src = recolour_suit(img) if key == 'shirt_pants' else img
            det = detail_map(src, {'pants': 0.4, 'shirt_pants': 0.5, 'shirt': 0.45}.get(key, 1.0))
            t = glb.image(png_bytes(det.convert('RGB'), 'JPEG', quality=88), 'image/jpeg')
        elif alpha:
            t = glb.image(png_bytes(img.convert('RGBA')), 'image/png')
        else:
            t = glb.image(png_bytes(img.convert('RGB'), 'JPEG', quality=90), 'image/jpeg')

        def material(label, extra=None):
            m = {'name': label, 'pbrMetallicRoughness': {'baseColorTexture': {'index': t}, 'metallicFactor': 0,
                                                         'roughnessFactor': {'eyes': 0.15, 'hair': 0.55, 'shoes': 0.6}.get(key, 0.85)}}
            if nidx is not None:
                m['normalTexture'] = {'index': nidx}
            if alpha:
                m['alphaMode'] = 'MASK'
                m['alphaCutoff'] = 0.35
                m['doubleSided'] = key != 'eyes'
            if extra:
                m.update(extra)
            return glb.material(m)

        if key == 'shirt_pants':
            # Split the one-piece outfit into shirt and pants: the shirt's panels
            # fill the top of its texture (down to 42%), the pants the rest.
            tris = tri_faces(faces)
            up = [uv[list(uvs)][:, 1].mean() < 0.42 for _, uvs in tris]
            pants_y = max(P[list(vs)][:, 1].max() for (vs, _), u in zip(tris, up) if not u)
            Pt = tx(lift_over(P, faces, pants_y + 0.1, 0.07, up))
            add_mesh('shirt', build_primitive(Pt, uv, faces, gi, gw, up), material('shirt'))
            add_mesh('pants', build_primitive(Pt, uv, faces, gi, gw, [not u for u in up]), material('pants'))
        else:
            if key == 'eyes':
                faces = outward(faces, P)
            if key == 'shirt' and pants_top is not None:
                P = lift_over(P, faces, pants_top + 0.1, 0.07)
            add_mesh(key, build_primitive(tx(P), uv, faces, gi, gw), material(key))

    # Fitting data for runtime trims (cap, buckle, accessories).
    glb.g['scenes'][0]['extras'] = {
        'height': spec['height_m'],
        'crown': float(tx(VP)[:, 1].max()),
        'source': 'MakeHuman 1.1 assets (CC0) via makehuman-data',
    }
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f'{name}.glb')
    glb.write(out)
    print('  wrote', out, round(os.path.getsize(out) / 1e6, 2), 'MB')


def paint_stubble(sk, body):
    """Darken the skin texture along the jaw, chin and upper lip: light stubble.
    The region is found from facial landmarks of the shaped head."""
    from PIL import ImageDraw
    h, w, _ = sk.shape
    P, uv, tri = body['position'], body['uv'], body['index'].reshape(-1, 3)
    head = body['joints'][:, 0] == GAME_INDEX['head']
    front = head & (P[:, 2] > np.median(P[head, 2]))
    nose = P[front][np.argmax(P[front, 2])]  # nose tip
    chin = P[front & (np.abs(P[:, 0]) < 0.01)][:, 1].min()
    rel_y = (P[:, 1] - chin) / (nose[1] - chin)  # 0 at the chin, 1 at the nose tip
    x, z = np.abs(P[:, 0]), P[:, 2] - nose[2]
    jaw = smooth(-0.12, 0.02, rel_y) * (1 - smooth(0.82, 0.95, rel_y + (x > 0.03) * 0.12))
    jaw *= smooth(-0.11, -0.085, z) * (1 - smooth(0.062, 0.072, x)) * head
    # Clear around the lips.
    mouth_y = 0.42
    lips = (1 - smooth(0.018, 0.026, x)) * (1 - smooth(0.1, 0.17, np.abs(rel_y - mouth_y))) * smooth(-0.03, -0.018, z)
    m = np.clip(jaw - lips * 1.5, 0, 1)
    canvas = Image.new('L', (w, h), 0)
    dr = ImageDraw.Draw(canvas)
    for t in tri:
        mv = m[t].mean()
        if mv > 0.01:
            dr.polygon([(uv[i, 0] * w, uv[i, 1] * h) for i in t], fill=int(mv * 255))
    mask = np.asarray(canvas.filter(ImageFilter.GaussianBlur(3))).astype(np.float64) / 255
    grain = np.random.default_rng(3).random((h, w)) * 0.4 + 0.6
    beard = np.array([58, 45, 38], dtype=np.float64)
    k = (mask * 0.6 * grain)[..., None]
    return sk * (1 - k) + beard * k


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


if __name__ == '__main__':
    only = sys.argv[3:] or list(CHARACTERS)
    for n in only:
        build(n, CHARACTERS[n])
