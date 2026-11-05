#!/usr/bin/env bash
#
# Agent hook → 桌面工作台（PRD §8.1，M2）。
#
# 用法：在各 agent 的 hook 配置里把这个脚本挂上，第一个参数是来源 id。
#   Claude Code：~/.claude/settings.json 的 hooks.{Notification,Stop,UserPromptSubmit,SessionEnd}
#   Codex：      ~/.codex/hooks.json 的同名事件（Codex 没有 Notification）
#
# 各家配置里挂的不是这一份，是工作台每次起服务时同步过去的那一份：~/.dsh/workbench/hooks/agent-hook.sh
# (2026-09-25 卡 R「钩子脚本随插件走」，见 src/server/hookScripts.ts)。位置不随插件升级而变；
# 插件卸掉了它也还在，照样按下面那条铁律安静退出。
#
# 这个脚本跑在 agent 的关键路径上，因此只做一件事：把 hook 的 stdin 原样转发。
# 判断哪种 hook 算哪种状态由服务端做（src/server/hooks.ts），那部分有测试。
#
# 铁律：无论工作台在不在、通不通，都必须立刻安静地退出 0。
# 这里一旦卡住或报错，卡住的是 Ben 正在用的 agent。
set -uo pipefail

AGENT="${1:-}"
PORT="${WORKBENCH_PORT:-8791}"

[ -z "$AGENT" ] && exit 0

curl -sS --max-time 1 -o /dev/null \
  -X POST "http://127.0.0.1:${PORT}/hook/${AGENT}" \
  -H 'content-type: application/json' \
  --data-binary @- >/dev/null 2>&1 || true

exit 0
