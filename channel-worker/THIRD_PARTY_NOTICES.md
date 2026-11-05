# 通话组件(channel-worker)第三方声明

通话组件随安装包与热更新一起分发,里面带着两份**按 LGPL 授权的预编译二进制**。它们不是本项目写的,
许可也不随本项目的许可走;本文件说明它们是什么、按什么许可、源码在哪、你怎么换成自己编译的版本。
许可全文在同目录 `licenses/`(LGPL-3.0 引用了 GPL-3.0 的条款,所以两份一起附上)。

下文的 `<av>` 指 `node_modules/.pnpm/@livekit+av-darwin-arm64@10.0.0/node_modules/@livekit/av-darwin-arm64`,
`<libvips>` 指 `node_modules/.pnpm/@img+sharp-libvips-darwin-arm64@1.3.3/node_modules/@img/sharp-libvips-darwin-arm64`
(pnpm 的布局,这两个包不提到 `node_modules/` 顶层)。

其余生产依赖是 MIT / Apache-2.0 / ISC / BSD 等宽松许可,各自的 LICENSE 文件留在
`node_modules/<包>/` 里(打包脚本删文档时**不删 LICENSE / NOTICE**)。全仓库的依赖许可清单见
`docs/开源-第三方依赖清单-2026-10-21.md`。

---

## 1. FFmpeg(`@livekit/av-darwin-arm64`)

| 项 | 内容 |
|---|---|
| 包 | `@livekit/av-darwin-arm64@10.0.0`,由 `@livekit/av@10.0.0`(Apache-2.0)按平台拉进来,上游是 `@livekit/agents` |
| 文件 | `<av>/ffmpeg`(单个可执行文件,作为子进程调用,不链接进本项目) |
| 许可 | **LGPL-2.1-or-later**(`licenses/LGPL-2.1.txt`) |
| 构建方式 | LiveKit 从未修改的 FFmpeg 上游源码构建;**没有** `--enable-gpl`、`--enable-nonfree`;只开 PCM / MP3 / FLAC / Vorbis / Opus / ALAC 几种音频编解码,唯一外部库是 libopus(BSD-3-Clause)。原话见包内 `NOTICE` |
| 用途 | `@livekit/agents` 做音频的编解码(合成出来的 mp3 / opus 转成房间要的 PCM) |
| 对应源码 | FFmpeg:<https://ffmpeg.org/releases/>(版本以 LiveKit 构建脚本里钉的那个 tarball 为准);libopus:<https://downloads.xiph.org/releases/opus/>;构建脚本:LiveKit `av/scripts/build-ffmpeg.sh`。上游声明见 `<av>/NOTICE` |
| 法律说明 | <https://www.ffmpeg.org/legal.html>。FFmpeg 是 Fabrice Bellard 的商标 |

**换成你自己编译的 FFmpeg**(任选一种):

1. **环境变量**(不动安装目录):给通话组件进程设 `LIVEKIT_FFMPEG_PATH=/你的/ffmpeg`。
   `@livekit/agents` 先读这个变量,读不到才用随包那一份(`dist/ffmpeg.js` 的 `resolveFfmpegPath`)。
2. **原地替换**:把 `<av>/ffmpeg` 换成你自己的可执行文件
   (保持可执行权限)。要求它能处理上面那几种音频格式即可。

注意:热更新会把通话组件整包换新,原地替换的文件会被覆盖;长期用自己的版本请用第 1 种。

---

## 2. libvips 及其依赖库(`@img/sharp-libvips-darwin-arm64`)

| 项 | 内容 |
|---|---|
| 包 | `@img/sharp-libvips-darwin-arm64@1.3.3`(libvips 8.18.6),由 `sharp@0.35.4`(Apache-2.0)按平台拉进来,上游是 `@livekit/agents` |
| 文件 | `<libvips>/lib/libvips-cpp.8.18.6.dylib`(动态库)与 `<libvips>/lib/glib-2.0/` |
| 许可 | **LGPL-3.0-or-later**(`licenses/LGPL-3.0.txt` + `licenses/GPL-3.0.txt`)。这个动态库里还静态带着一批库,各自许可(glib、fribidi、libexif、libheif、librsvg、pango 等为 LGPL,cairo 为 MPL-2.0,其余为 MIT / BSD 类)列在包内 `README.md` 的 Licensing 表里;各库版本在包内 `versions.json` |
| 用途 | `@livekit/agents` 一启动就会加载 `sharp`(图像处理);通话本身不处理图片,但少了它工人起不来 |
| 对应源码 | libvips:<https://github.com/libvips/libvips>;构建脚本与各依赖库的版本:<https://github.com/lovell/sharp-libvips>(tag `v1.3.3`) |

**换成你自己编译的 libvips**(任选一种):

1. **用系统里的 libvips**:自己编译安装 libvips(`pkg-config --modversion vips-cpp` 能查到版本),
   再按 sharp 的文档从源码装 sharp(<https://sharp.pixelplumbing.com/install#building-from-source>);
   设 `SHARP_FORCE_GLOBAL_LIBVIPS=1` 可强制用系统那一份。
2. **原地替换**:`sharp-darwin-arm64-0.35.4.node` 通过 `@rpath` 找 `libvips-cpp.8.18.6.dylib`,
   rpath 指向 `<libvips>/lib`。用 sharp-libvips 的构建脚本(或你改过的版本)
   编出同一 ABI 版本(8.18.x)的 `libvips-cpp.8.18.6.dylib`,替换那个文件即可。

同样,热更新会把原地替换的文件覆盖。

---

## 怎么核对你拿到的这一份

```bash
cd channel-worker/node_modules/.pnpm
cat @livekit+av-darwin-arm64@*/node_modules/@livekit/av-darwin-arm64/package.json          # 版本与 license
cat @img+sharp-libvips-darwin-arm64@*/node_modules/@img/sharp-libvips-darwin-arm64/versions.json  # 各库版本
otool -L @img+sharp-darwin-arm64@*/node_modules/@img/sharp-darwin-arm64/lib/*.node         # 链到哪个 dylib
```

打包脚本(`deploy/pack-channel-worker.sh`)出包前会检查本文件、`licenses/` 与上面两个包的
`NOTICE` / `README.md` 都在包里,缺一样不出包。
