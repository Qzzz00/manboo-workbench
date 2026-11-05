#!/usr/bin/env bash
#
# 统筹按编号取诊断包(2026-10-21,内测发版底座)。
#
#     bash deploy/fetch-diag-pack.sh 7KQ2MX
#
# 她在手机或电脑上按「发诊断包」,拿到一个六位编号发过来;这一条把那个包取到 dist/diag-packs/<编号>.zip。
#
# 走法与拉报错(GET /v1/diag/reports)同一条:**ssh 到服务器上,在那台机器里 curl 回环**,
# 管理员令牌从服务器的 .env 里现读 —— 令牌不出服务器、不进这台 Mac 的命令行与日志。
# 包在服务器上 7 天后自动删(relay/server/diagPacks.cjs)。
#
# 参数:
#   --host <ssh 名>    缺省 aiboo-server(同 publish-update.sh)
#   --port <端口>      中转在服务器上听的口,缺省 8795
#   --env <文件>       服务器上那份 .env,缺省 /opt/relay/.env
#   --out <目录>       落到哪,缺省 dist/diag-packs
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="aiboo-server"
PORT="8795"
ENV_FILE="/opt/relay/.env"
OUT="$REPO_ROOT/dist/diag-packs"
CODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) shift; SSH_HOST="${1:-}" ;;
    --port) shift; PORT="${1:-}" ;;
    --env) shift; ENV_FILE="${1:-}" ;;
    --out) shift; OUT="${1:-}" ;;
    --help|-h) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
    *) CODE="$1" ;;
  esac
  shift
done

# 编号规整成中转认的样子:去掉空格与横杠、转大写;只许那三十个字(也就没有能拼进远端命令的字符)。
CODE="$(printf '%s' "$CODE" | tr -d ' -' | tr '[:lower:]' '[:upper:]')"
case "$CODE" in
  [23456789ABCDEFGHJKMNPQRSTVWXYZ][23456789ABCDEFGHJKMNPQRSTVWXYZ][23456789ABCDEFGHJKMNPQRSTVWXYZ][23456789ABCDEFGHJKMNPQRSTVWXYZ][23456789ABCDEFGHJKMNPQRSTVWXYZ][23456789ABCDEFGHJKMNPQRSTVWXYZ]) ;;
  *) echo "编号要是六位(不含 0 O 1 I L U):bash deploy/fetch-diag-pack.sh 7KQ2MX" >&2; exit 1 ;;
esac
case "$PORT" in ''|*[!0-9]*) echo "--port 要是数字" >&2; exit 1 ;; esac

mkdir -p "$OUT"
FILE="$OUT/$CODE.zip"
HEADERS="$(mktemp)"
trap 'rm -f "$HEADERS"' EXIT

# 远端那一段:读令牌 → curl 回环。响应头走 stderr(下面挑几行给人看),包走 stdout 落到本机。
# shellcheck disable=SC2029  # 编号与端口已经在本机核过形状,只剩那三十个字与数字
if ! ssh "$SSH_HOST" "T=\$(grep '^RELAY_ADMIN_TOKEN=' '$ENV_FILE' | cut -d= -f2-); \
  [ -n \"\$T\" ] || { echo '服务器的 .env 里没有 RELAY_ADMIN_TOKEN' >&2; exit 3; }; \
  curl -fsS -D /dev/stderr -H \"Authorization: Bearer \$T\" 'http://127.0.0.1:$PORT/v1/diag/pack/$CODE'" \
  >"$FILE" 2>"$HEADERS"; then
  rm -f "$FILE"
  grep -v -i '^authorization' "$HEADERS" | tail -3 >&2 || true
  echo "×  没取到 ${CODE}:编号抄错了、已经过了 7 天被清掉了,或者连不上 ${SSH_HOST}。" >&2
  exit 1
fi

printf '✓  %s(%s)\n' "$FILE" "$(du -h "$FILE" | cut -f1)"
grep -i '^x-diag-pack-' "$HEADERS" | sed 's/^/   /' || true
if command -v unzip >/dev/null 2>&1; then
  printf '   包里 %s 项;解开:ditto -x -k %s <目录>\n' "$(unzip -Z1 "$FILE" 2>/dev/null | wc -l | tr -d ' ')" "$FILE"
fi
