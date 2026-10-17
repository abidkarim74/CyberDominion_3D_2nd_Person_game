# Civilian driver character attribution

The game character is **Remy**, an Adobe Mixamo human model, customized and animated in Blender for this game. The torso, skin, hair, eyes, clothing and footwear use the source's texture-mapped mesh and normal maps. The Blender customization adds a charcoal shirt, olive cargo shorts, matte PBR surface treatment, in-place retargeted movement, and authored driving/vehicle entry/exit poses.

- Original character: [Adobe Mixamo](https://www.mixamo.com/), Remy.
- Downloaded FBX source mirror: [GbotHQ/mixamo-characters — Remy.fbx](https://huggingface.co/datasets/GbotHQ/mixamo-characters/blob/main/Remy.fbx).
- Idle, Walk and Run motion reference: [Three.js Soldier.glb](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb), originally Adobe Mixamo. The source character itself is not included in the game.
- Adobe's [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) permits royalty-free character and animation use in personal, commercial and non-profit video-game projects. This file is part of the game; no separate resale/redistribution license for standalone source assets is claimed.
- The source reference's Three.js MIT notice is retained in `THREEJS-LICENSE.txt`.

The original source files and editable packed Blender scene are retained locally under `artifacts/blender/person*`. Rebuild with Blender 5.2 using `scripts/build-blender-person.py`. The shipped compact model is `person.glb`; technical dimensions, bones and clip durations are listed in `person-manifest.json`.

The playable winter variant, `person-winter.glb`, retains this character's face, skeleton, and six animations. Its fitted insulated parka, knit headwear and scarf, gloves, winter trousers, and boots are authored for this game with `scripts/build-player-winter.py`. Garment textures, quilting, seams, and hardware are generated locally. Its editable scene and preview renders are retained under `artifacts/blender/person-winter*`; the exported asset details are recorded in `person-winter-manifest.json`.
