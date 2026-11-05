# 电台 DJ 叫声素材出处与许可

全部素材均为 **CC0 1.0 Universal（公共领域奉献）**：无需署名、可商用、可再分发、可打进 APK。
本文件只是留档溯源，不是许可要求的署名义务。

每个来源页都逐个核实过含 `creativecommons.org/publicdomain/zero/1.0`。

| 本地文件 | 来源 | 作者 | 来源页 |
|---|---|---|---|
| `cat/meow-short.ogg` | Meow | ignasd | https://opengameart.org/content/meow |
| `cat/meow-kitten.ogg` | Kitten Mew | antumdeluge | https://opengameart.org/content/kitten-mew |
| `cat/meow-demand.ogg`<br>`cat/mew-soft.ogg`<br>`cat/mew-purr.ogg`<br>`cat/purr.ogg` | Cat Purr & Meow | kerzoven | https://opengameart.org/content/cat-purr-meow |
| `cat/mwa.ogg` | Baby Animals Sounds Pack | technopeasant | https://opengameart.org/content/baby-animals-sounds-pack |
| `dog/bark-1..3.ogg`<br>`dog/whine-1.ogg`<br>`dog/whine-2.ogg` | Dog sounds | pauliuw | https://opengameart.org/content/dog-sounds |
| `dog/bark-soft.ogg` | Baby Animals Sounds Pack | technopeasant | https://opengameart.org/content/baby-animals-sounds-pack |
| `dog/barking-1.ogg`<br>`dog/barking-2.ogg`<br>`dog/howl.ogg` | 80 CC0 creature SFX | rubberduck | https://opengameart.org/content/80-cc0-creature-sfx |
| `ghost/cute-01..06.ogg`<br>`ghost/weird-01/03/04.ogg`<br>`ghost/ooh.ogg` | 80 CC0 creature SFX | rubberduck | https://opengameart.org/content/80-cc0-creature-sfx |

## 关于「幽灵音效」

找不到 CC0 的「可爱幽灵叫」——OpenGameArt / Freesound 上 CC0 的 ghost 素材基本全是恐怖向，
唯一一个 Ghost Voice Pack 还含真人台词（既说人话又阴森，双重不合适）。

现在用的是 `80 CC0 creature SFX` 里的 `cute_*` / `weird_*` / `ooh`——作者自述是用嘴发声再加滤镜做的
短促怪物叫，音色中性偏软，天然就是「不说人话的叫声」，比拿 whoosh 风声变调合成自然得多。

## 转码参数

源文件 → 单声道 / 24kHz / Ogg Opus 32kbps，掐首尾静音 → 变调 → 峰值归一到 -3dBFS。

**变调（Ben 听感反馈：猫太尖锐、狗太低沉）**：猫 **-2.5 半音** + 压 3.5kHz 刺耳带，狗 **+3.5 半音**
（升调=从成年犬变小奶狗，也更贴「幽灵小狗」设定）。幽灵不动。

```bash
# k = 2**(半音/12)；asetrate 改调同时改速，再用 atempo 把速度改回来 = 纯变调不改时长
PRE="aresample=24000"      # ★必须放最前面，见下面的坑
TRIM="silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,\
      silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse"
CAT="asetrate=24000*0.865537,aresample=24000,atempo=1.155353,\
     equalizer=f=3500:t=q:w=1.4:g=-4,treble=g=-3:f=7000"     # -2.5 半音
DOG="asetrate=24000*1.224054,aresample=24000,atempo=0.816958" # +3.5 半音

ffmpeg -i <src> [-t <maxdur>] -af "$PRE,$TRIM,$CAT" -ac 1 -ar 24000 <tmp.wav>
MAX=$(ffmpeg -i <tmp.wav> -af volumedetect -f null - 2>&1 | grep -o 'max_volume: [-0-9.]*' | awk '{print $2}')
ffmpeg -i <tmp.wav> -af "volume=$((-3 - MAX))dB" -ac 1 -ar 24000 -c:a libopus -b:a 32k <dst>
```

### 三个坑（都踩过，别再踩）

1. ★**`aresample=24000` 必须放在滤镜链最前面**。`asetrate` 设的是**绝对**采样率，而源素材是
   **44100 / 8000 / 48000 三种混杂**——不先归一，`asetrate=24000*k` 对每个源的含义都不同：
   实测 44100 的猫叫被拉长 1.85×、8000 的狗吠被压到 1/3，音高也全错。
   **判据：变调后时长必须基本不变（±5%）**，变了就说明这个坑犯了。
2. ★**量峰值的 `volumedetect` 走 info 级日志，不能加 `-v error`**，否则 grep 不到值、
   增益算成空串、滤镜表达式非法 → 整批编码失败。
3. **不要用 `loudnorm` 做归一**：它在 0.2-0.5s 的短样本上根本测不准响度（初版 ooh.ogg 因此
   峰值 1.018 已削顶）。短音效用两遍 peak normalize 才对。

### 与口型的耦合

`animalVoice.ts` 的口型是**每条叫声自适应**归一（解码时量该条「最响 20ms 窗 RMS」作分母），
所以换素材/改变调**不需要**同步改代码——但仍建议换完跑一遍浏览器实测确认张嘴幅度正常。

- **选 Ogg Opus 而非 AAC**：Chromium 自带 Opus 解码器，不依赖 Android 平台编解码器——
  U3 是无 GMS 的 MTK ROM，少一个平台依赖少一份风险。（Opus 只支持 8/12/16/24/48kHz，故 24k 不是 22.05k。）
- **响度归一**的作用是让每声叫的音量一致，同时使波形 RMS 落在可预期区间——
  `animalVoice.ts` 的口型增益（MOUTH_GAIN=3.2）就是按这个基准调的，换素材要一并复核。
- 呼噜(5.6s)/呜咽(4.2s) 截断到 2.5s/2.2s：一次电台回应不该拖那么久。

26 个文件共约 152KB。
