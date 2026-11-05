#!/usr/bin/env bash
#
# Claude Code statusLine → 桌面工作台（PRD §8.2）。
#
# Claude Code ≥2.1 把 rate_limits 随 statusLine 的 stdin JSON 一起交出来。这个脚本
# 把整份 stdin 转交给本地服务，服务只取额度存下来，并回一行现成文本给状态栏打印。
#
# 三条纪律：
# - 绝不让状态栏因为工作台没起而卡住或报错：超时 1 秒，失败就静默打印本地兜底信息。
# - 不解析、不落盘任何会话内容，转交后即忘。
# - 不读取任何凭据。
#
# 各家配置里指的不是这一份，是工作台起服务时同步过去的那一份：~/.dsh/workbench/hooks/claude-statusline.sh
# (2026-09-25 卡 R「钩子脚本随插件走」，见 src/server/hookScripts.ts)。改了这里，下次起服务就换过去。
set -uo pipefail

PORT="${WORKBENCH_PORT:-8791}"
payload=$(cat)

# 这次带没带 rate_limits。只记这一个事实，不记任何会话内容。
case "$payload" in
  *rate_limits*) HAS_QUOTA="带额度" ;;
  *)             HAS_QUOTA="无额度字段" ;;
esac

response=$(printf '%s' "$payload" \
  | curl -sS --max-time 1 -X POST "http://127.0.0.1:${PORT}/statusline" \
      -H 'content-type: application/json' --data-binary @- 2>/dev/null)
curl_rc=$?

# 调用痕迹：时间 + 带没带额度 + **有没有真的送到**。
# 最后这一项是补的：原来只在发之前记一行，于是"额度明明上报了界面还是未接入"时，
# 分不清是 Claude Code 没给额度、还是给了但这条 POST 根本没送达。
# 真机上就撞过后者——日志有「带额度」，服务端却从没收到（curl 1 秒超时下机器一忙就丢）。
# 不记任何会话内容，也不记响应体。
# 默认记在**这台机器**的 ~/.dsh/workbench/statusline.log(2026-09-25 卡 R：原来写死的是维护者那台机器的
# 家目录，别的机器上 mkdir 不出来、每次都往 stderr 报一句)。HOME 都没有就不记。
TRACE="${WORKBENCH_STATUSLINE_TRACE:-${HOME:+$HOME/.dsh/workbench/statusline.log}}"
if [ -n "$TRACE" ]; then
  mkdir -p "$(dirname "$TRACE")" 2>/dev/null
  if [ "$curl_rc" -eq 0 ] && [ -n "$response" ]; then
    delivery="已送达"
  else
    delivery="没送达(curl=${curl_rc})"
  fi
  # 连脚本自身路径一起记：可能跑的不止一份（固定位置那份、开发时仓库里的各个副本），
  # 只记时间分不清到底是哪一份在跑，而各副本的新旧可能不一致。
  # 写不进去也不许往状态栏那头报错(2>/dev/null 放在前面，重定向失败的那句才会被吞掉)。
  printf '%s %s %s [%s]\n' "$(date +%H:%M:%S)" "$HAS_QUOTA" "$delivery" "$0" 2>/dev/null >> "$TRACE" || true
fi

line=""
if [ -n "$response" ]; then
  if command -v jq >/dev/null 2>&1; then
    line=$(printf '%s' "$response" | jq -r '.line // ""' 2>/dev/null)
  else
    line=$(printf '%s' "$response" | sed -n 's/.*"line":"\([^"]*\)".*/\1/p')
  fi
fi

# 工作台没起、或这台 Claude Code 还不带 rate_limits：状态栏退回显示模型与目录，
# 而不是留一片空白让人以为状态栏坏了。
if [ -z "$line" ]; then
  if command -v jq >/dev/null 2>&1; then
    line=$(printf '%s' "$payload" | jq -r '"\(.model.display_name // "Claude") · \(.cwd // "" | split("/") | last)"' 2>/dev/null)
  fi
  [ -z "$line" ] && line="Claude"
fi

printf '%s' "$line"
