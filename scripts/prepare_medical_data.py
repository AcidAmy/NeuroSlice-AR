#!/usr/bin/env python3
"""将已授权的头部 CT、MRI 和 CT 空间分割掩膜转换为 NeuroSlice AR 资产。"""

import argparse
from itertools import product
import json
import os
from pathlib import Path
import tempfile

import numpy as np
import SimpleITK as sitk
from skimage.measure import marching_cubes
import trimesh


GRID_SIZE = (224, 224, 192)  # 列、行、轴位层
FACE_LIMIT = 20_000
HEAD_Z_MARGIN_MM = 13.5
DEFAULT_CT_WINDOW = {"width": 80, "level": 40}


def read_image(path, pixel_type):
    """读取三维影像并统一到 LPS 方向表达，保留其物理坐标。"""
    image = sitk.ReadImage(str(path), pixel_type)
    if image.GetDimension() != 3 or min(image.GetSize()) < 2:
        raise ValueError(f"需要三维体数据：{path.name}")
    voxels = sitk.GetArrayViewFromImage(image)
    if not np.isfinite(voxels).all():
        raise ValueError(f"体数据包含非有限值：{path.name}")
    return sitk.DICOMOrient(image, "LPS")


def mask_bounds(mask):
    """取掩膜阳性体素的物理包围盒，对斜采集轴同样有效。"""
    foreground = sitk.Cast(mask > 0, sitk.sitkUInt8)
    stats = sitk.LabelShapeStatisticsImageFilter()
    stats.Execute(foreground)
    if not stats.HasLabel(1):
        raise ValueError("分割掩膜没有阳性体素。")
    box = stats.GetBoundingBox(1)
    ends = [(box[i] - 0.5, box[i] + box[i + 3] - 0.5) for i in range(3)]
    corners = np.array([mask.TransformContinuousIndexToPhysicalPoint(point) for point in product(*ends)])
    return foreground, (corners.min(axis=0), corners.max(axis=0))


def reference_grid(mask_extents, size, skull_extents=()):
    """以颅脑区域为中心裁切，输出无倾斜的 LPS 轴位网格及真实体素间距。"""
    lower = np.min([bounds[0] for bounds in mask_extents], axis=0)
    upper = np.max([bounds[1] for bounds in mask_extents], axis=0)
    padding = np.maximum(6.0, (upper - lower) * 0.10) / 2
    lower -= padding
    upper += padding
    if skull_extents:
        lower[2] = min(bounds[0][2] for bounds in skull_extents) - HEAD_Z_MARGIN_MM
        upper[2] = max(bounds[1][2] for bounds in skull_extents) + HEAD_Z_MARGIN_MM
    center = (lower + upper) / 2
    lengths = upper - lower
    intervals = np.asarray(size, dtype=int) - 1
    voxel_mm = float(np.max(lengths / intervals))
    if skull_extents:
        intervals[2] = int(np.ceil(lengths[2] / voxel_mm - 1e-9))
    grid = sitk.Image([int(axis + 1) for axis in intervals], sitk.sitkFloat32)
    grid.SetOrigin(tuple(center - voxel_mm * intervals / 2))
    grid.SetSpacing((voxel_mm,) * 3)
    return grid


def register_mri(ct, mri, relation="same-subject", brain_mask=None):
    """用多尺度 Mattes 互信息估计固定 CT 到移动 MRI 的刚体采样变换。"""
    fixed = sitk.Clamp(ct, sitk.sitkFloat32, -1000, 2200)
    transform = sitk.Euler3DTransform(sitk.CenteredTransformInitializer(
        fixed, mri, sitk.Euler3DTransform(), sitk.CenteredTransformInitializerFilter.GEOMETRY,
    ))
    registration = sitk.ImageRegistrationMethod()
    registration.SetMetricAsMattesMutualInformation(numberOfHistogramBins=50)
    registration.SetMetricSamplingStrategy(registration.RANDOM)
    registration.SetMetricSamplingPercentage(0.25, 2026)
    registration.SetInterpolator(sitk.sitkLinear)
    registration.SetOptimizerAsRegularStepGradientDescent(
        learningRate=1.5, minStep=0.0005, numberOfIterations=180, gradientMagnitudeTolerance=1e-7,
    )
    registration.SetOptimizerScalesFromPhysicalShift()
    registration.SetShrinkFactorsPerLevel([4, 2, 1])
    registration.SetSmoothingSigmasPerLevel([2, 1, 0])
    registration.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    if brain_mask is not None:
        radius = [max(1, round(9 / spacing)) for spacing in brain_mask.GetSpacing()]
        registration.SetMetricFixedMask(sitk.BinaryDilate(brain_mask, radius))
    registration.SetInitialTransform(transform, inPlace=True)
    registration.Execute(fixed, mri)
    method = "Euler3D / Mattes mutual information"
    if relation == "cross-subject":
        affine = sitk.AffineTransform(3)
        affine.SetCenter(transform.GetCenter())
        affine.SetMatrix(transform.GetMatrix())
        affine.SetTranslation(transform.GetTranslation())
        registration.SetOptimizerAsRegularStepGradientDescent(
            learningRate=0.75, minStep=0.0005, numberOfIterations=240, gradientMagnitudeTolerance=1e-7,
        )
        registration.SetOptimizerScalesFromPhysicalShift()
        registration.SetInitialTransform(affine, inPlace=True)
        registration.Execute(fixed, mri)
        singular_values = np.linalg.svd(np.asarray(affine.GetMatrix()).reshape(3, 3), compute_uv=False)
        if singular_values.min() < 0.65 or singular_values.max() > 1.45:
            raise ValueError("跨个体配准的缩放或剪切超出合理范围。")
        transform = affine
        method = "Euler3D initialization + affine / Mattes mutual information"
    if not np.isfinite(registration.GetMetricValue()):
        raise ValueError("MRI 配准未取得有效互信息值。")
    return transform, method, registration.GetMetricValue(), registration.GetOptimizerStopConditionDescription()


def resample(image, grid, transform, interpolation, background, pixel_type):
    result = sitk.Resample(image, grid, transform, interpolation, background, pixel_type)
    return sitk.GetArrayFromImage(result)


def convert_mri_to_uint8(data, covered):
    """用有效 MRI 的第 1 至第 99 百分位映射相对信号，网格外保持黑色。"""
    foreground = covered & (data != 0)
    signal = data[foreground]
    if not signal.size:
        raise ValueError("配准后的 MRI 在输出网格内没有有效信号。")
    lower, upper = np.percentile(signal, (1, 99))
    if upper <= lower:
        lower, upper = float(signal.min()), float(signal.max())
    if upper <= lower:
        raise ValueError("MRI 缺少可分辨信号范围。")
    output = np.zeros(data.shape, dtype=np.uint8)
    output[foreground] = np.rint(np.clip((signal - lower) / (upper - lower), 0, 1) * 255)
    return output


def head_coordinates(vertices_zyx, grid):
    """将体素 Z、Y、X 转为归一化的左、上、前坐标。"""
    size = np.asarray(grid.GetSize())
    spacing = np.asarray(grid.GetSpacing())
    half_height = (size[2] - 1) * spacing[2] / 2
    centered = (vertices_zyx[:, ::-1] - (size - 1) / 2) * spacing / half_height
    return centered[:, [0, 2, 1]] * [1, 1, -1]


def mesh_axes_verified(grid):
    if not np.allclose(grid.GetDirection(), np.eye(3).ravel()):
        return False
    index_axes_zyx = np.vstack((np.zeros(3), np.eye(3)[:, ::-1]))
    head = head_coordinates(index_axes_zyx, grid)
    axes = head[1:] - head[0]
    actual = axes / np.linalg.norm(axes, axis=1, keepdims=True)
    return np.allclose(actual, [[1, 0, 0], [0, 0, -1], [0, 1, 0]])


def export_mesh(mask, grid, path):
    """在完整表面上消除体素台阶，再简化并显式导出平滑顶点法线。"""
    if not np.any(mask):
        raise ValueError(f"重采样后掩膜为空：{path.stem}")
    if not mesh_axes_verified(grid):
        raise ValueError(f"体素网格与头模坐标轴不一致：{path.stem}")
    vertices, faces, _, _ = marching_cubes(
        np.pad(mask.astype(np.uint8), 1), level=0.5, gradient_direction="descent", allow_degenerate=False,
    )
    # ZYX 到头坐标的反射抵消 marching_cubes 的左手绕序，保留内腔与外表面的相反朝向。
    mesh = trimesh.Trimesh(vertices=head_coordinates(vertices - 1, grid), faces=faces, process=True)
    original_faces = len(mesh.faces)
    laplacian = trimesh.smoothing.laplacian_calculation(mesh, equal_weight=False)
    trimesh.smoothing.filter_taubin(mesh, lamb=0.45, nu=0.50, iterations=12, laplacian_operator=laplacian)
    if len(mesh.faces) > FACE_LIMIT:
        mesh = mesh.simplify_quadric_decimation(face_count=FACE_LIMIT)
    # 边折叠可能留下零面积面或背靠背的重复三角形，这些面会令平滑法线相互抵消。
    _, groups, counts = np.unique(np.sort(mesh.faces, axis=1), axis=0, return_inverse=True, return_counts=True)
    mesh.update_faces(mesh.nondegenerate_faces() & (counts[groups.reshape(-1)] == 1))
    mesh.remove_unreferenced_vertices()
    if not 0 < len(mesh.faces) <= FACE_LIMIT:
        raise ValueError(f"网格简化后面数无效：{path.stem}，{len(mesh.faces)} 面。")
    if not mesh.is_winding_consistent or not np.isfinite(mesh.volume) or mesh.volume <= 0:
        raise ValueError(f"网格绕序或外表面朝向无效：{path.stem}")
    bounds = mesh.bounds
    extents = bounds[1] - bounds[0]
    if not np.isfinite(bounds).all() or not np.all(extents > 0):
        raise ValueError(f"网格包围盒无效：{path.stem}")
    # 读取简化后的顶点法线，glTF 显式写 NORMAL 属性。
    normals = mesh.vertex_normals
    if not np.isfinite(normals).all() or not np.allclose(np.linalg.norm(normals, axis=1), 1, atol=1e-4):
        raise ValueError(f"网格顶点法线无效：{path.stem}")
    mesh.export(path, file_type="glb", include_normals=True)
    half_height = (grid.GetSize()[2] - 1) * grid.GetSpacing()[2] / 2
    return {
        "inputFaces": original_faces,
        "faceCount": len(mesh.faces),
        "boundsHead": bounds.tolist(),
        "sizeMm": (extents * half_height).tolist(),
        "orientation": "X=Left, Y=Superior, Z=Anterior",
        "vertexNormals": True,
    }


def image_bounds(image):
    """没有分割时，用 CT 的物理视野建立各向同性网格。"""
    edges = [(-0.5, edge - 0.5) for edge in image.GetSize()]
    corners = np.array([image.TransformContinuousIndexToPhysicalPoint(point) for point in product(*edges)])
    return corners.min(axis=0), corners.max(axis=0)


def read_masks(seg_dir):
    if seg_dir is None:
        return {}, {}
    if not seg_dir.is_dir():
        raise ValueError("分割目录不存在。")
    nifti_suffixes = (".nii", ".nii.gz")
    groups = {}
    extents = {}
    for label in ("skull", "brain"):
        paths = [seg_dir / f"{label}.nii.gz", seg_dir / f"{label}.nii"]
        selected = next((path for path in paths if path.is_file()), None)
        if selected is None:
            continue
        inputs = [selected]
        if label == "skull":
            mandible = [seg_dir / f"mandible{suffix}" for suffix in nifti_suffixes]
            jaw = next((path for path in mandible if path.is_file()), None)
            if jaw is not None:
                inputs.append(jaw)
            for path in sorted(seg_dir.iterdir()):
                if path.is_file() and path.name.lower().startswith(("teeth", "tooth")) and path.name.endswith(nifti_suffixes):
                    inputs.append(path)
                elif path.is_dir() and path.name.lower() == "teeth":
                    inputs.extend(file for file in sorted(path.iterdir()) if file.is_file() and file.name.endswith(nifti_suffixes))
        groups[label] = []
        extents[label] = []
        for path in dict.fromkeys(inputs):
            image, bounds = mask_bounds(read_image(path, sitk.sitkFloat32))
            groups[label].append((image, path.name))
            extents[label].append(bounds)
    if not groups:
        raise ValueError("分割目录未找到 skull.nii.gz 或 brain.nii.gz。")
    return groups, extents


def prepare_data(ct_path, mri_path, seg_dir, out_dir, size=GRID_SIZE, *,
                 mri_relation="same-subject", mri_sequence=None):
    ct = read_image(ct_path, sitk.sitkFloat32)
    masks, extents = read_masks(seg_dir)
    bounds = [extent for group in extents.values() for extent in group]
    grid = reference_grid(bounds or [image_bounds(ct)], size, extents.get("skull", ()))
    size = grid.GetSize()
    identity = sitk.Transform(3, sitk.sitkIdentity)
    ct_data = resample(ct, grid, identity, sitk.sitkLinear, -1024, sitk.sitkFloat32)
    if not np.any(ct_data > -1024):
        raise ValueError("输出网格与 CT 没有有效交集，请核对掩膜的 CT 物理坐标。")
    ct_hu = np.rint(ct_data).clip(-32768, 32767).astype("<i2")
    mri_gray = None
    metadata = {
        "version": 1,
        "dimensions": list(size),
        "spacing": list(grid.GetSpacing()),
        "spacingUnit": "mm",
        "originLpsMm": list(grid.GetOrigin()),
        "orientation": "LPS",
        "modalities": ["CT"],
        "ctWindow": DEFAULT_CT_WINDOW,
        "ctHuRange": [int(ct_hu.min()), int(ct_hu.max())],
        "mriSequence": None,
    }

    if mri_path is not None:
        mri = read_image(mri_path, sitk.sitkFloat32)
        fixed = sitk.GetImageFromArray(ct_data)
        fixed.CopyInformation(grid)
        brain_mask = masks["brain"][0][0] if mri_relation == "cross-subject" and "brain" in masks else None
        transform, method, metric, stop = register_mri(fixed, mri, mri_relation, brain_mask)
        mri_data = resample(mri, grid, transform, sitk.sitkLinear, 0, sitk.sitkFloat32)
        coverage = sitk.Image(mri.GetSize(), sitk.sitkUInt8) + 1
        coverage.CopyInformation(mri)
        covered = resample(coverage, grid, transform, sitk.sitkNearestNeighbor, 0, sitk.sitkUInt8) > 0
        mri_gray = convert_mri_to_uint8(mri_data, covered)
        metadata["modalities"].append("MRI")
        metadata["mriSequence"] = mri_sequence
        metadata["mriRelation"] = mri_relation
        metadata["registration"] = {
            "method": method,
            "fixedCtToMovingMriParameters": list(transform.GetParameters()),
            "fixedParameters": list(transform.GetFixedParameters()),
            "metric": metric,
            "stopCondition": stop,
            "mriGridCoverage": float(np.mean(covered)),
        }

    out_dir.mkdir(parents=True, exist_ok=True)
    # 资产完成后最后替换元数据。模态和网格清单避免读取上一次导出留下的文件。
    with tempfile.TemporaryDirectory(prefix=".neuroslice-", dir=out_dir) as work:
        staging = Path(work)
        filenames = ["ct_volume.bin"]
        ct_hu.tofile(staging / filenames[0])
        if mri_gray is not None:
            filenames.append("mri_volume.bin")
            mri_gray.tofile(staging / filenames[-1])
        mesh_checks = {}
        mesh_files = []
        for name, inputs in masks.items():
            labels = np.zeros(tuple(reversed(size)), dtype=np.uint8)
            for mask, _ in inputs:
                labels |= resample(mask, grid, identity, sitk.sitkNearestNeighbor, 0, sitk.sitkUInt8)
            filename = f"{name}.glb"
            mesh_checks[name] = export_mesh(labels, grid, staging / filename)
            mesh_checks[name]["inputs"] = [source for _, source in inputs]
            mesh_files.append(filename)
        metadata["meshFaceCounts"] = {name: report["faceCount"] for name, report in mesh_checks.items()}
        metadata["meshChecks"] = mesh_checks
        metadata["meshFiles"] = mesh_files
        (staging / "meta.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        for name in (*filenames, *mesh_files, "meta.json"):
            os.replace(staging / name, out_dir / name)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ct", type=Path, required=True, help="以 HU 为单位的 CT NIfTI")
    parser.add_argument("--mri", type=Path, help="可选 MRI NIfTI；省略时仅导出 CT")
    parser.add_argument("--mri-relation", choices=("same-subject", "cross-subject"), default="same-subject",
                        help="同人刚体配准或跨个体教学 MRI 仿射配准")
    parser.add_argument("--mri-sequence", choices=("t1", "t2"), help="已核实的 MRI 采集序列")
    parser.add_argument("--seg-dir", type=Path, help="可选 CT 空间分割目录，可含 skull、brain、mandible 和 teeth 掩膜")
    parser.add_argument("--out-dir", type=Path, default=Path("public/assets"), help="输出目录，默认 public/assets")
    args = parser.parse_args()
    try:
        metadata = prepare_data(args.ct, args.mri, args.seg_dir, args.out_dir,
                                mri_relation=args.mri_relation, mri_sequence=args.mri_sequence)
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"预处理失败：{error}\n")
    spacing = " × ".join(f"{axis:.3f}" for axis in metadata["spacing"])
    modalities = " + ".join(metadata["modalities"])
    print(f"已导出 {modalities} {metadata['dimensions']}，各向同性体素 {spacing} mm，目录 {args.out_dir}。")
    print(f"CT HU {metadata['ctHuRange']}")
    if registration := metadata.get("registration"):
        print(f"MRI {metadata['mriRelation']} | {registration['method']} | "
              f"Mattes metric {registration['metric']:.6f} | "
              f"网格覆盖 {registration['mriGridCoverage']:.1%} | {registration['stopCondition']}")
    if "MRI" not in metadata["modalities"]:
        print("单模态模式：MRI 未提供。")
    if not metadata["meshFiles"]:
        print("未提供分割掩膜；浏览器使用占位头模。")
    for name, report in metadata["meshChecks"].items():
        size = " × ".join(f"{axis:.1f}" for axis in report["sizeMm"])
        print(f"{name}.glb | 包围盒 {size} mm | 面数 {report['inputFaces']:,} → {report['faceCount']:,}"
              f" | 朝向通过：{report['orientation']} | 顶点法线通过")


if __name__ == "__main__":
    main()
