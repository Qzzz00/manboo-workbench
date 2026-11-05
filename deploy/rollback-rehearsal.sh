#!/usr/bin/env bash
# 回滚演练:在 mktemp 出来的沙箱里走一遍 deploy/rollback-dsh-runtime.sh。
# **不碰 launchd、不碰真 ~/.dsh**(--dsh-home 指到沙箱,--no-launchd)。
set -euo pipefail
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BOX="$(mktemp -d /tmp/wb-rollback-rehearsal-XXXXXX)"
DSH="$BOX/.dsh"

step() { printf '\n########## %s ##########\n' "$1"; }

step '① 摆一台「刚升上 0.1.7、旧那份留在 runtime-prev」的机器'
mkdir -p "$DSH/runtime/node_modules/@deepseek-ai/dsh" "$DSH/runtime-prev/node_modules/@deepseek-ai/dsh" "$DSH/profiles/web" "$DSH/sessions/会话一" "$DSH/logs"
echo '{"version":"0.1.7-rc.2"}' > "$DSH/runtime/node_modules/@deepseek-ai/dsh/package.json"
echo '{"version":"0.1.2-rc.1"}' > "$DSH/runtime-prev/node_modules/@deepseek-ai/dsh/package.json"
echo '新那份的记号' > "$DSH/runtime/我是0.1.7.txt"
echo '旧那份的记号' > "$DSH/runtime-prev/我是0.1.2.txt"
printf '# 新 patch\n- id: ui-sidebar-terminal\n  disabled: true\n' > "$DSH/profiles/web/cordis.patch.yml"
printf '# 旧 patch\n' > "$DSH/profiles/web/cordis.patch.yml.rollback-bak"
echo '旧会话' > "$DSH/sessions/会话一/session.jsonl.zstd"
echo '新会话' > "$DSH/sessions/会话一/session.v4.jsonl.zstd"
echo 'lock' > "$DSH/sessions/会话一/session.lock"
find "$DSH" -maxdepth 2 | sed "s#$BOX#<沙箱>#g" | sort

step "② 不加 --yes:只打印计划,一个文件都不动"
bash "$REPO/deploy/rollback-dsh-runtime.sh" --dsh-home "$DSH" --no-launchd --with-profile | sed "s#$BOX#<沙箱>#g"
[ -f "$DSH/runtime/我是0.1.7.txt" ] || { echo "×  空跑竟然动了文件"; exit 1; }
echo "✓ 空跑之后 runtime 还是 0.1.7 那一份"

step "③ --print-sessions-help"
bash "$REPO/deploy/rollback-dsh-runtime.sh" --dsh-home "$DSH" --print-sessions-help | sed "s#$BOX#<沙箱>#g"

step "④ 真回滚"
bash "$REPO/deploy/rollback-dsh-runtime.sh" --dsh-home "$DSH" --no-launchd --with-profile --yes | sed "s#$BOX#<沙箱>#g"

step "⑤ 核结果"
V="$(node -p "require('$DSH/runtime/node_modules/@deepseek-ai/dsh/package.json').version")"
[ "$V" = "0.1.2-rc.1" ] || { echo "×  换回来的不是 0.1.2-rc.1,是 $V"; exit 1; }
echo "✓ runtime 现在是 $V"
[ -f "$DSH/runtime/我是0.1.2.txt" ] || { echo "×  旧那份的记号不在"; exit 1; }
echo "✓ 换回来的确实是旧那一棵(记号文件在)"
ls -d "$DSH"/runtime-failed-* >/dev/null || { echo "×  没留下 runtime-failed-*"; exit 1; }
echo "✓ 换下来的 0.1.7 留着没删:$(ls -d "$DSH"/runtime-failed-* | sed "s#$BOX#<沙箱>#g")"
[ ! -e "$DSH/runtime-prev" ] || { echo "×  runtime-prev 还在(应该被换走了)"; exit 1; }
echo "✓ runtime-prev 已经换走"
grep -q '# 旧 patch' "$DSH/profiles/web/cordis.patch.yml" || { echo "×  patch 没换回去"; exit 1; }
echo "✓ profile 补丁层换回了旧那份"
[ -f "$DSH/sessions/会话一/session.jsonl.zstd" ] && [ -f "$DSH/sessions/会话一/session.v4.jsonl.zstd" ] && [ -f "$DSH/sessions/会话一/session.lock" ] \
  || { echo "×  会话目录被动过了"; exit 1; }
echo "✓ sessions/ 三个文件(含 session.lock)一个字节没碰"

step "⑥ 没有 runtime-prev 的机器:说清为什么不能回滚,并且不动手"
BOX2="$(mktemp -d /tmp/wb-rollback-rehearsal-XXXXXX)"
mkdir -p "$BOX2/.dsh/runtime"
# 先把输出接下来再判:脚本这一路是 `die`(退 1),`set -o pipefail` 会让整条管道跟着非零,
# 直接写在 `if` 里会永远走 else —— 那样这一条等于没测。
OUT2="$(bash "$REPO/deploy/rollback-dsh-runtime.sh" --dsh-home "$BOX2/.dsh" --no-launchd 2>&1 || true)"
RC2=0
bash "$REPO/deploy/rollback-dsh-runtime.sh" --dsh-home "$BOX2/.dsh" --no-launchd >/dev/null 2>&1 || RC2=$?
echo "$OUT2" | sed "s#$BOX2#<沙箱2>#g" | tail -4
[ "$RC2" -ne 0 ] || { echo "×  没有 runtime-prev 却退了 0"; exit 1; }
echo "$OUT2" | grep -q 'runtime-prev' || { echo "×  没给出那句话"; exit 1; }
echo "$OUT2" | grep -q '没有可换回去的上一版' || { echo "×  没说清为什么"; exit 1; }
[ -d "$BOX2/.dsh/runtime" ] || { echo "×  竟然动了 runtime"; exit 1; }
echo "✓ 如实说了「没有可换回去的上一版」,退非零,而且一个文件都没动"

step "⑦ 收拾沙箱"
# 递归删除只落在本脚本 mktemp 出来的那两个目录上(0904 事故之后的规矩)。
case "$BOX" in /tmp/wb-rollback-rehearsal-*) rm -rf "$BOX" ;; *) echo "路径不对,不删:$BOX"; exit 1 ;; esac
case "$BOX2" in /tmp/wb-rollback-rehearsal-*) rm -rf "$BOX2" ;; *) echo "路径不对,不删:$BOX2"; exit 1 ;; esac
echo "✓ 沙箱已清"

printf '\n===== 回滚演练全过 =====\n'
