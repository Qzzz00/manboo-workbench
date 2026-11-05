#!/usr/bin/env bash
#
# 把工作台里的插件退回到「上一次用 构建并装上.sh 之前」那一份(2026-10-02)。
#
#     bash 回滚.sh              # 用最近那一次的备份
#     bash 回滚.sh --列一下      # 只看有哪几份备份,什么都不动
#     bash 回滚.sh <备份目录>    # 指定用哪一份
#
# 备份都在 `~/工作台源码包备份/<年月日-时分秒>/`,**只加不删** —— 每装一次多一份。
# 回滚**完全不联网**:它把当时那几个文件原样写回去,所以网断着也能退。
#
# 退回去之后同样要**把工作台重启一下**才看得到。

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_公共.sh"

if [ -n "${KIT_WANT_HELP:-}" ]; then
  sed -n '2,/^source /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

ROOT="$(backup_root)"
[ -d "$ROOT" ] || die "还没有任何备份($ROOT 不存在)—— 说明还没用 构建并装上.sh 装过,没什么可退的。"

list_backups() {
  # 目录名就是时刻,按名字排序 = 按时间排序。
  find "$ROOT" -mindepth 1 -maxdepth 1 -type d | sort
}

ARG="${POSITIONAL[0]:-}"
if [ "$ARG" = "--列一下" ] || [ "$ARG" = "--list" ]; then
  say "有这几份备份(新的在下面)"
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    printf '  %s\n' "$d"
    if [ -f "$d/记录.txt" ]; then sed 's/^/      /' "$d/记录.txt"; fi
  done <<EOF
$(list_backups)
EOF
  printf '\n  用某一份退回去:bash 回滚.sh <上面那个目录>\n\n'
  exit 0
fi

if [ -n "$ARG" ]; then
  BK="$ARG"
else
  BK="$(list_backups | tail -1)"
  [ -n "$BK" ] || die "$ROOT 底下一份备份都没有。"
  say "用最近那一份:$BK"
  if [ -f "$BK/记录.txt" ]; then sed 's/^/  /' "$BK/记录.txt"; fi
fi

need_node
[ -d "$DSH/profiles/web" ] || die "找不到工作台的 profile($DSH/profiles/web)。"

restore_backup "$BK"

printf '\n✓  已退回备份 %s 里那一份\n' "$(basename "$BK")"
restart_hint
printf '\n'
