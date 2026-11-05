#!/bin/sh
# 记忆层换 ai-memory 探针的一次快照(2026-10-21,卡 ai-memory-probe)。只在维护者机器手动跑,只读。
# 量:服务常驻内存、数据目录各块大小、页 / 会话 / 观察条数、待发队列、wiki 提交数、各项目条数。
# 结果追加到 $AIM_PROBE/量/快照.tsv 与同目录一份带时刻的明细;不打印任何令牌。
#   sh workbench-plugin/scripts/probe-ai-memory-snapshot.sh
set -eu
AIM_PROBE="${AIM_PROBE:-$HOME/.local/share/ai-memory-probe}"
DATA="$AIM_PROBE/data"
BIN="${AIM_BIN:-$HOME/.local/lib/ai-memory/ai-memory}"
OUT="$AIM_PROBE/量"
mkdir -p "$OUT"
now=$(date '+%F %T')
pid=$(launchctl print "gui/$(id -u)/ai.deepseek.memory-probe" 2>/dev/null | awk '/pid =/{print $3; exit}')
rss_kb=$( [ -n "$pid" ] && ps -o rss= -p "$pid" | tr -d ' ' || echo "")
kb() { du -sk "$1" 2>/dev/null | awk '{print $1}'; }
status=$("$BIN" --data-dir "$DATA" status 2>/dev/null || true)
field() { printf '%s\n' "$status" | awk -v k="$1" '$1==k {print $2; exit}'; }
pending=$(printf '%s\n' "$status" | awk '/pending:/{print $2; exit}')
commits=$(git -C "$DATA/wiki" rev-list --count HEAD 2>/dev/null || echo 0)
row="$now	${rss_kb}	$(kb "$DATA")	$(kb "$DATA/wiki")	$(kb "$DATA/db")	$(kb "$DATA/raw")	$(kb "$DATA/hook-spool")	$(kb "$DATA/models")	$(field pages:)	$(field sessions:)	$(field observations:)	${pending}	${commits}"
[ -f "$OUT/快照.tsv" ] || printf '时刻\t常驻KB\t数据目录KB\twikiKB\tdbKB\trawKB\t待发KB\tmodelsKB\t页\t会话\t观察\t待发条\twiki提交\n' > "$OUT/快照.tsv"
printf '%s\n' "$row" >> "$OUT/快照.tsv"
token_file="$DATA/auth-tokens/default"
detail="$OUT/快照-$(date '+%m%d-%H%M').txt"
{
  echo "$now"
  printf '%s\n' "$status" | sed -n '/pages:/,/last write/p'
  echo "== 各项目(会话 / 观察 / 页)"
  if [ -r "$token_file" ]; then
    curl -sS -H "Authorization: Bearer $(cat "$token_file")" http://127.0.0.1:49374/api/v1/projects 2>/dev/null \
      | python3 -c 'import json,sys
for p in json.load(sys.stdin): print(p.get("workspace_name"), p.get("project_name"), "页", p.get("page_count"))' 2>/dev/null || true
  fi
} > "$detail"
tail -1 "$OUT/快照.tsv"
