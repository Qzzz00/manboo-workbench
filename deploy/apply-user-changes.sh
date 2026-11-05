#!/usr/bin/env bash
#
# 把运营同学发回来的改动落到仓库里的一个新分支上(2026-10-02,统筹侧收口)。
#
#     bash deploy/apply-user-changes.sh ~/Downloads/我的改动-20261005.zip
#
# 配套的是 `deploy/make-source-kit.sh`:她那边的源码包里记着**基线是哪个提交**,
# 这个脚本就从那个提交开分支、把她改的文件原样落上去、提交,然后**试着**往 main 上合一次:
#
#   - 合得干净 → 把试合撤掉(分支保持干净),报一句「能直接合」
#   - 有冲突   → 把试合撤掉,**列出冲突的文件,停在这里** 给统筹人工处理
#
# 往哪一个上试合:默认 `main`,要换用 `--onto`。
#
# 为什么要从**她的基线**开分支而不是直接往 main 上盖:她手里那份源码是某一天的快照,
# 这期间 main 上可能已经动过同一处。从基线开分支,她的改动就是一笔干净的提交,
# 合并时 git 能正常三方合并;直接往 main 上盖会把这期间别人的改动悄悄覆盖掉。
#
# 它**不 push、不合并、不发版** —— 看过、跑过测试,由统筹自己决定怎么合(AGENTS.md
# 「部署只由统筹会话做」)。
#
# ## 参数
#
#   <zip>                 她发回来的 `我的改动-<日期>.zip`
#   --branch <名字>       分支名。默认 `用户改动/<日期>-<基线版本>`
#   --onto <分支或提交>   往哪一个上面试合、并按它算「这期间动过同一处吗」。默认 main。
#   --no-commit           只把文件落到工作树上,不提交(自己看过再提交)

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP=""
BRANCH=""
ONTO=""
DO_COMMIT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) shift; BRANCH="${1:-}" ;;
    --onto) shift; ONTO="${1:-}" ;;
    --no-commit) DO_COMMIT=0 ;;
    --help|-h) sed -n "2,$(($(awk '/^set -euo/{print NR; exit}' "${BASH_SOURCE[0]}") - 1))p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
    *) ZIP="$1" ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }
# `core.quotepath=false`:中文路径原样印出来,不印成一串八进制转义。
git_() { git -C "$REPO_ROOT" -c core.quotepath=false "$@"; }

# ───────────────────────── 体检 ─────────────────────────

say "体检"
for tool in git node ditto; do command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。"; done
[ -n "$ZIP" ] || die "要落哪一个包?bash deploy/apply-user-changes.sh <我的改动-*.zip>"
[ -f "$ZIP" ] || die "没有这个文件:$ZIP"
[ -z "$(git_ status --porcelain)" ] || die "工作树不干净 —— 这个脚本要换分支,先把手上的东西提交或收起来。"

CUR="$(git_ rev-parse --abbrev-ref HEAD)"
# 往哪一个上试合:**默认 main**,不是「现在所在的那一个」。
# 为什么:这个脚本做完会把你留在新开的那条 `用户改动/…` 分支上;接着落第二个包时
# 「现在所在的」就成了上一条用户分支 —— 于是「这期间动过同一处吗」把她自己的改动
# 全算成重叠,试合也变成跟她自己合(2026-10-02 自测踩过)。
if [ -z "$ONTO" ]; then
  if git_ rev-parse --verify main >/dev/null 2>&1; then ONTO="main"; else ONTO="$CUR"; fi
fi
info "现在在:$CUR;会往 $ONTO 上试合一次(要换用 --onto)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ditto -x -k "$ZIP" "$WORK/解开" || die "解不开这个 zip。"
# ditto --keepParent 打出来的最外层是一个文件夹(我的改动-<日期>)。
BOX="$(find "$WORK/解开" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$BOX" ] || BOX="$WORK/解开"
[ -f "$BOX/基线.json" ] || die "包里没有 基线.json —— 这不是 导出我的改动.sh 出的包,或者她发的是别的东西。
     看一眼解开之后有什么:$(ls "$BOX" | tr '\n' ' ')"

BASE_COMMIT="$(node -p "require('$BOX/基线.json')['提交']")"
BASE_VERSION="$(node -p "require('$BOX/基线.json')['版本']")"
SRC_ROOT="$(node -p "require('$BOX/基线.json')['源码根'] || '源码'")"
info "她的基线:$BASE_VERSION(提交 $BASE_COMMIT)"
git_ cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null \
  || die "仓库里没有这个提交($BASE_COMMIT)。
     可能是:① 这个基线那一版没推上来;② 她拿的是别的仓库的包。
     先 git fetch --all 再跑一次;还找不到就去问那个包是谁打的。"

CHANGED_DIR="$BOX/改动的文件"
[ -d "$CHANGED_DIR" ] || die "包里没有「改动的文件」目录 —— 没东西可落。"

# 她包里的路径是**相对仓库根**的(源码/ 就是仓库根的样子),所以直接照着落。
FILES="$(cd "$CHANGED_DIR" && find . -type f | sed 's|^\./||' | sort)"
[ -n "$FILES" ] || die "「改动的文件」里一个文件都没有。"
DELETED=""
if [ -f "$BOX/删掉的文件.txt" ]; then DELETED="$(grep -v '^$' "$BOX/删掉的文件.txt" || true)"; fi

say "她改了这些"
printf '%s\n' "$FILES" | sed 's/^/  + /'
if [ -n "$DELETED" ]; then printf '%s\n' "$DELETED" | sed 's/^/  - /'; fi

# ───────── 这期间 main 上有没有动过同一处(先说一句) ─────────

say "这期间仓库里有没有动过同一处"
ONTO_SHA="$(git_ rev-parse "$ONTO")"
BOTH=""
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if git_ diff --name-only "$BASE_COMMIT" "$ONTO_SHA" -- "$rel" | grep -q .; then
    BOTH="$BOTH
  $rel"
  fi
done <<EOF
$FILES
$DELETED
EOF
if [ -n "$(printf '%s' "$BOTH" | tr -d '[:space:]')" ]; then
  info "两边都动过的(合并时要特别看):$BOTH"
else
  info "没有重叠 —— 她碰的那几处仓库里没动过。"
fi

# ───────────────── 从她的基线开分支,落上去 ─────────────────

[ -n "$BRANCH" ] || BRANCH="用户改动/$(date +%m%d)-$BASE_VERSION"
say "从她的基线开分支:$BRANCH"
git_ rev-parse --verify "$BRANCH" >/dev/null 2>&1 \
  && die "已经有分支 $BRANCH 了。用 --branch 换个名字,或者先把那个删掉。"
git_ checkout -B "$BRANCH" "$BASE_COMMIT" >/dev/null 2>&1 || die "开分支失败。"
info "已切到 $BRANCH(基线 ${BASE_COMMIT:0:12})"

say "把她的文件落上去"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$REPO_ROOT/$(dirname "$rel")"
  cp "$CHANGED_DIR/$rel" "$REPO_ROOT/$rel"
  info "写:$rel"
done <<EOF
$FILES
EOF
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if [ -e "$REPO_ROOT/$rel" ]; then git_ rm -q -- "$rel"; info "删:$rel"; fi
done <<EOF
$DELETED
EOF
git_ add -A
info ""
git_ status --short | sed 's/^/  /'

if [ "$DO_COMMIT" = "0" ]; then
  printf '\n✓  文件都落在 %s 上了(按 --no-commit,没提交)。\n' "$BRANCH"
  printf '   自己看过再 git commit;然后跑一遍测试与构建,再决定怎么合到 %s。\n\n' "$ONTO"
  exit 0
fi

say "提交"
git_ commit -q -F - <<EOF
feat(用户改动): 落运营同学的源码改动(基线 $BASE_VERSION / ${BASE_COMMIT:0:12})

来源:她那台机器上的源码包 工作台源码包-$BASE_VERSION(deploy/make-source-kit.sh 打的),
由 deploy/apply-user-changes.sh 原样落在基线提交上。她的改动清单与 diff 见那个 zip 里的
改动清单.txt / 改动.diff。

**还没跑过测试、没跑过构建** —— 统筹接着做:跑测试、跑类型检查、跑构建,
该补的用例补上,再决定怎么合到 ${ONTO}。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
info "已提交:$(git_ rev-parse --short HEAD)"

# ───────────── 试合一次:冲突就列出来、停下 ─────────────

say "往 $ONTO 上试合一次(只是试,马上撤掉)"
if git_ merge --no-commit --no-ff "$ONTO_SHA" >/dev/null 2>&1; then
  git_ merge --abort 2>/dev/null || git_ reset --hard -q HEAD
  info "✓ 合得干净 —— 可以直接合。"
  CLEAN=1
else
  CONFLICTS="$(git_ diff --name-only --diff-filter=U || true)"
  git_ merge --abort 2>/dev/null || git_ reset --hard -q HEAD
  info "! 有冲突,停在这里(分支本身是干净的,试合已经撤掉):"
  printf '%s\n' "$CONFLICTS" | sed 's/^/    /'
  CLEAN=0
fi

printf '\n✓  她的改动已经落在分支 %s 上(基线 %s)\n' "$BRANCH" "${BASE_COMMIT:0:12}"
info "看一眼:git -C $REPO_ROOT show --stat $BRANCH"
info "跑测试:cd workbench-plugin && pnpm vitest run <她碰过的那几个文件>"
info "跑构建:cd workbench-plugin && pnpm build && pnpm typecheck"
if [ "$CLEAN" = "1" ]; then
  info "合:git checkout $ONTO && git merge $BRANCH"
else
  info "合:先看上面列的冲突文件,git checkout $ONTO && git merge $BRANCH 之后手工解"
fi
info "统筹合完、测过,再统一版本号发版(AGENTS.md:部署只由统筹会话做)。"
printf '\n'
