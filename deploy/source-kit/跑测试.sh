#!/usr/bin/env bash
#
# 跑测试(2026-10-02)。
#
#     bash 跑测试.sh tests/xxx.test.ts        # 只跑这一个文件(**平时就该这样**)
#     bash 跑测试.sh --typecheck              # 只做类型检查
#     bash 跑测试.sh                          # 全跑(一千多个用例,十几分钟,而且见下面那一条)
#
# 为什么要这么个小壳子:这台机器上 `node` 不在 PATH 上(工作台自己带的那一份在
# `~/.dsh/node/bin`),而 `node_modules/.bin/vitest` 第一行要找 `node`。
# 它做的事只有「把 PATH 摆对,再把参数原样交给 vitest」。
# (`node_modules/.bin/vitest` 是 pnpm 生成的 shell 小壳子,**直接执行**它,别用 `node` 去跑它。)
#
# **全跑一定会有一批文件红,那不是你改坏的**,有三类(下面跑之前也会提醒一次):
#   ① 要 `git` 这个命令的(三十多个文件:建临时仓库当夹具,或者拿它数源码)——
#      这台机器上没有它,那些跑不了;
#   ② 运行时真去 import 上游 DSH 的 client 包的 —— 包里带了上游的源码子集,
#      但带不了整个上游仓库(它自己的依赖 1.4GB);
#   ③ 要读这个包里没带的兄弟目录的接缝对照用例(整个仓库 300 多 MB,不可能都塞进来)。
# 所以**只跑你动过的那部分**;全套由维护者在他那边跑。

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_公共.sh"

if [ -n "${KIT_WANT_HELP:-}" ]; then
  sed -n '2,/^source /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

need_node
need_deps

# 没有版本管理那个命令就先说一句 —— 别让她看见三十多个红文件去猜是不是自己改坏了。
if ! command -v git >/dev/null 2>&1; then
  info "提醒:这台机器上没有版本管理那个命令(git),而有三十多个用例要用它"
  info "      (建临时仓库当夹具,或者拿它数源码)。那些会红,**不是你改坏的** —— 跳过就行。"
fi

if [ "${POSITIONAL[0]:-}" = "--typecheck" ]; then
  say "类型检查(tsc --noEmit)"
  cd "$SRC" && exec env PATH="$(kit_path)" node_modules/.bin/tsc --noEmit
fi

say "vitest run ${POSITIONAL[*]:-(全部)}"
cd "$SRC"
if [ "${#POSITIONAL[@]}" -gt 0 ]; then
  exec env PATH="$(kit_path)" node_modules/.bin/vitest run "${POSITIONAL[@]}"
fi
exec env PATH="$(kit_path)" node_modules/.bin/vitest run
