#!/usr/bin/env python3
"""Register the official BodyParts3D 4.0 teaching atlas to existing CT masks."""

import argparse
import csv
from io import BytesIO
from itertools import product
import json
import os
from pathlib import Path
import tempfile
from zipfile import ZipFile

import numpy as np
from scipy.ndimage import distance_transform_edt, map_coordinates
from scipy.optimize import minimize
from scipy.spatial import ConvexHull, cKDTree
import SimpleITK as sitk
from skimage.measure import marching_cubes
import trimesh


SKULL = {
    "frontal_bone": 52734,
    "parietal_bone_l": 52789, "parietal_bone_r": 52788,
    "temporal_bone_l": 52739, "temporal_bone_r": 52738,
    "occipital_bone": 52735, "sphenoid_bone": 52736,
    "zygomatic_bone_l": 52893, "zygomatic_bone_r": 52892,
    "maxilla_l": 53650, "maxilla_r": 53649,
    "nasal_bone_l": 53648, "nasal_bone_r": 53647,
    "mandible": 52748,
}
BRAIN = {"cerebrum_l": 61819, "cerebrum_r": 67292, "cerebellum": 67944, "brainstem": 79876}
BRAIN_LOBES = {
    "cerebrum_l": {"frontal_lobe_l": 72970, "parietal_lobe_l": 72974, "temporal_lobe_l": 72972},
    "cerebrum_r": {"frontal_lobe_r": 72969, "parietal_lobe_r": 72973, "temporal_lobe_r": 72971},
}
# DBCLS v4.0 OBJ coordinates in millimeters: +X left, +Y posterior, +Z superior.
LPS_TO_HEAD = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])


def clean(mesh):
    mesh.update_faces(mesh.nondegenerate_faces() & mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    return mesh


def load_parts(directory, tree, concepts, subdivisions=None):
    index = {}
    with (directory / f"{tree}_element_parts.txt").open(encoding="utf-8-sig") as entries:
        for row in csv.DictReader(entries, delimiter="\t"):
            index.setdefault(row["concept id"], set()).add(row["element file id"])
    subdivisions = subdivisions or {}
    parts, sources = {}, {}
    used = set()

    def load_geometry(archive, files, name, concept, elements, parent=None):
        if not elements or used.intersection(elements):
            raise ValueError(f"{concept} has missing or shared atlas elements")
        used.update(elements)
        meshes = []
        for element in sorted(elements):
            with BytesIO(archive.read(files[element])) as obj:
                meshes.append(clean(trimesh.load(obj, file_type="obj", force="mesh", skip_materials=True)))
        # Only combine elements of the same FMA part. Child lobes keep their own geometry.
        parts[name] = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
        sources[name] = {"fma": concept, "elements": sorted(elements), "tree": tree}
        if parent:
            sources[name]["parent"] = parent

    with ZipFile(directory / f"{tree}_BP3D_4.0_obj_99.zip") as archive:
        files = {Path(name).stem: name for name in archive.namelist() if name.endswith(".obj")}
        for name, number in concepts.items():
            concept = f"FMA{number}"
            remaining = index[concept].copy()
            children = [(child, f"FMA{fma}") for child, fma in subdivisions.get(name, {}).items()]
            for child, child_concept in children:
                if not index[child_concept] <= remaining:
                    raise ValueError(f"{child} does not partition {concept}")
                remaining -= index[child_concept]
            load_geometry(archive, files, name, concept, remaining)
            for child, child_concept in children:
                load_geometry(archive, files, child, child_concept, index[child_concept], parent=name)
    return parts, sources


def load_grid(path):
    meta = json.loads(path.read_text())
    if meta["orientation"] != "LPS" or meta["spacingUnit"] != "mm":
        raise ValueError("meta.json must describe an LPS grid in millimeters")
    grid = sitk.Image(meta["dimensions"], sitk.sitkUInt8)
    grid.SetSpacing(meta["spacing"])
    grid.SetOrigin(meta["originLpsMm"])
    return grid


def mask_on_grid(path, grid):
    image = sitk.ReadImage(str(path))
    sampled = sitk.Resample(image > 0, grid, sitk.Transform(), sitk.sitkNearestNeighbor, 0, sitk.sitkUInt8)
    mask = sitk.GetArrayFromImage(sampled).astype(bool)
    if not mask.any() or any(np.take(mask, [0, -1], axis=axis).any() for axis in range(3)):
        raise ValueError(f"Empty or cropped mask in the meta.json grid: {path.name}")
    return mask


def mask_surface(mask, grid):
    voxels, faces, _, _ = marching_cubes(mask.astype(np.uint8), 0.5, allow_degenerate=False)
    vertices = voxels[:, ::-1] * grid.GetSpacing() + grid.GetOrigin()
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def bounds_of(meshes):
    bounds = np.stack([mesh.bounds for mesh in meshes])
    return np.array([bounds[:, 0].min(axis=0), bounds[:, 1].max(axis=0)])


def sample_skin(mesh, count, seed):
    return trimesh.sample.sample_surface(mesh, count, seed=seed)[0]


def exterior_samples(mesh, seed):
    """Approximate the visible exterior using orthographic depth from 14 directions."""
    points = sample_skin(mesh, 180000, seed)
    centered = points - mesh.bounds.mean(axis=0)
    visible = np.zeros(len(points), dtype=bool)
    directions = [*np.eye(3), *-np.eye(3), *product((-1, 1), repeat=3)]
    for direction in directions:
        view = np.asarray(direction, dtype=float)
        view /= np.linalg.norm(view)
        side = np.cross(view, [0, 0, 1] if abs(view[2]) < 0.99 else [0, 1, 0])
        side /= np.linalg.norm(side)
        up = np.cross(view, side)
        depth = centered @ view
        pixels = np.floor((centered @ np.array([side, up]).T) / 2.0).astype(int)
        pixels -= pixels.min(axis=0)
        row_width = pixels[:, 0].max() + 1
        indices = pixels[:, 0] + row_width * pixels[:, 1]
        nearest = np.full(indices.max() + 1, -np.inf)
        np.maximum.at(nearest, indices, depth)
        visible |= nearest[indices] - depth <= 1.7
    return points[visible]


def trimmed_mean(distances, quantile=0.90):
    return float(distances[distances <= np.quantile(distances, quantile)].mean())


def register(skull, target):
    source = trimesh.util.concatenate(list(skull.values()))
    if not (skull["parietal_bone_l"].centroid[0] > skull["parietal_bone_r"].centroid[0]
            and skull["frontal_bone"].centroid[1] < skull["occipital_bone"].centroid[1]
            and skull["frontal_bone"].centroid[2] > skull["mandible"].centroid[2]):
        raise ValueError("BodyParts3D does not match the expected LPS axis directions")
    # Atlas and target are both LPS. Keep a positive uniform scale and align bounding box centers.
    initial = np.eye(4)
    initial_scale = np.median(target.extents / source.extents)
    initial[:3, :3] *= initial_scale
    initial[:3, 3] = target.bounds.mean(axis=0) - source.bounds.mean(axis=0) * initial_scale
    a = exterior_samples(source, 1701)[:28000]
    b = exterior_samples(target, 1702)[:80000]
    target_tree = cKDTree(b)

    def score(matrix):
        moved = trimesh.transform_points(a, matrix)
        forward = target_tree.query(moved)[0]
        reverse = cKDTree(moved).query(b)[0]
        return (trimmed_mean(forward) + trimmed_mean(reverse)) / 2

    candidates = {"initial": initial}
    for use_scale in (False, True):
        matrix, _, _ = trimesh.registration.icp(
            a, b, initial=initial, max_iterations=65, threshold=1e-7,
            reflection=False, scale=use_scale,
        )
        # Similarity can otherwise drift toward the interior of the thick segmented shell.
        if 0.90 <= np.linalg.norm(matrix[:3, 0]) / initial_scale <= 1.10:
            candidates["similarity ICP" if use_scale else "rigid ICP after initial scaling"] = matrix
    method, transform = min(candidates.items(), key=lambda entry: score(entry[1]))
    if method == "initial":
        raise ValueError("ICP failed to improve the initial anatomical alignment")
    return transform, method, source, score(initial), score(transform)


def brain_adjustment(brain, target, grid, brain_mask, skull_mask):
    points = sample_skin(trimesh.util.concatenate(list(brain.values())), 24000, 3410)
    signed = distance_transform_edt(~brain_mask, sampling=grid.GetSpacing()[::-1])
    signed -= distance_transform_edt(brain_mask, sampling=grid.GetSpacing()[::-1])
    voxels = (points - grid.GetOrigin()) / grid.GetSpacing()
    skull_distance = distance_transform_edt(skull_mask, sampling=grid.GetSpacing()[::-1])
    delta = target.bounds.mean(axis=0) - bounds_of(brain.values()).mean(axis=0)
    delta *= min(1.0, 6.0 / max(6.0, np.linalg.norm(delta)))

    def distances_at(shift):
        indices = (voxels + shift / grid.GetSpacing())[:, ::-1].T
        distances = map_coordinates(signed, indices, order=1, mode="constant", cval=100)
        penetration = map_coordinates(skull_distance, indices, order=1, mode="constant")
        return np.maximum(distances, 0), penetration

    def objective(shift):
        outside, penetration = distances_at(shift)
        return float(np.mean(outside ** 2 + penetration ** 2))

    start = min((np.zeros(3), delta), key=objective)
    fit = minimize(
        objective, start, method="SLSQP", constraints=[{"type": "ineq", "fun": lambda shift: 36 - shift @ shift}],
        options={"eps": 0.04, "maxiter": 35, "ftol": 1e-5},
    )
    shift = min((np.zeros(3), start, fit.x), key=objective) if fit.success else start
    return shift, float(distances_at(shift)[0].mean()), points + shift


def cranial_envelope_excess(skull, brain):
    """Max distance beyond the atlas cranial convex envelope, excluding the descending brainstem."""
    cranial_names = ("frontal_bone", "parietal_bone_l", "parietal_bone_r", "temporal_bone_l",
                     "temporal_bone_r", "occipital_bone", "sphenoid_bone")
    vertices = np.concatenate([skull[name].vertices for name in cranial_names])
    hull = ConvexHull(vertices)
    cerebrum_and_cerebellum = np.concatenate([mesh.vertices for name, mesh in brain.items() if name != "brainstem"])
    distances = np.concatenate([
        (batch @ hull.equations[:, :3].T + hull.equations[:, 3]).max(axis=1)
        for batch in np.array_split(cerebrum_and_cerebellum, 96)
    ])
    return float(max(0, distances.max()))


def export_atlas(parts, sources, path, face_range, budget, to_head):
    raw_counts = np.array([len(mesh.faces) for mesh in parts.values()])
    targets = np.floor(raw_counts * min(1, budget / raw_counts.sum())).astype(int)
    scene = trimesh.Scene()
    report = {}
    for (name, mesh), count, limit in zip(parts.items(), raw_counts, targets):
        if limit < count:
            mesh = clean(mesh.simplify_quadric_decimation(face_count=int(limit)))
        trimesh.repair.fix_winding(mesh)
        mesh.apply_transform(to_head)
        if not mesh.is_winding_consistent or not np.allclose(np.linalg.norm(mesh.vertex_normals, axis=1), 1, atol=1e-4):
            raise ValueError(f"Invalid smooth vertex normals or winding: {name}")
        mesh.metadata.update(sources[name])
        scene.add_geometry(mesh, node_name=name, geom_name=name, parent_node_name=sources[name].get("parent"))
        report[name] = {**sources[name], "inputFaces": int(count), "faces": len(mesh.faces)}
    faces = sum(part["faces"] for part in report.values())
    if not face_range[0] <= faces <= face_range[1]:
        raise ValueError(f"{path.name} has {faces:,} faces, outside {face_range}")
    scene.metadata.update({
        "source": "BodyParts3D 4.0, DBCLS",
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "registration": "TotalSegmentator CT masks, skull-guided ICP",
    })
    path.write_bytes(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
    return report


def run(bp3d, seg_dir, meta, out_dir):
    skull, skull_sources = load_parts(bp3d, "isa", SKULL)
    brain, brain_sources = load_parts(bp3d, "partof", BRAIN, BRAIN_LOBES)
    grid = load_grid(meta)
    skull_mask = mask_on_grid(seg_dir / "skull.nii.gz", grid)
    skull_mask |= mask_on_grid(seg_dir / "mandible.nii.gz", grid)
    brain_mask = mask_on_grid(seg_dir / "brain.nii.gz", grid)
    target = mask_surface(skull_mask, grid)
    brain_target = mask_surface(brain_mask, grid)
    transform, method, source, initial_score, final_score = register(skull, target)
    for mesh in (*skull.values(), *brain.values()):
        mesh.apply_transform(transform)

    shift, outside_brain, brain_points = brain_adjustment(brain, brain_target, grid, brain_mask, skull_mask)
    for mesh in brain.values():
        mesh.apply_translation(shift)
    brain_voxels = (brain_points - grid.GetOrigin()) / grid.GetSpacing()
    brain_on_bone = map_coordinates(skull_mask, brain_voxels[:, ::-1].T, order=0, mode="constant")

    # Independent exterior-surface samples in CT LPS mm, before simplification.
    a = trimesh.transform_points(exterior_samples(source, 7123), transform)
    b = exterior_samples(target, 7124)
    forward = cKDTree(b).query(a)[0]
    reverse = cKDTree(a).query(b)[0]
    report = {
        "method": method, "atlasToCtLps": transform.tolist(),
        "initialTrimmedMeanMm": initial_score, "registeredTrimmedMeanMm": final_score,
        "atlasToCtMeanMm": float(forward.mean()), "ctToAtlasMeanMm": float(reverse.mean()),
        "symmetricMeanMm": float((forward.mean() + reverse.mean()) / 2),
        "brainCenterAdjustmentLpsMm": shift.tolist(),
        "brainMeanOutsideCtBrainMaskMm": outside_brain,
        "brainSurfaceSamplesInsideCtBoneFraction": float(brain_on_bone.mean()),
        "brainOutsideAtlasCranialConvexEnvelopeMaxMm": cranial_envelope_excess(skull, brain),
    }
    half_extent = (np.array(grid.GetSize()) - 1) * np.array(grid.GetSpacing()) / 2
    center = np.array(grid.GetOrigin()) + half_extent
    to_head = np.eye(4)
    to_head[:3, :3] = LPS_TO_HEAD / half_extent[2]
    to_head[:3, 3] = -to_head[:3, :3] @ center

    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".bp3d-", dir=out_dir) as temporary:
        staging = Path(temporary)
        report["skull"] = export_atlas(skull, skull_sources, staging / "skull.glb", (40000, 55000), 52500, to_head)
        report["brain"] = export_atlas(brain, brain_sources, staging / "brain.glb", (30000, 40000), 37000, to_head)
        for filename in ("skull.glb", "brain.glb"):
            os.replace(staging / filename, out_dir / filename)
    for name in ("skull", "brain"):
        parts = report[name]
        roots = sum("parent" not in part for part in parts.values())
        print(f"{name}.glb: {roots} root parts, {len(parts)} mesh nodes, {sum(part['faces'] for part in parts.values()):,} faces")
    print(f"{method}: symmetric mean sampled-surface distance {report['symmetricMeanMm']:.3f} mm")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("bp3d", "seg-dir", "meta", "out-dir", "report"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.bp3d, args.seg_dir, args.meta, args.out_dir)
    args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
