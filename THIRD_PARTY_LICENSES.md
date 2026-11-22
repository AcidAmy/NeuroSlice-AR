# NeuroSlice AR 第三方许可

| 组件 | 许可与来源 |
| --- | --- |
| MediaPipe Tasks Vision 0.10.14 | JavaScript 和 WASM 运行时采用 Apache-2.0。[MediaPipe 许可](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/LICENSE) |
| MediaPipe 人脸和手部追踪模型 float16/1 | 模型许可及版本信息见各任务的官方模型卡。[人脸模型与模型卡](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker#models) · [手部模型与模型卡](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker#models) |
| Three.js r160 | MIT，Copyright © 2010–2023 three.js authors。[版本许可全文](https://github.com/mrdoob/three.js/blob/r160/LICENSE) |
| TotalSegmentator 2.18.0 | 离线使用 `total` 任务生成颅骨和大脑掩膜，使用 `craniofacial_structures` 任务生成下颌骨掩膜。项目代码采用 Apache-2.0，权重按对应任务条款使用。[代码许可](https://github.com/wasserth/TotalSegmentator/blob/master/LICENSE) · [官方任务说明](https://github.com/wasserth/TotalSegmentator#subtasks) · [Wasserthal 等](https://doi.org/10.1148/ryai.230024) |
| BodyParts3D 4.0 | BodyParts3D, © The Database Center for Life Science (DBCLS), licensed under CC BY 4.0。颅骨取自 99% 精简 IS-A OBJ 归档，大脑取自 99% 精简 PART-OF OBJ 归档。[官方数据与 FMA 索引](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html) · [官方署名要求](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| IBM Plex Sans、IBM Plex Mono | 本地 WOFF2，SIL Open Font License 1.1。[IBM 项目](https://github.com/IBM/plex) · [随附许可](public/fonts/OFL.txt) |

## Step 3 离线工具与教学来源

| 组件或来源 | 许可与使用方式 |
| --- | --- |
| SimpleITK | Apache-2.0。用于刚体与仿射配准、LPS 重采样。[许可](https://github.com/SimpleITK/SimpleITK/blob/master/LICENSE) |
| NumPy、SciPy | BSD-3-Clause。用于离线体素计算和网格处理。[NumPy 许可](https://github.com/numpy/numpy/blob/main/LICENSE.txt) · [SciPy 许可](https://github.com/scipy/scipy/blob/main/LICENSE.txt) |
| scikit-image | BSD-3-Clause。用于离线等值面提取。[许可](https://github.com/scikit-image/scikit-image/blob/main/LICENSE.txt) |
| trimesh | MIT。用于离线网格处理和 GLB 导出。[许可](https://github.com/mikedh/trimesh/blob/main/LICENSE.md) |
| fast-simplification | MIT。用于 trimesh 离线二次误差简化。[许可](https://github.com/pyvista/fast-simplification/blob/main/LICENSE) |
| 解剖标注参考 | 中文描述与图解点位随项目编写。[NSW Agency for Clinical Innovation 教学图解](https://aci.health.nsw.gov.au/__data/assets/pdf_file/0003/273702/ACI-ECI-How-read-head-CT.pdf) |

## 真实影像资产

| 数据 | 版本、许可与署名 |
| --- | --- |
| CT · Head-Neck Cetuximab (RTOG 0522) | 病例 `0522c0017`，采用 Google DeepMind 与 UCLH 发布的 NRRD `nrrds/test/oncologist/0522c0017/CT_IMAGE.nrrd`，提交 `2edb50947e50ef26e60b72dec89d36d71efe5549`。该公开版本采用 CC BY 4.0，原 TCIA DICOM 由 NIH 控制访问。公开 NRRD 未附 DICOM 序列 UID。[单例源文件](https://raw.githubusercontent.com/google-deepmind/tcia-ct-scan-dataset/2edb50947e50ef26e60b72dec89d36d71efe5549/nrrds/test/oncologist/0522c0017/CT_IMAGE.nrrd) · [发布版许可](https://github.com/google-deepmind/tcia-ct-scan-dataset/blob/2edb50947e50ef26e60b72dec89d36d71efe5549/LICENSE) · [Nikolov 等](https://arxiv.org/abs/1809.04430) · [Bosch 等，TCIA 原始合集](https://doi.org/10.7937/K9/TCIA.2015.7AKGJUPZ) |
| T1 MRI · 3D Slicer MRHead | 样本 `MRHead`，发布文件 `MR-head.nrrd`，SHA-256 为 `cc211f0dfd9a05ca3841ce1141b292898b2dd2d3f08286affadf823a7e58df93`。按 3D Slicer Sample Data 的署名说明，由影像中的本人捐赠并授权无使用限制。[样本下载](https://github.com/Slicer/SlicerTestingData/releases/download/SHA256/cc211f0dfd9a05ca3841ce1141b292898b2dd2d3f08286affadf823a7e58df93) · [Slicer 捐赠说明](https://github.com/Slicer/Slicer/blob/main/Modules/Scripted/SampleData/SampleData.py) |

CT 来自已去标识化的头颈放疗队列，保留颅面扫描覆盖。两份源影像来自不同受试者。本项目去除转换时的非几何元数据、裁剪头部视野并进行跨个体仿射配准，输出 LPS 各向同性 CT HU 体数据及 T1 相对灰度。跨个体影像用于教学对照，个体脑室形态与位置存在差异。

BodyParts3D 衍生文件为 `skull.glb` 和 `brain.glb`。网格按 FMA 分骨和分区、抽稀、计算顶点法线，并基于 TotalSegmentator 患者分割靶标完成 ICP 空间配准，用于解剖结构教学可视化。`meta.json` 中的网格统计记录了原始 CT 分割导出，图谱的节点与面数以 GLB 为准。
