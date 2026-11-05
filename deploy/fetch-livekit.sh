#!/usr/bin/env bash
#
# 取一份随包的本机房间服务(livekit-server),核两道 sha256,(可选)用工作台本机签名重签(2026-10-21,局域网主路卡 M1)。
#
#     bash deploy/fetch-livekit.sh --into "$PAYLOAD" --sign "$SIGN_ID"     # 出安装包 / 发热更新时
#     bash deploy/fetch-livekit.sh --into dist                             # 开发机上给「一键装」那一步用
#     bash deploy/fetch-livekit.sh --print-sha <bottle.tar.gz>             # 换版本时取新的两个 sha
#
# 放出来的样子:`<into>/livekit/{livekit-server,LICENSE,NOTICE}` —— 就是安装步骤(setup/install.ts 的 livekit 那一步)
# 在 payload 里找的那个位置。
#
# ## 从哪取
#
# **LiveKit 官方不出 macOS 的二进制**(GitHub Releases 只有 linux / windows),所以取 **Homebrew 官方 bottle**:
# ghcr.io 上 `homebrew/core/livekit`,地址就是 bottle 的 sha256(匿名取要带 `Authorization: Bearer QQ==`,Homebrew 自己也这么取)。
# 版本、bottle 那一格、两个 sha 全钉在 `workbench-plugin/src/server/setup/paths.ts`(LIVEKIT_*),这里只读那一处。
# 下来的包先进一个**新建的空目录**,核完 bottle 的 sha、再核解出来那个二进制的 sha,两道都对上才拷出去 —— 之前一下都不执行它。
# 本机缓存一份在 `dist/.cache/`(dist 不进 git):重复出包不用每次下 17MB。
#
# ## 签名
#
# `--sign <身份>` 用 `deploy/codesign-identity.sh --resolve` 解析出来的那个(`-` = ad-hoc),identifier 固定成
# LIVEKIT_CODESIGN_IDENTIFIER。身份不变 ⇒ 系统防火墙认的那条签名要求不变 ⇒ 用户「允许传入连接」点一次就够,换版本也不再问;
# ad-hoc 的话每换一次二进制就要再问一次。重签之后那份的 sha 与 paths.ts 里钉的不同(钉的是重签之前的字节)。
#
# 参数:
#   --into <目录>       放到 <目录>/livekit/ 下。必填(除非 --print-sha)。
#   --sign <身份>       重签。不给就不签(保留 bottle 里的 ad-hoc 链接器签名)。
#   --bottle <文件>     不下载,用这一份 bottle(照样核 sha)。
#   --print-sha <文件>  只算这份 bottle 与里面那个二进制的 sha256,打出来就走。

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INTO=""
SIGN=""
SIGN_SET=0
BOTTLE=""
PRINT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --into) shift; INTO="${1:-}" ;;
    --sign) shift; SIGN="${1:-}"; SIGN_SET=1 ;;
    --bottle) shift; BOTTLE="${1:-}" ;;
    --print-sha) shift; PRINT="${1:-}" ;;
    --help|-h) sed -n "2,$(($(awk '/^set -euo/{print NR; exit}' "${BASH_SOURCE[0]}") - 1))p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
  esac
  shift
done

info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

for tool in node curl tar shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。"
done

# 版本与两个 sha 只有一处定义:paths.ts。
LK_INFO="$(node -e "
  import('$REPO_ROOT/workbench-plugin/src/server/setup/paths.ts').then((m) => {
    process.stdout.write([m.LIVEKIT_SERVER_VERSION, m.LIVEKIT_BOTTLE_TAG, m.LIVEKIT_BOTTLE_SHA256, m.LIVEKIT_BOTTLE_URL,
      m.LIVEKIT_BOTTLE_BINARY, m.LIVEKIT_SERVER_SHA256, m.LIVEKIT_CODESIGN_IDENTIFIER].join('\n'))
  })
" 2>/dev/null)"
LK_VERSION="$(printf '%s' "$LK_INFO" | sed -n 1p)"
LK_TAG="$(printf '%s' "$LK_INFO" | sed -n 2p)"
LK_BOTTLE_SHA="$(printf '%s' "$LK_INFO" | sed -n 3p)"
LK_URL="$(printf '%s' "$LK_INFO" | sed -n 4p)"
LK_INNER="$(printf '%s' "$LK_INFO" | sed -n 5p)"
LK_BIN_SHA="$(printf '%s' "$LK_INFO" | sed -n 6p)"
LK_IDENT="$(printf '%s' "$LK_INFO" | sed -n 7p)"
[ -n "$LK_VERSION" ] && [ ${#LK_BOTTLE_SHA} -eq 64 ] && [ ${#LK_BIN_SHA} -eq 64 ] \
  || die "读不出本机房间服务的版本与 sha256(workbench-plugin/src/server/setup/paths.ts 的 LIVEKIT_*)。"

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/workbench-livekit.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ -n "$PRINT" ]; then
  [ -f "$PRINT" ] || die "没有这个文件:$PRINT"
  mkdir -p "$WORK/x"
  tar -xzf "$PRINT" -C "$WORK/x"
  printf 'LIVEKIT_BOTTLE_SHA256 = %s\n' "$(sha_of "$PRINT")"
  printf 'LIVEKIT_SERVER_SHA256 = %s(%s)\n' "$(sha_of "$WORK/x/$LK_INNER" 2>/dev/null || echo '包里没有这个路径')" "$LK_INNER"
  exit 0
fi

[ -n "$INTO" ] || die "放到哪?--into <目录>(会放到 <目录>/livekit/ 下)"

# ── 1. bottle:缓存 / --bottle / 下载,一律先核 sha ──
CACHE="$REPO_ROOT/dist/.cache/livekit-$LK_VERSION-$LK_TAG.bottle.tar.gz"
GOT="$WORK/bottle.tar.gz"
if [ -n "$BOTTLE" ]; then
  [ -f "$BOTTLE" ] || die "没有这个文件:$BOTTLE"
  cp "$BOTTLE" "$GOT"
elif [ -f "$CACHE" ] && [ "$(sha_of "$CACHE")" = "$LK_BOTTLE_SHA" ]; then
  cp "$CACHE" "$GOT"
  info "livekit-server $LK_VERSION($LK_TAG,本机缓存)"
else
  info "下 livekit-server $LK_VERSION($LK_TAG,Homebrew bottle,约 17MB)"
  curl -fL --retry 2 --retry-delay 2 --connect-timeout 20 -H "Authorization: Bearer QQ==" -o "$GOT" "$LK_URL" >/dev/null 2>&1 \
    || die "livekit-server 的包没下成($LK_URL)。出包这台机器要能上 ghcr.io;或者用 --bottle 指一份手上有的。"
fi
GOT_SHA="$(sha_of "$GOT")"
[ "$GOT_SHA" = "$LK_BOTTLE_SHA" ] || die "livekit-server 的包跟 paths.ts 里钉着的 sha256 对不上(算出来 $GOT_SHA,要的是 $LK_BOTTLE_SHA),不用它。"
if [ -z "$BOTTLE" ] && [ ! -f "$CACHE" ]; then
  mkdir -p "$(dirname "$CACHE")"
  cp "$GOT" "$CACHE"
fi

# ── 2. 解开,核里面那个二进制 ──
mkdir -p "$WORK/x"
tar -xzf "$GOT" -C "$WORK/x"
INNER="$WORK/x/$LK_INNER"
[ -f "$INNER" ] || die "包里没有 $LK_INNER —— bottle 的样子变了?"
INNER_SHA="$(sha_of "$INNER")"
[ "$INNER_SHA" = "$LK_BIN_SHA" ] || die "包里那个 livekit-server 跟 paths.ts 里钉着的 sha256 对不上(算出来 $INNER_SHA,要的是 $LK_BIN_SHA),不用它。"
info "sha256 两道都对上了(包 $LK_BOTTLE_SHA,二进制 $LK_BIN_SHA)"

# ── 3. 放出去(连 LICENSE / NOTICE:Apache-2.0 要求随二进制带上) ──
OUT="$INTO/livekit"
mkdir -p "$OUT"
cp "$INNER" "$OUT/livekit-server"
chmod 755 "$OUT/livekit-server"
INNER_DIR="$(dirname "$(dirname "$INNER")")"
for name in LICENSE NOTICE; do
  [ -f "$INNER_DIR/$name" ] && cp "$INNER_DIR/$name" "$OUT/$name"
done

if [ "$SIGN_SET" = "1" ]; then
  [ -n "$SIGN" ] || die "--sign 要跟一个签名身份(deploy/codesign-identity.sh --resolve 的输出,ad-hoc 就是 -)。"
  codesign --force --sign "$SIGN" --identifier "$LK_IDENT" "$OUT/livekit-server" >/dev/null 2>&1 \
    || die "重签 livekit-server 没成(身份 $SIGN)。"
  if [ "$SIGN" = "-" ]; then
    info "签名:ad-hoc —— 用户每换一次这个二进制,系统防火墙就要再问一次「允许传入连接」。"
  else
    info "签名:工作台本机签名($SIGN),identifier $LK_IDENT"
  fi
fi

"$OUT/livekit-server" --version 2>/dev/null | grep -q "$LK_VERSION" || die "放出来的 livekit-server 跑不出版本 ${LK_VERSION}。"
info "$OUT/livekit-server($(du -h "$OUT/livekit-server" | cut -f1),$("$OUT/livekit-server" --version 2>/dev/null))"
