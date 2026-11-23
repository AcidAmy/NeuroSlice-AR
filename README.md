# NeuroSlice AR

医学教学 WebAR 工作站。左侧显示跟随头部的颅脑三维透视，右侧以两行六窗显示 CT/MRI 横断、冠状、矢状位，支持同平面的双模态详查。摄像头画面在浏览器内处理。项目随附 CT、T1 MRI、颅骨与大脑模型。未提供真实资产时可浏览程序化模型和 128 × 128 × 120 合成影像。

## 启动

```sh
npm ci
npm run dev
npm test
npm run build
```

桌面开发地址为 `http://localhost:5173/`。手机可运行 `npm run dev:phone`，通过同一 Wi-Fi 打开 Vite 给出的 HTTPS 地址，再按浏览器提示信任本地开发证书。生产构建在 `dist/`，包含 `public/` 下的影像、标注、追踪模型和 WASM 运行时。运行 `npm run preview` 可预览生产构建。

## 测试工作站

- **MPR 与三维切面**。六窗共用一个 LPS 体素定位点。在切片上点击或拖动可同时定位另外两个平面，滚轮改变当前窗的正交层。青色横断、翠绿冠状、琥珀矢状对应三维切面和十字线。默认只显示活动三维切面，可在三视图下启用三面同显。关相机时可拖动头模检查三维切面。
- **手势切层**。横断面使用食指上下移动，矢状面使用左右移动，冠状面使用上下滑动并以掌宽变化补充前后移动。横断模式的映射配置以额部 #10 作为颅顶方向代理点，并取眉间 #168、鼻尖 #1、下颌 #152。四锚点按体数据层号比例做分段线性插值。手入画后冻结参考系，只有连续两帧确认大幅移动且锚点形状一致时才更新。食指 Y 使用 α = 0.25 的 EMA，层号加入迟滞。
- **锁定与兜底**。拇指和食指捏合 200 ms，松开后可再次捏合解锁。鼠标滚轮、滑块和前后层按钮始终可用。手动操作后，将指尖移到当前层附近即可平滑接管，也可以移出手后重新入画。
- **教学模式**。并排对照同层 CT 和 MRI，点击青色标注查看结构与读片笔记。CT 支持脑实质窗 W80/L40、骨窗 W2000/L400、软组织/硬膜下窗 W300/L50 和手动调窗。MRI 支持亮度、对比度和 T1WI/T2WI 模拟预设，读入实际序列时标明「真实序列」。
- **定位自测**。切换模式即开始一轮 15 秒随机题。用手势或滑块定位后捏合确认，或点击「提交定位」。倒计时归零会提交当前层。误差 0–2 层为「精准命中」，3–5 层为「良好」，其余为「需复习」。积分为 `max(0, 100 - 5 × 误差层数)`，当前页面会话保留本轮记录，每轮以开题时的活动平面计分。毫米值取绝对层差乘轴向间距。
- **竞赛测量**。打开「校准」→「性能与防抖监测」，允许相机运行至少 5 秒。固定指尖，取 5 秒窗口并复制 JSON，记录设备、浏览器、相机分辨率、姿势和环境光。帧耗时包括主线程追踪及绘制命令提交，GPU 完成时间另测。移动会计入样本波动，应把静止试验和动作响应试验分别记录。

## 离线数据预处理

需要 Python 3 和已授权的头部 CT NIfTI。MRI NIfTI 和已对齐到 CT 物理坐标的分割掩膜可选。脚本消费 TotalSegmentator 输出；所用分割任务、掩膜名称和权重许可应随数据来源记录。输入 CT 应已转换为 HU。建议先在本地确认 NIfTI 的方向、原点、间距和去标识化状态。

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install SimpleITK numpy scipy scikit-image trimesh fast-simplification
python scripts/prepare_medical_data.py \
  --ct /path/to/head_ct.nii.gz \
  --mri /path/to/head_mri.nii.gz \
  --seg-dir /path/to/masks \
  --out-dir public/assets
```

快速验证只需 `python scripts/prepare_medical_data.py --ct /path/to/head_ct.nii.gz --out-dir public/assets`。只提供 CT 时，MRI 窗口会明确提示未导入。未提供分割时，三维窗口使用占位头模。

掩膜目录可包含 `skull.nii.gz` 和 `brain.nii.gz`。导出颅骨时会自动合并同目录的 `mandible.nii.gz`、`teeth*.nii.gz`、`tooth*.nii.gz` 及 `teeth/` 下的 NIfTI 掩膜。预处理用 Euler3D 刚体变换和 Mattes 互信息对齐 MRI 至 CT，统一重采样到 224 × 224 × 192 的各向同性 LPS 网格。各模态使用同一 LPS 体素坐标，MPR 按各轴真实体素间距设置画幅。真实资产接入后应检查叠加截图、脑室与骨性标志对应情况，结果用于医学教学。

| 输出文件 | 浏览器协议 |
| --- | --- |
| `meta.json` | `version: 1`，`dimensions: [列, 行, 层]`，`spacing: [列, 行, 层]`（mm），`ctWindow: {width, level}`，另有 LPS 原点、`modalities`、`meshFiles` 与可选的配准记录。读取器按清单选择有效资产。 |
| `ct_volume.bin`、`mri_volume.bin` | 无文件头的有符号小端 Int16 HU 和 Uint8 相对信号。列连续，行从前至后，层从足侧到头顶。 |
| `skull.glb`、`brain.glb` | 共享模型坐标。+X 向患者左侧、+Y 向头顶、+Z 向前；Y = −1 到 +1 对应首层到末层。完整网格先做距离加权 Taubin 平滑，再抽稀至各模型最多 20,000 面，随后重算并写入顶点法线。命令行和元数据提供包围盒、面数与轴向检查。 |

浏览器兼容旧文件组 `volume.json`、`ct.i16le`、`mri.u8`。对已知 MRI 序列可在元数据中填 `"mriSequence": "t1"` 或 `"t2"`，也可提供同尺寸、已配准的 `mri_t1.u8` 与 `mri_t2.u8`。缺少物理间距的旧资产和合成数据使用 200 mm 示意轴向范围，界面会标明示意间距。开发时放入资产后刷新页面，生产环境需重新构建。

Vite 在开发和构建时分别为 CT 和 MRI 从原始体素生成独立的预览，最大为 64 × 64 × 64。HTML 预载 CT 预览，Worker 解压并移交体素缓冲区。预览可切层后，高清 CT、3D 模型与渲染器并行启动。MRI 视图可见时加载预览，高清在 CT 下载阶段结束后空闲加载，用户操作 MRI 时可立即开始。存在真实的附加 MRI 序列时，按所选序列单独加载。

预览和高清使用同一组物理坐标，升级时保持切层位置、CT 调窗和手势锁定。完整体数据逐字节保留 HU 和 MRI 信号。模型构建使用无损 Meshopt 压缩 GLB，构建时检查压缩缓冲区的往返字节，保留节点、网格和三角形顺序。Meshopt JS 和内嵌 WASM 由 Vite 随 3D 模块提供。

元数据和标注、预览、3D 与完整体数据的停滞阈值分别为 15 秒、20 秒和 30 秒。收到数据块时重置计时。Gzip 下载或解压失败时尝试原始文件。任一视口的「重试」会重新加载缺失的资产，同时保留已显示的影像。

Netlify 发布 `dist/`。影像、模型与 MediaPipe 运行时资源包含内容指纹，构建为这些路径生成正确的 MIME 与一年期 immutable 响应头。影像高清体数据和 GLB 还使用 `meta.json` 中的 `assetRelease` 作为 Cache API 世代。部署资产变化后清理旧世代，浏览器限制持久存储时仍可用 HTTP 缓存。Service Worker 继续缓存工作站外壳。

## 中文标注扩展

编辑 `public/data/annotations.json`，每层填唯一 `id`、足侧到头顶的 `sliceRatio`、体表参照 `surfaceLandmark`、提示 `quizQuestion`，以及 `structures` 数组。可添加 `title` 和 `landmarkLabel` 作为预设卡标题与简短体表参照。每个结构填 `name`、`x`、`y`、`description`、`clinicalNote`。坐标从图像左上角起归一化到 0–1。目标层号按 `round(sliceRatio × (层数 − 1))` 计算，教学标注可见范围为目标 ±2 层。随附点位是合成图解示意；替换真实序列时需按重采样后的图像复核层位和点位。

教学标注参考 [NSW ACI 头颅 CT 解剖图解](https://aci.health.nsw.gov.au/__data/assets/pdf_file/0003/273702/ACI-ECI-How-read-head-CT.pdf)。CT 窗映射依照 [DICOM VOI LINEAR](https://dicom.nema.org/medical/Dicom/2021c/output/chtml/part03/sect_C.11.2.html)。

第三方来源记录见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。验收记录见 [ROADMAP.md](ROADMAP.md)。
