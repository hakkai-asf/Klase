"""
Merge a Mixamo character FBX (With Skin, T-pose) with one or more
animation FBXs (Without Skin) and export a Three.js-ready .glb.

From the Klase repo root (assets already in the tree):

  blender --background --python tools/mixamo_to_glb.py -- `
    --character "assets/characters/X Bot.fbx" `
    --out "client/public/models/xbot.glb" `
    --clip Walk:"assets/animations/walking/Walking.fbx"

Optional extra Mixamo clips in assets/animations/walking/:
    --clip WalkStart:"assets/animations/walking/Start Walking.fbx" `
    --clip WalkStop:"assets/animations/walking/Stop Walking.fbx" `
    --clip WalkTurn180:"assets/animations/walking/Walking Turn 180.fbx"

Y Bot:
    --character "assets/characters/Y Bot.fbx" `
    --out "client/public/models/ybot.glb"

Add more clips the same way:

    --clip Idle:"C:\\path\\Idle.fbx" `
    --clip Run:"C:\\path\\Running.fbx"

Same Mixamo skeleton (X Bot / Y Bot + that bot's anims) copies the action
onto the skinned armature. No IK retargeter required.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import List, Tuple

import bpy


def parse_args() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser(description="Mixamo FBX character + anims -> GLB")
    p.add_argument("--character", required=True, help="Base FBX with skin, T-pose")
    p.add_argument("--out", required=True, help="Output .glb path")
    p.add_argument(
        "--clip",
        action="append",
        default=[],
        metavar="Name:path.fbx",
        help='Animation clip, e.g. Walk:"C:\\anims\\Walking.fbx" (repeatable)',
    )
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--no-apply-scale", action="store_true", help="Skip apply scale on armature+meshes")
    return p.parse_args(raw)


def parse_clips(items: List[str]) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    for item in items:
        if ":" not in item:
            raise SystemExit(f'--clip must be Name:path.fbx, got: {item}')
        # Allow Windows drive letters: Walk:C:\foo.fbx
        name, path = item.split(":", 1)
        if len(path) >= 2 and path[0].isalpha() and path[1] != ":":
            # "Walk:C" split wrong when using Walk:C:\... — first split is OK:
            # "Walk:C:\x.fbx".split(":", 1) => ("Walk", "C:\\x.fbx")
            pass
        name, path = name.strip(), path.strip().strip('"')
        if not name or not path:
            raise SystemExit(f"Bad --clip {item}")
        if not os.path.isfile(path):
            raise SystemExit(f"Animation FBX not found: {path}")
        out.append((name, os.path.abspath(path)))
    return out


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(path: str) -> None:
    bpy.ops.import_scene.fbx(
        filepath=path,
        automatic_bone_orientation=True,
        ignore_leaf_bones=False,
        force_connect_children=False,
        use_anim=True,
        anim_offset=0.0,
        global_scale=1.0,
    )


def snapshot_objects():
    return set(bpy.data.objects)


def armature_of(objects) -> bpy.types.Object:
    arms = [o for o in objects if o.type == "ARMATURE"]
    if not arms:
        raise RuntimeError("No armature in imported FBX")
    return arms[0]


def action_of(arm: bpy.types.Object) -> bpy.types.Action:
    ad = arm.animation_data
    if ad and ad.action:
        return ad.action
    if ad:
        for track in ad.nla_tracks:
            for strip in track.strips:
                if strip.action:
                    return strip.action
    # Last imported action datablock
    if bpy.data.actions:
        return bpy.data.actions[-1]
    raise RuntimeError(f"No action on armature {arm.name}")


def push_nla(arm: bpy.types.Object, action: bpy.types.Action, clip_name: str) -> None:
    if arm.animation_data is None:
        arm.animation_data_create()
    action.name = clip_name
    track = arm.animation_data.nla_tracks.new()
    track.name = clip_name
    start = int(action.frame_range[0])
    strip = track.strips.new(clip_name, start, action)
    strip.name = clip_name
    strip.action = action


def delete_objects(objects) -> None:
    for obj in list(objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def apply_scale(arm: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for child in arm.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def select_rig(arm: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    meshes = 0
    for child in arm.children_recursive:
        if child.type == "MESH":
            child.select_set(True)
            meshes += 1
        elif child.type == "ARMATURE":
            child.select_set(True)
    bpy.context.view_layer.objects.active = arm
    print(f"Selected armature={arm.name!r} mesh_children={meshes}")


def export_glb(path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_skins=True,
        export_apply=False,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
    )
    if bpy.app.version >= (3, 6, 0):
        kwargs["export_animation_mode"] = "NLA_TRACKS"
        kwargs["export_anim_single_armature"] = True
    else:
        kwargs["export_nla_strips"] = True
        kwargs["export_force_sampling"] = True
    bpy.ops.export_scene.gltf(**kwargs)


def report(arm: bpy.types.Object, out_path: str) -> None:
    meshes = [o for o in arm.children_recursive if o.type == "MESH"]
    tracks = []
    if arm.animation_data:
        tracks = [t.name for t in arm.animation_data.nla_tracks]
    size = os.path.getsize(out_path) if os.path.isfile(out_path) else 0
    print("--- export ---")
    print(f"armature: {arm.name}")
    print(f"meshes:   {[m.name for m in meshes]}")
    print(f"clips:    {tracks}")
    print(f"glb:      {out_path}")
    print(f"bytes:    {size}")


def main() -> None:
    args = parse_args()
    character = os.path.abspath(args.character)
    out_path = os.path.abspath(args.out)
    clips = parse_clips(args.clip)
    if not os.path.isfile(character):
        raise SystemExit(f"Character FBX not found: {character}")
    if not clips:
        raise SystemExit("Pass at least one --clip Name:path.fbx (e.g. Walk:Walking.fbx)")

    bpy.context.scene.render.fps = int(args.fps)
    reset_scene()

    import_fbx(character)
    char_arm = armature_of(bpy.context.scene.objects)
    keep = snapshot_objects()

    # Drop T-pose rest action from the skinned file so only named clips export
    if char_arm.animation_data and char_arm.animation_data.action:
        rest = char_arm.animation_data.action
        char_arm.animation_data.action = None
        if rest.users == 0:
            bpy.data.actions.remove(rest)

    for clip_name, clip_path in clips:
        import_fbx(clip_path)
        extras = [o for o in bpy.data.objects if o not in keep]
        anim_arm = armature_of(extras)
        action = action_of(anim_arm)
        action.use_fake_user = True
        push_nla(char_arm, action, clip_name)
        delete_objects(extras)
        keep = snapshot_objects()
        print(f"Linked clip {clip_name!r} from {clip_path}")

    if char_arm.animation_data:
        char_arm.animation_data.action = None

    if not args.no_apply_scale:
        apply_scale(char_arm)

    select_rig(char_arm)
    export_glb(out_path)
    report(char_arm, out_path)


if __name__ == "__main__":
    main()
