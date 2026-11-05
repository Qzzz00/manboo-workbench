#!/usr/bin/env python3
"""魔力卡待机一键交付：badge-assets/<cand>/motions/idle 的 PNG 帧 → 合成背景 → H.264 编码 → 串口推卡 → 换名生效 → 验证。

前置：烘焙页按 README 的清单烤好一版（竖屏原生 384×640，证书过关），然后：

    python3 scripts/magikcard/bake-to-card.py shuangsheng-cand-M11

默认背景/卡上目录/干员 index 都是双生的；换角色用参数覆盖。--encode-only 只出 mp4 不推卡。
编码契约（vdec 头注 + 实测）：avc1 / main / 单slice / 无B帧 / 单GOP / 384×640(align32) / CRF17。
"""
import argparse, glob, os, re, subprocess, sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
CARD_W, CARD_H = 384, 640

def numeric_key(p):
    m = re.search(r"_(\d+)\.png$", p)
    return int(m.group(1)) if m else 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cand", help="badge-assets 下的烘焙目录名，如 shuangsheng-cand-M11")
    ap.add_argument("--bg", default="badge-assets/backgrounds/shuangsheng-bg.png", help="背景图（466 方形，脚本按渲染同构图放大裁切）")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--crf", type=int, default=17)
    ap.add_argument("--card-dir", default="/assets/shuangsheng-card", help="卡上干员包目录")
    ap.add_argument("--op-index", type=int, default=1, help="epassctl 干员 index")
    ap.add_argument("--out", default=None, help="mp4 输出路径（默认 badge-assets/preview-M8/<cand>-card.mp4）")
    ap.add_argument("--encode-only", action="store_true", help="只编码不推卡")
    args = ap.parse_args()

    from PIL import Image  # 延迟 import：--help 不需要

    idle_dir = os.path.join(REPO, "badge-assets", args.cand, "motions", "idle")
    files = sorted(glob.glob(os.path.join(idle_dir, "*.png")), key=numeric_key)
    if not files:
        sys.exit(f"未找到帧: {idle_dir}/*.png（先在烘焙页烤一版）")
    w, h = Image.open(files[0]).size
    if (w, h) != (CARD_W, CARD_H):
        sys.exit(f"帧尺寸 {w}×{h} ≠ {CARD_W}×{CARD_H}——烘焙时必须勾「竖屏原生 384×640」（466 方形上采样=模糊，M11 已实证）")
    print(f"帧数 {len(files)}，{w}×{h}，{args.fps}fps → 循环 {len(files)/args.fps:.2f}s")

    # 背景与渲染同构图：466 方形 → 放大到 640 高（LANCZOS）→ 居中裁 384 宽
    bg = Image.open(os.path.join(REPO, args.bg)).convert("RGBA").resize((CARD_H, CARD_H), Image.LANCZOS)
    bg = bg.crop(((CARD_H - CARD_W) // 2, 0, (CARD_H - CARD_W) // 2 + CARD_W, CARD_H))

    out_mp4 = args.out or os.path.join(REPO, "badge-assets", "preview-M8", f"{args.cand}-card.mp4")
    os.makedirs(os.path.dirname(out_mp4), exist_ok=True)
    ff = subprocess.Popen([
        FFMPEG, "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
        "-video_size", f"{CARD_W}x{CARD_H}", "-framerate", str(args.fps), "-i", "-",
        "-c:v", "libx264", "-profile:v", "main", "-level", "3.1", "-pix_fmt", "yuv420p",
        "-x264-params", "slices=1:bframes=0:keyint=9999:min-keyint=9999:scenecut=0",
        "-crf", str(args.crf), "-maxrate", "8000k", "-bufsize", "12000k",
        "-movflags", "+faststart", out_mp4,
    ], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for p in files:
        ff.stdin.write(Image.alpha_composite(bg, Image.open(p).convert("RGBA")).convert("RGB").tobytes())
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg 编码失败")
    size = os.path.getsize(out_mp4)
    print(f"编码完成: {out_mp4}（{size/1e6:.1f}MB）")
    if args.encode_only:
        return

    # 推卡（串口 base64 + md5 校验）→ 原子换名（rolling 备份 loop_prev.mp4）→ 生效 → 验证
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import sertransfer as s
    subprocess.run(["stty", "-f", s.PORT, "115200", "raw", "-echo"], check=False)  # 首次使用配好 termios
    s.login()
    tmp_remote = f"{args.card_dir}/loop_new.mp4"
    if not s.push(out_mp4, tmp_remote, chunk=1024):
        sys.exit("推送 md5 校验失败——重跑一次即可（分块 ack 偶发丢行）")
    print(s.capture(
        f"cd {args.card_dir} && cp loop.mp4 loop_prev.mp4 2>/dev/null; mv loop_new.mp4 loop.mp4 && sync && ls -la", 10))
    print(s.capture("epassctl prts reload_assets", 8))
    print(s.capture(f"epassctl prts set_operator {args.op_index}", 6))
    print(s.capture("epassctl prts block_auto_switch true", 6))
    delta = s.capture("A=$(grep cedar /proc/interrupts | awk '{print $2}'); sleep 3; "
                      "B=$(grep cedar /proc/interrupts | awk '{print $2}'); echo cedar_delta_3s=$((B-A))", 12)
    print(delta.strip(), "（60fps 满帧解码 ≈ 180）")
    print(s.capture("epassctl prts status", 6))
    print("完成。回滚：sertransfer.py cmd 'cd", args.card_dir, "&& mv loop_prev.mp4 loop.mp4 && epassctl prts reload_assets'")

if __name__ == "__main__":
    main()
