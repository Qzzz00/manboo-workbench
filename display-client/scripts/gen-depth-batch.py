#!/usr/bin/env python3
"""背景图 → 深度图批处理（Depth-Anything V2，Apple Silicon MPS 加速）。

给一批背景图离线生成灰度深度图（近亮远暗），供客户端 2.5D 景深（DisplacementFilter）使用。
生产服务器不跑模型：在 Mac 上生成后，把 <name>.depth.png 上传到背景同目录即可，
客户端按命名约定（<name>.jpg → <name>.depth.png）自动探测加载。

用法:
    python3 scripts/gen-depth-batch.py <输入目录> <输出目录>
    # 输入目录里每个 .jpg/.png/.jpeg → 输出目录生成同名 <name>.depth.png

依赖（Apple Silicon）:
    python3 -m pip install torch torchvision transformers pillow
    # 首次运行自动下载 Depth-Anything-V2-Small 模型（约 100MB，缓存复用）

规格:
    - 深度归一化 0–255 灰度，mode L
    - 下采样到 1080 宽（保持宽高比），控体积、匹配客户端 cover
    - 命名严格 <输入文件名去扩展>.depth.png
"""
import sys
import os
import glob
import numpy as np
from PIL import Image

TARGET_WIDTH = 1080


def main(in_dir: str, out_dir: str) -> None:
    from transformers import pipeline  # 延迟导入，--help 不需要重依赖

    files = []
    for ext in ("*.jpg", "*.jpeg", "*.png"):
        files.extend(glob.glob(os.path.join(in_dir, ext)))
    files = sorted(f for f in files if not f.endswith(".depth.png"))
    if not files:
        print(f"输入目录无背景图: {in_dir}")
        sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)
    print(f"加载 Depth-Anything V2 Small (MPS)… 目标 {len(files)} 张", flush=True)
    pipe = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Small-hf", device="mps")

    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        img = Image.open(f).convert("RGB")
        w, h = img.size
        d = np.asarray(pipe(img)["depth"]).astype(np.float32)
        d = (d - d.min()) / (d.max() - d.min() + 1e-8)  # 近亮远暗
        dep = Image.fromarray((d * 255).astype(np.uint8), "L")
        dep = dep.resize((TARGET_WIDTH, round(TARGET_WIDTH * h / w)))
        out = os.path.join(out_dir, f"{name}.depth.png")
        dep.save(out)
        print(f"  {name}  {img.size} → {dep.size}  {round(os.path.getsize(out) / 1024)}KB", flush=True)

    print("完成。把 <name>.depth.png 上传到生产背景同目录即可（客户端自动探测）。", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
