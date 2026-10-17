# Winter pedestrian character variations

These characters are Blender edits of the game's existing Adobe Mixamo Remy player model. They retain its textured human anatomy and skeleton, with fitted winter clothing, edited head shapes and hairstyles, and a civilian walk adapted from the player's existing animation.

The original character and motion sources and their notices are recorded in [the player attribution](../person/ATTRIBUTION.md). The original player's model is preserved separately as `../person/person.glb`.

Runtime variants are `parka.glb`, `puffer.glb`, `wool-coat.glb`, and `anorak.glb`. Their dimensions, clips, mesh statistics, source hashes, and editable Blender source paths are listed in `pedestrian-manifest.json`.

Rebuild from the retained player Blender scene with:

```text
blender --background --threads 4 --python scripts/build-blender-pedestrians.py
```

Editable sources and studio previews are retained under `artifacts/blender/pedestrians-*` in the project workspace. These models form part of this game; no separate standalone asset license is claimed.
