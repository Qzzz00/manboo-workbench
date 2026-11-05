# 魔力卡待机烘焙·上卡操作卡（复制粘贴版）

定稿于 2026-07-07（原理与实证见 `docs/superpowers/specs/2026-07-07-magikcard-idle-limit-cycle-bake.md`）。
两步：浏览器烤（约 3 分钟）→ 一条命令上卡（约 2 分钟）。

## 第 1 步：烘焙（浏览器）

```
npm run dev 后打开  http://127.0.0.1:4173/?badgeExport=1
```

按下面清单设置（双生标准配方，照抄即可）：

```
角色            shuangsheng
勾选            换装形态 ✓   冻结动作 ✓   吧唧微动（程序化闭环）✓
                动作驱动 ✓   自然摆动层 ✓   竖屏原生 384×640 ✓   物理预热 ✓
取消            眼开合 ✗   RGB565 .bin ✗
动作文件        /live2D/shuangsheng/motions/idle.motion3.json
倍数            2
帧数            960        fps  60        （约束：帧数 = 动作时长×倍数×fps = 8×2×60）
落盘目录        shuangsheng-cand-<新编号>
```

点「**待机动作连拍**」，等状态栏出结果（预热 5-15 圈 ≈ 1-2 分钟）。

**验收（不过就别推卡）**：状态栏两个数——
- `残差 < 0.01`（物理收敛证书；带 ⚠ 亚谐波字样=重开页面再烤一次）
- `回卷MAD ≤ 1.3×帧间中位`（接缝像素门）

## 第 2 步：上卡（终端一条命令）

卡先在 UI 岛把 USB 模式切到 **shell(串口)**（出现 /dev/cu.usbmodem*），然后：

```bash
python3 scripts/magikcard/bake-to-card.py shuangsheng-cand-<新编号>
```

脚本自动：合成背景 → CRF17 契约编码（avc1/main/单slice/单GOP/384×640）→ 串口推送（md5 校验）
→ 换名生效（旧版滚动备份为 loop_prev.mp4）→ `reload_assets` + `set_operator 1` + 锁定
→ 打印 Cedar 解码帧率（≈180/3s = 60fps 满帧）。

只想出 mp4 不推卡：加 `--encode-only`。

## 回滚 / 排障

```bash
# 回滚到上一版
python3 scripts/magikcard/sertransfer.py cmd 'cd /assets/shuangsheng-card && mv loop_prev.mp4 loop.mp4 && sync && epassctl prts reload_assets && epassctl prts set_operator 1'

# 卡上随便跑命令 / 拉文件
python3 scripts/magikcard/sertransfer.py cmd 'epassctl prts status'
python3 scripts/magikcard/sertransfer.py pull /assets/shuangsheng-card/epconfig.json /tmp/epconfig.json
```

- 串口无响应：确认卡 USB 模式=shell、`ls /dev/cu.usbmodem*`；端口不是 1301 就改 sertransfer.py 顶部 PORT。
- push md5 MISMATCH：偶发丢行，重跑一次即可。
- 画面糊：确认烘焙勾了「竖屏原生 384×640」（466 方形上采样必糊）；CRF 可降到 15 再试。
- 观感调参：摆动幅度在 `src/tools/badgeExport/motionCurves.ts` 的 NATURAL_WOBBLE 表；
  底子可换 `idle2.motion3.json`（30 曲线含表情手臂，时长 4.6s → 帧数=4.6×倍数×fps）。

## 换别的角色

前提：模型带 loop-authored 待机动作（VTube 模型标配，`Loop:true` 且曲线首尾值相等）。
烘焙页把「动作文件」指到该模型的 idle motion3，帧数=时长×倍数×fps；
上卡时 `--card-dir /assets/<该角色目录> --op-index <index> --bg <背景图>`。
卡上新建干员包格式见记忆 badge-magikcard-platform（epconfig.json 的 uuid 必须合法 UUID）。
