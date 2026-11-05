#!/bin/bash
# 一次性探针：用 `claude setup-token` 签发的长期 token，读 anthropic-ratelimit-unified-* 响应头。
#
# 依据：steipete/CodexBar#1894 —— 作者在四个订阅账号上验过，
# POST /v1/messages（1 个输出 token）的响应头里带 5h / 7d 的 utilization。
#
# 先决条件：在你自己的终端跑过 `claude setup-token`，拿到那串 token。
#
# 纪律：
# - token 从**隐藏输入**读进变量，不落盘、不进 history、不打印、不进 git。
# - **不碰** /api/oauth/usage —— setup-token 没有 user:profile 作用域，打它是 403（#1894 明说）。
# - 只发一次。model id 会过期，所以备了个回退列表。
set -u

printf 'setup-token（粘贴后回车，不回显）: '
read -rs TOKEN
printf '\n\n'
[ -z "${TOKEN:-}" ] && { echo "没读到 token，停。"; exit 1; }

H=(-H "Authorization: Bearer $TOKEN"
   -H "anthropic-beta: oauth-2025-04-20"
   -H "anthropic-version: 2023-06-01"
   -H "content-type: application/json")

# model id 会随版本下架，备几个按新到旧试。
MODELS=("claude-haiku-4-5-20251001" "claude-sonnet-5" "claude-opus-5")

for M in "${MODELS[@]}"; do
  echo "── 试 $M"
  BODY=$(curl -s -o /tmp/.probe-body -D /tmp/.probe-h -w '%{http_code}' "${H[@]}" \
    -d "{\"model\":\"$M\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    https://api.anthropic.com/v1/messages)
  echo "    HTTP $BODY"

  # 只打印 ratelimit 相关的头。utilization 那两个连值一起打——你要拿它跟客户端对。
  grep -i "^anthropic-ratelimit" /tmp/.probe-h 2>/dev/null | sed 's/^/    /'

  if grep -q -i "^anthropic-ratelimit-unified-5h-utilization" /tmp/.probe-h 2>/dev/null; then
    echo "    ✅ 拿到实时窗口了"
    rm -f /tmp/.probe-h /tmp/.probe-body
    echo
    echo "把上面 5h / 7d 那两行贴给我，再跟你客户端 Usage 页面上的数字对一下是否吻合。"
    exit 0
  fi

  # 没成功就把错误**类型**说出来（不打印整个 body，免得带出别的东西）
  ERR=$(python3 -c '
import json,sys
try: d=json.load(open("/tmp/.probe-body"))
except Exception: sys.exit()
e=d.get("error") or {}
print("    错误类型:", e.get("type","?"), "|", (e.get("message","") or "")[:160])
' 2>/dev/null)
  [ -n "$ERR" ] && echo "$ERR"
  echo
done

rm -f /tmp/.probe-h /tmp/.probe-body
echo "三个 model 都没拿到 unified 头。把上面的 HTTP 状态和错误类型贴给我。"
exit 1
