#!/usr/bin/env bash
#
# 把你在这个包里改过的源码导出成一个 zip,发给维护者(2026-10-02)。
#
#     bash 导出我的改动.sh
#
# 它与包里自带的那份**原始快照**(`基线源码.tgz`,打包那一刻的源码)逐文件比,
# 产出 `我的改动-<日期>.zip`,里面有:
#
#   基线.json        这个包是从哪一版、哪个提交打出来的(维护者那边照它落地)
#   改动清单.txt     改了哪些、新加了哪些、删了哪些
#   改动.diff        一份人能读的 diff
#   改动的文件/…     每个改过/新加的文件的**完整新内容**(维护者那边就按这份落)
#
# 它**不**把 node_modules、lib/(构建产物)、.DS_Store 这些算进来 —— 那些是机器生成的。
# 它也不碰你的任何凭据:只看 `源码/` 这个目录。
#
# 做完把那个 zip 发给维护者就行(微信、网盘都可以),剩下的合并与发版他来做。

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_公共.sh"

if [ -n "${KIT_WANT_HELP:-}" ]; then
  sed -n '2,/^source /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

need_node
[ -d "$REPO" ] || die "包里没有源码目录($REPO)—— 这个包是坏的,跟维护者再要一份。"
[ -f "$KIT/基线源码.tgz" ] || die "包里没有 基线源码.tgz(那是打包那一刻的原始快照)—— 这个包是坏的,跟维护者再要一份。"

say "把包里自带的原始快照解开(只在临时目录里,不碰你改的那一份)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/基线"
tar -xzf "$KIT/基线源码.tgz" -C "$WORK/基线"
BASE="$WORK/基线/源码"
[ -d "$BASE" ] || die "原始快照解开之后不是预期的样子(应该有 源码/)。把这句话发给维护者。"
info "快照:$(kit_field 版本)(提交 $(kit_field 提交))"

# ── 比 ─────────────────────────────────────────────────────
# 排除:node_modules(依赖)、lib(构建产物)、dist、.DS_Store(Finder 留下的)、
# *.tsbuildinfo,以及 scripts/gen-bundled-skills.mjs 生成的那份 `.generated.ts` ——
# 它是**从技能文档现算出来的**,构建时会重新生成。她改了技能文档,统筹那边
# 跑一次构建同样会生成出来;把它算进改动只会让 diff 里多出一大片噪音。
#
# **`--exclude` 认的是目录/文件名,不认路径** —— 所以凡是叫 `lib` 的目录都被排除掉了,
# 包里唯一受影响的是 `butler-server/server/lib`(那里是源码,不是产物)。它在包里**本来就只是
# 只读参考**(说明里写着「要改那些跟维护者说」),所以这一刀的代价是明确的:
# 要改 butler-server 的东西,走维护者,不走这个包。
EXCL=(--exclude node_modules --exclude lib --exclude .DS_Store --exclude '*.generated.ts' --exclude dist --exclude '*.tsbuildinfo')

say "比一遍"
DIFF="$WORK/改动.diff"
# diff 有改动时退出码是 1,那是正常的;≥2 才是真出错。
set +e
diff -ruN "${EXCL[@]}" "$BASE" "$REPO" > "$DIFF"
rc=$?
set -e
[ "$rc" -le 1 ] || die "比的时候出错了(diff 退出码 $rc)。把这句话发给维护者。"

LIST="$WORK/改动清单.txt"
set +e
diff -rq "${EXCL[@]}" "$BASE" "$REPO" > "$WORK/.q" 2>/dev/null
set -e

# `diff -rq` 的三种话:
#   Files A/x and B/x differ        → 改了
#   Only in B/…: name               → 新加的(可能是目录)
#   Only in A/…: name               → 删了
CHANGED="$WORK/.changed"   # 改了 + 新加的(要把完整内容带走)
DELETED="$WORK/.deleted"
: > "$CHANGED"; : > "$DELETED"

cat > "$WORK/认一遍.cjs" <<'JS'
const fs = require('node:fs')
const path = require('node:path')
const [qFile, base, mine, changedOut, deletedOut] = process.argv.slice(2)
const text = fs.readFileSync(qFile, 'utf8')
const changed = []
const deleted = []
const walk = (root, rel, out) => {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) walk(root, next, out)
    else if (entry.isFile()) out.push(next)
  }
}
for (const line of text.split('\n')) {
  let m = /^Files (.+) and (.+) differ$/.exec(line)
  if (m !== null) { changed.push(path.relative(mine, m[2])); continue }
  m = /^Only in (.+): (.+)$/.exec(line)
  if (m === null) continue
  const [, dir, name] = m
  const full = path.join(dir, name)
  const isMine = path.resolve(full).startsWith(path.resolve(mine) + path.sep)
  const root = isMine ? mine : base
  const rel = path.relative(root, full)
  const target = isMine ? changed : deleted
  let stat
  try { stat = fs.statSync(full) } catch { continue }
  if (stat.isDirectory()) {
    const found = []
    walk(root, rel, found)
    target.push(...found)
  }
  else target.push(rel)
}
const uniq = a => [...new Set(a)].sort()
fs.writeFileSync(changedOut, uniq(changed).join('\n') + (changed.length ? '\n' : ''))
fs.writeFileSync(deletedOut, uniq(deleted).join('\n') + (deleted.length ? '\n' : ''))
JS
"$NODE" "$WORK/认一遍.cjs" "$WORK/.q" "$BASE" "$REPO" "$CHANGED" "$DELETED"

N_CHANGED="$(grep -c . "$CHANGED" || true)"
N_DELETED="$(grep -c . "$DELETED" || true)"
if [ "$N_CHANGED" = "0" ] && [ "$N_DELETED" = "0" ]; then
  printf '\n✓  源码跟包里自带的那一份一模一样 —— 没有改动可导出。\n\n'
  exit 0
fi
info "改了/新加了 $N_CHANGED 个文件,删了 $N_DELETED 个"

{
  printf '这个包的基线:%s(提交 %s)\n' "$(kit_field 版本)" "$(kit_field 提交)"
  printf '导出时间:%s\n\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf '== 改了 / 新加了(完整内容在「改动的文件/」里)==\n'
  if [ "$N_CHANGED" = "0" ]; then printf '(没有)\n'; else cat "$CHANGED"; fi
  printf '\n== 删了 ==\n'
  if [ "$N_DELETED" = "0" ]; then printf '(没有)\n'; else cat "$DELETED"; fi
} > "$LIST"

# ── 装箱 ───────────────────────────────────────────────────
say "装箱"
STAMP="$(date +%Y%m%d)"
OUTDIR="$WORK/我的改动-$STAMP"
mkdir -p "$OUTDIR/改动的文件"
cp "$(kit_info)" "$OUTDIR/基线.json"
cp "$LIST" "$OUTDIR/改动清单.txt"
cp "$DIFF" "$OUTDIR/改动.diff"
# 删了的那几个单独记一份纯清单,维护者那边的脚本按它 git rm(人读的那份在 改动清单.txt 里)。
cp "$DELETED" "$OUTDIR/删掉的文件.txt"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$OUTDIR/改动的文件/$(dirname "$rel")"
  cp "$REPO/$rel" "$OUTDIR/改动的文件/$rel"
done < "$CHANGED"

ZIP="$KIT/我的改动-$STAMP.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$OUTDIR" "$ZIP"

printf '\n✓  导出好了:%s(%s)\n' "$ZIP" "$(du -h "$ZIP" | cut -f1)"
info "把这个 zip 发给维护者就行 —— 合并、跑测试、发版他来做。"
info "(你这边的源码一个字没动,照常继续改。)"
printf '\n'
