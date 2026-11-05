#!/bin/zsh
# 局域网主路探针(2026-10-21,docs/设计-局域网主路-2026-10-21.md、docs/交接-1021-局域网主路.md)。
# 只起自己的东西:本机房间(7880/7881/7882)、替身 8791、工人、假手机;不碰 ~/.dsh、正在跑的 8791 / 工人 / 云房间。
#
# 用法(仓库根目录):scripts/probe-lan-primary.sh [OUT 目录] [channel-worker 的 node_modules]
#   ① 起本机房间 + 用 channel.ts 的 local 模式签票、进房、量数据往返、伪造票被拒
#   ② 本机房间里打一通来电:真工人 + 真识别(中转下发的钥匙,经真 8791 转)+ 真 8792 合成 + 假模型 + 假手机
#   ③ 同上,但识别 / 合成 / 模型都不通(模拟断外网)
#   ④ 真的 8791 HTTP 层按来路签票(卡 M2):工人回环、局域网设备给网卡地址、/channel/status 报 lan、/channel/route、两台 8791 互不认令牌
#   真手机那一条单独跑(要 adb):node scripts/probe-lan-primary/phone-join.ts --out OUT --deps <node_modules>
# 结果:OUT/up.json、OUT/sign-and-join.json、OUT/route-http.json、OUT/call-online.json、OUT/call-offline.json 与各自的日志。
# 停本机房间:kill $(cat OUT/lk.pid)
set -eu
HERE=${0:A:h}
REPO=${HERE:h}
OUT=${1:-${TMPDIR:-/tmp}/wb-lan-probe}
DEPS=${2:-$REPO/channel-worker/node_modules}
[[ -d "$DEPS/@livekit/rtc-node" ]] || DEPS=$HOME/Documents/GitHub/desktop-workbench/channel-worker/node_modules
"$HERE/probe-lan-primary/lk-up.sh" "$OUT"
node "$HERE/probe-lan-primary/sign-and-join.ts" --out "$OUT" --deps "$DEPS"
node "$HERE/probe-lan-primary/route-http.ts" --out "$OUT" --deps "$DEPS"
node "$HERE/probe-lan-primary/call-local.ts" --out "$OUT" --deps "$DEPS"
node "$HERE/probe-lan-primary/call-local.ts" --out "$OUT" --offline --deps "$DEPS"
