#!/usr/bin/env bash
#
# 清空演练:在 mktemp 出来的假 HOME 里走一遍 deploy/wipe-to-fresh.sh。
# **不碰真 ~/.dsh、不碰 launchd、不碰真账号**(--home 指到沙箱、--no-launchd、端口指到没人听的口)。
#
#     bash deploy/wipe-rehearsal.sh
#
# 验四件事:① 空跑一个文件都不动;② 真跑只删清单里点了名的路径;③ 备份 tgz 生成且列得出文件;
# ④ 工作台没在跑时如实说「账号设备没撤」并且**不中断**后面。
set -euo pipefail
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/deploy/wipe-to-fresh.sh"
DEAD_PORT=58791   # 没人听的口:走「工作台没在跑」那一路

step() { printf '\n########## %s ##########\n' "$1"; }
fail() { printf '×  %s\n' "$1"; exit 1; }
ok()   { printf '✓ %s\n' "$1"; }

# 摆一台「装过工作台、登过、配过手机和座机」的假机器。
stage() {
  local BOX="$1" DSH="$1/.dsh" WB="$1/.dsh/workbench"
  mkdir -p "$DSH"/{node,runtime,profiles/web,packages,bin,butler-server,channel-worker,logs,sessions/会话一,storages,updates}
  mkdir -p "$WB/login-profile-kimi_web" "$WB/memory" "$WB/butler"
  mkdir -p "$BOX/Library/LaunchAgents" "$BOX/Library/WebKit/ai.ben.workbench" \
           "$BOX/Library/HTTPStorages/ai.ben.workbench" "$BOX/Library/Caches/ai.ben.workbench" \
           "$BOX/Library/Caches/别的东西" "$BOX/Documents/工作台" "$BOX/Documents/我的稿子" \
           "$BOX/Applications/工作台.app/Contents/MacOS" "$BOX/.claude" "$BOX/.codex"
  # 安装件
  echo 'node' > "$DSH/node/bin-node"
  echo '{"version":"0.1.2-rc.1"}' > "$DSH/runtime/package.json"
  echo 'patch' > "$DSH/profiles/web/cordis.patch.yml"
  echo 'tgz' > "$DSH/packages/plugin-0.4.64.tgz"
  echo 'dsh-start' > "$DSH/bin/dsh-start"
  echo 'server' > "$DSH/butler-server/index.js"
  echo 'worker' > "$DSH/channel-worker/index.js"
  echo 'log' > "$DSH/logs/web.stderr.log"
  echo 'plist' > "$BOX/Library/LaunchAgents/ai.deepseek.dsh.plist"
  echo 'app' > "$BOX/Applications/工作台.app/Contents/MacOS/工作台"
  # 用户态(该删的)
  echo '{}' > "$WB/account.json"
  echo 'key' > "$WB/account-session.key"
  echo '{}' > "$WB/account-server.json"
  echo '{"devices":[]}' > "$WB/devices.json"
  echo '{}' > "$WB/onboarding.json"
  echo '{}' > "$WB/credentials.json"
  echo '{}' > "$WB/model.json"
  echo '{}' > "$WB/channel.json"
  echo 'chrome' > "$WB/login-profile-kimi_web/Default"
  echo 'WORKBENCH_RELAY_TOKEN=x' > "$DSH/.env"
  printf '{\n  "first_run_done_at": "2026-09-01T00:00:00Z",\n  "butler_cwd": "%s/Documents/工作台"\n}\n' "$BOX" > "$WB/app.json"
  echo 'cookie' > "$BOX/Library/WebKit/ai.ben.workbench/cookie"
  # 她的数据(必须活下来)
  echo '记忆' > "$WB/memory/画像.md"
  echo '事项' > "$WB/items.json"
  echo '随手记' > "$WB/notes.json"
  echo '会话' > "$DSH/sessions/会话一/session.jsonl.zstd"
  echo 'storage' > "$DSH/storages/a.json"
  echo 'AGENTS' > "$DSH/AGENTS.md"
  echo 'settings' > "$DSH/settings.yaml"
  echo 'creds' > "$DSH/.credentials.yaml"
  echo '{"hooks":[]}' > "$BOX/.claude/settings.json"
  echo '{"hooks":[]}' > "$BOX/.codex/hooks.json"
  echo '缓存' > "$BOX/Library/Caches/别的东西/x"
  echo '稿子' > "$BOX/Documents/我的稿子/a.md"
  echo '更新' > "$DSH/updates/installed.json"
}

run() { # run <BOX> <额外参数...>
  local BOX="$1"; shift
  bash "$SCRIPT" --home "$BOX" --app "$BOX/Applications/工作台.app" \
    --port "$DEAD_PORT" --no-launchd "$@" 2>&1 | sed "s#$BOX#<沙箱>#g"
}

# ── ① 空跑 ────────────────────────────────────────────────────────────────
step "① 空跑:只列不删"
BOX1="$(mktemp -d /tmp/wb-wipe-rehearsal-XXXXXX)"
stage "$BOX1"
BEFORE="$(cd "$BOX1" && find . | sort)"
OUT1="$(run "$BOX1")"
printf '%s\n' "$OUT1" | tail -6
AFTER="$(cd "$BOX1" && find . | sort)"
[ "$BEFORE" = "$AFTER" ] || { diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | head; fail "空跑动了文件"; }
ok "空跑之后一个文件都没变"
ls "$BOX1/Desktop" >/dev/null 2>&1 && fail "空跑竟然造了备份包"
ok "空跑没打包"
printf '%s\n' "$OUT1" | grep -q '要删:' || fail "空跑没把要删的列出来"
ok "空跑把要删的都列了出来"
printf '%s\n' "$OUT1" | grep -q '账号设备没撤' || fail "工作台没在跑,却没说「账号设备没撤」"
ok "工作台没在跑:如实说了「账号设备没撤」"

# ── ② 真跑 ────────────────────────────────────────────────────────────────
step "② 真跑(--do --yes):只删清单里的路径"
BOX2="$(mktemp -d /tmp/wb-wipe-rehearsal-XXXXXX)"
stage "$BOX2"
RC=0
OUT2="$(run "$BOX2" --do --yes)" || RC=$?
[ "$RC" -eq 0 ] || { printf '%s\n' "$OUT2" | tail -20; fail "真跑退了 $RC —— 工作台没在跑不该中断"; }
ok "工作台没在跑,整趟仍然跑完(退 0)"
printf '%s\n' "$OUT2" | tail -30

step "③ 核备份包"
TGZ="$(ls "$BOX2"/Desktop/工作台清空前备份-*.tgz 2>/dev/null | head -1)" || true
[ -n "${TGZ:-}" ] && [ -f "$TGZ" ] || fail "没生成备份 tgz"
ok "备份包在:$(basename "$TGZ")"
N="$(tar -tzf "$TGZ" | wc -l | tr -d ' ')"
[ "$N" -ge 10 ] || fail "备份包只列出 $N 个条目,太少"
ok "备份包列得出 $N 个条目"
# bsdtar 列目录时把非 ASCII 转成八进制转义,所以这里只用 ASCII 的正则对。
LISTING="$(tar -tzf "$TGZ")"
for want in '^\.dsh/workbench/items\.json$' '^\.dsh/AGENTS\.md$' '^\.dsh/\.env$' \
            '^\.dsh/settings\.yaml$' '^\.dsh/\.credentials\.yaml$' \
            '^\.dsh/sessions/.+/session\.jsonl\.zstd$' '^\.dsh/storages/a\.json$' \
            '^\.claude/settings\.json$' '^\.codex/hooks\.json$'; do
  printf '%s\n' "$LISTING" | grep -qE "$want" || fail "备份包里没有 $want"
done
ok "清单 §一 那几样都进了包(含删掉的 .env、凭据文件)"

step "④ 核该删的都删了"
for gone in .dsh/node .dsh/runtime .dsh/profiles .dsh/packages .dsh/bin .dsh/butler-server \
            .dsh/channel-worker .dsh/logs Library/LaunchAgents/ai.deepseek.dsh.plist \
            Applications/工作台.app .dsh/workbench/account.json .dsh/workbench/account-session.key \
            .dsh/workbench/account-server.json .dsh/workbench/devices.json \
            .dsh/workbench/onboarding.json .dsh/workbench/credentials.json \
            .dsh/workbench/model.json .dsh/workbench/channel.json \
            .dsh/workbench/login-profile-kimi_web .dsh/.env \
            Library/WebKit/ai.ben.workbench Library/HTTPStorages/ai.ben.workbench \
            Library/Caches/ai.ben.workbench; do
  [ ! -e "$BOX2/$gone" ] || fail "该删的还在:$gone"
done
ok "清单 §二、§八~§九 那些路径都没了"

step "⑤ 核该留的一个字没动"
for keep in .dsh/workbench/items.json .dsh/workbench/notes.json .dsh/workbench/memory/画像.md \
            .dsh/sessions/会话一/session.jsonl.zstd .dsh/storages/a.json .dsh/AGENTS.md \
            .dsh/settings.yaml .dsh/.credentials.yaml .claude/settings.json .codex/hooks.json \
            Library/Caches/别的东西/x Documents/我的稿子/a.md \
            .dsh/updates/installed.json Documents/工作台; do
  [ -e "$BOX2/$keep" ] || fail "该留的被删了:$keep"
done
ok "她的数据、别家缓存、待拍板那两样(updates / Documents/工作台)都还在"
grep -q first_run_done_at "$BOX2/.dsh/workbench/app.json" && fail "app.json 里的 first_run_done_at 没摘掉"
grep -q butler_cwd "$BOX2/.dsh/workbench/app.json" || fail "摘 first_run_done_at 时把 butler_cwd 也摘了"
ok "app.json 只摘了 first_run_done_at,butler_cwd 还在"

step "⑥ 删掉的路径全在沙箱里"
DEL="$(printf '%s\n' "$OUT2" | sed -n '/删掉的路径/,$p' | sed -n 's/^  - //p')"
[ -n "$DEL" ] || fail "结果里没列出删掉的路径"
printf '%s\n' "$DEL" | while IFS= read -r p; do
  case "$p" in "<沙箱>"/*) : ;; *) fail "删了沙箱外的东西:$p" ;; esac
done
ok "删掉的 $(printf '%s\n' "$DEL" | wc -l | tr -d ' ') 条路径全在沙箱里"

# ── ⑦ 待拍板那两样加了开关才删 ───────────────────────────────────────────
step "⑦ --with-documents --with-updates:加了才删"
BOX3="$(mktemp -d /tmp/wb-wipe-rehearsal-XXXXXX)"
stage "$BOX3"
run "$BOX3" --do --yes --with-documents --with-updates > /dev/null
[ ! -e "$BOX3/Documents/工作台" ] || fail "--with-documents 没删 Documents/工作台"
[ ! -e "$BOX3/.dsh/updates" ] || fail "--with-updates 没删 .dsh/updates"
[ -e "$BOX3/Documents/我的稿子/a.md" ] || fail "把 Documents 里别的东西也删了"
ok "两个开关各自只删自己那一样"

# ── ⑧ 备份打不出来就整个退出,什么都不删 ────────────────────────────────
step "⑧ 桌面不可写(备份打不出来):什么都不删,非零退出"
BOX4="$(mktemp -d /tmp/wb-wipe-rehearsal-XXXXXX)"
stage "$BOX4"
printf '不是目录' > "$BOX4/Desktop"   # mkdir -p 会失败 → tar 打不出来
BEFORE4="$(cd "$BOX4" && find . | sort)"
RC4=0
OUT4="$(run "$BOX4" --do --yes)" || RC4=$?
[ "$RC4" -ne 0 ] || fail "备份都没成却退了 0"
AFTER4="$(cd "$BOX4" && find . | sort)"
[ "$BEFORE4" = "$AFTER4" ] || fail "备份失败之后竟然还删了东西"
printf '%s\n' "$OUT4" | tail -3
ok "备份失败:非零退出,一个文件都没删"

# ── ⑨ 拒绝删家目录级别的东西 ───────────────────────────────────────────
step "⑨ 守卫:--dsh-home 指到 HOME 本身时不许动手"
BOX5="$(mktemp -d /tmp/wb-wipe-rehearsal-XXXXXX)"
stage "$BOX5"
RC5=0
bash "$SCRIPT" --home "$BOX5" --dsh-home "$BOX5" --app "$BOX5/Applications/工作台.app" \
  --port "$DEAD_PORT" --no-launchd --do --yes >/dev/null 2>&1 || RC5=$?
[ "$RC5" -ne 0 ] || fail "~/.dsh 指到 HOME 本身竟然跑完了"
[ -e "$BOX5/.dsh/workbench/items.json" ] || fail "守卫没拦住,数据被删了"
ls "$BOX5/Desktop" >/dev/null 2>&1 && fail "被守卫拦住之前竟然还打了包"
# 先把输出接下来再判:这一路是 `die`(退 1),pipefail 会让整条管道跟着非零。
OUT5="$(bash "$SCRIPT" --home "$BOX5" --dsh-home "$BOX5" --port "$DEAD_PORT" --no-launchd 2>&1 || true)"
printf '%s\n' "$OUT5" | grep -q '不能是家目录或根' || fail "拦下来时没说清为什么"
ok "守卫在备份之前就拦住了(非零退出、没打包、数据还在)"

# ── ⑩ 阶段 ②:拿一台假工作台验「列出来 → 逐台撤 → 座机最后 → 退出登录」 ──────
step "⑩ 假工作台:设备逐台撤,座机排最后,最后退出登录"
BOX6="$(mktemp -d /tmp/wb-wipe-rehearsal-XXXXXX)"
stage "$BOX6"
STUB_PORT=58792
STUB_LOG="$BOX6/stub.log"
: > "$STUB_LOG"
# 假工作台:只答这一趟要用的四条路,收到的 POST 一行一条记进 stub.log(回包里本来就没有令牌)。
cat > "$BOX6/stub.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
PORT, LOG = int(sys.argv[1]), sys.argv[2]
NAMES = {"d-phone": "手机-小米", "d-mac": "电脑-Air", "d-handset": "座机-客厅"}
ACCOUNT_DEVICES = [
    {"device_id": "d-phone", "kind": "phone", "name": "手机-小米", "last_seen_at": "2026-09-30T10:00:00Z"},
    {"device_id": "d-mac", "kind": "mac", "name": "电脑-Air", "current": True, "last_seen_at": "2026-09-30T17:00:00Z"},
    {"device_id": "d-handset", "kind": "handset", "name": "座机-客厅", "last_seen_at": "2026-09-28T22:24:00Z"},
]
LOCAL = [{"id": "p1", "name": "本机小米", "platform": "android", "kind": "phone", "created_at": "2026-09-29T00:00:00Z"}]

def note(line):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/account": self.send({"registered": True, "logged_in": True, "username": "ben"})
        elif self.path == "/account/devices": self.send({"devices": ACCOUNT_DEVICES})
        elif self.path == "/state": self.send({"devices": LOCAL})
        else: self.send({"error": "没有这个路径"}, 404)
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/account/devices/revoke":
            note("revoke " + NAMES.get(body.get("device_id"), "?")); self.send({"devices": []})
        elif self.path == "/pair/revoke":
            note("pair-revoke 本机小米" if body.get("id") == "p1" else "pair-revoke ?"); self.send({"ok": True})
        elif self.path == "/account/reset":
            note("reset"); self.send({"ok": True})
        else: self.send({"error": "没有这个路径"}, 404)

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY
python3 "$BOX6/stub.py" "$STUB_PORT" "$STUB_LOG" > "$BOX6/stub.out" 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT
wait_stub() { local i=0; while [ "$i" -lt 50 ]; do curl -fsS "http://127.0.0.1:$STUB_PORT/account" >/dev/null 2>&1 && return 0; i=$((i+1)); sleep 0.1; done; return 1; }
wait_stub || fail "假工作台没起来"
RC6=0
OUT6="$(bash "$SCRIPT" --home "$BOX6" --app "$BOX6/Applications/工作台.app" \
  --port "$STUB_PORT" --no-launchd --do --yes 2>&1 | sed "s#$BOX6#<沙箱>#g")" || RC6=$?
{ kill "$STUB_PID"; wait "$STUB_PID"; } 2>/dev/null || true
[ "$RC6" -eq 0 ] || { printf '%s\n' "$OUT6" | tail -20; fail "接上工作台之后退了 $RC6"; }
printf '%s\n' "$OUT6" | sed -n '/② 账号下的设备/,/③ 本机/p' | head -40
grep -qx 'revoke 手机-小米' "$STUB_LOG" || fail "手机没撤"
grep -qx 'revoke 电脑-Air' "$STUB_LOG" || fail "电脑没撤"
grep -qx 'revoke 座机-客厅' "$STUB_LOG" || fail "座机没撤"
grep -qx 'pair-revoke 本机小米' "$STUB_LOG" || fail "本机配对没解"
grep -qx 'reset' "$STUB_LOG" || fail "没退出登录"
[ "$(grep -n 'revoke 座机-客厅' "$STUB_LOG" | cut -d: -f1)" -gt \
  "$(grep -n 'revoke 手机-小米' "$STUB_LOG" | cut -d: -f1)" ] || fail "座机没排在手机后面"
[ "$(grep -n 'reset' "$STUB_LOG" | cut -d: -f1)" = "$(wc -l < "$STUB_LOG" | tr -d ' ')" ] \
  || fail "退出登录不是最后一步"
ok "三台都撤了、座机排最后、退出登录收尾"
printf '%s\n' "$OUT6" | grep -q '升级过 09-30 那版座机程序' || fail "撤座机时没打那句提醒"
ok "撤座机前打了「要升级过 09-30 那版才会自己开蓝牙,否则关掉它连的 Wi-Fi 一分钟」"
printf '%s\n' "$OUT6" | grep -q '账号设备没撤' && fail "撤成功了却还说「没撤」"
ok "撤成功时不再提「去手机设置里撤」"

step "全过"
printf '沙箱:\n'
for b in "$BOX1" "$BOX2" "$BOX3" "$BOX4" "$BOX5" "$BOX6"; do printf '  %s\n' "$b"; done
printf '(留着给你看,确认完自己删:rm -rf /tmp/wb-wipe-rehearsal-*)\n'
