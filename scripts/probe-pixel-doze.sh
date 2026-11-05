#!/usr/bin/env bash
# 探针:Pixel 熄屏进 Doze 之后,今天这条「常驻前台服务 + LiveKit 房间」的路能不能及时响铃(2026-10-20)。
#
# 只读台账与工人日志,不改 ~/.dsh 下任何文件;手机上只动 adb 能撤回的三样(battery unplug / deviceidle
# force-idle / svc wifi),收尾 `restore` 全部撤回。触发走 8791 现成的运维口 POST /ring/test(排一通真电话,
# item_id 固定 ring-test,不碰看板)。
#
# 用法(每一步一条命令,配合 docs/交接-1020-Pixel熄屏响铃实测.md):
#   scripts/probe-pixel-doze.sh env               # 环境事实(设备、包、服务、白名单、房间)
#   scripts/probe-pixel-doze.sh offset            # 手机 - Mac 时钟差(ms),写进 $PROBE_DIR/offset.txt
#   scripts/probe-pixel-doze.sh logcat-start      # 后台抓 logcat -v epoch 到 $PROBE_DIR/logcat-all.log
#   scripts/probe-pixel-doze.sh status            # 一行:Doze 态 / 屏 / 前台服务 / 唤醒锁 / 房里有谁
#   scripts/probe-pixel-doze.sh watch <秒> [间隔]  # 每隔几秒记一行 status 到 $PROBE_DIR/watch.log(看房间有没有断)
#   scripts/probe-pixel-doze.sh doze-enter        # battery unplug → 熄屏 → deviceidle force-idle,回 IDLE 才算进去
#   scripts/probe-pixel-doze.sh doze-keep         # 不是 IDLE 就再 force-idle 一次
#   scripts/probe-pixel-doze.sh trigger <标签> [最多等几秒,默认 300]
#                                                 # 记 Mac 时刻 → POST /ring/test → 等台账 ringing_at → 等 logcat 里手机起铃
#                                                 # → 算延迟,追加一行到 $PROBE_DIR/trials.tsv
#   scripts/probe-pixel-doze.sh net-off | net-on  # 关 / 开 Wi‑Fi(断网 2 分钟那一组)
#   scripts/probe-pixel-doze.sh restore           # deviceidle unforce + battery reset
#   scripts/probe-pixel-doze.sh report            # 把 trials.tsv 打成表
#   scripts/probe-pixel-doze.sh logcat-stop
set -u

PKG="${PKG:-ai.ben.butler}"
WB="${WB:-http://127.0.0.1:8791}"
LEDGER="${LEDGER:-$HOME/.dsh/workbench/call-out.json}"
WORKER_LOG="${WORKER_LOG:-$HOME/.dsh/workbench/logs/channel-worker.log}"
PROBE_DIR="${PROBE_DIR:-/tmp/probe-pixel-doze}"
mkdir -p "$PROBE_DIR"

now_mac() { python3 -c 'import time; print(f"{time.time():.3f}")'; }

offset_ms() {
  # 手机比 Mac 快多少毫秒(6 次采样,取 RTT 最小的一次)。
  python3 - <<'PY'
import subprocess, time
best = None
for _ in range(6):
    t0 = time.time()
    p = subprocess.run(['adb', 'shell', 'echo $EPOCHREALTIME'], capture_output=True, text=True).stdout.strip()
    t1 = time.time()
    rtt, off = t1 - t0, float(p) - (t0 + t1) / 2
    if best is None or rtt < best[0]:
        best = (rtt, off)
print(f"{best[1]*1000:.1f} {best[0]*1000:.1f}")
PY
}

cmd_env() {
  echo "## adb"; adb devices -l | sed -n 2p
  echo "## android"; echo "release=$(adb shell getprop ro.build.version.release) sdk=$(adb shell getprop ro.build.version.sdk) build=$(adb shell getprop ro.build.id)"
  echo "## app"; adb shell dumpsys package "$PKG" | grep -E "versionName|versionCode|lastUpdateTime|pkgFlags" | head -4
  echo "pid=$(adb shell pidof "$PKG" || echo '(没在跑)')"
  echo "## ring service"; adb shell "dumpsys activity services $PKG" | grep -E "RingStandbyService|isForeground" | head -2
  echo "## whitelist"; adb shell dumpsys deviceidle whitelist | grep -i "$PKG" || echo "(不在省电白名单)"
  echo "bucket=$(adb shell am get-standby-bucket "$PKG")"
  echo "## appops"; adb shell "appops get $PKG" | grep -E "USE_FULL_SCREEN_INTENT|WAKE_LOCK|START_FOREGROUND"
  echo "## deviceidle"; adb shell dumpsys deviceidle | grep -E "mState=|mForceIdle|mScreenOn|mCharging|mNetworkConnected"
  echo "## battery"; adb shell dumpsys battery | grep -E "AC powered|USB powered|level"
  echo "## room"; curl -s -m 5 "$WB/channel/status" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("participants", d.get("participants"), "worker", d.get("process",{}).get("pid"))'
  echo "## call config"; curl -s -m 5 "$WB/call/config"; echo
}

cmd_offset() {
  read -r off rtt < <(offset_ms)
  echo "$off" > "$PROBE_DIR/offset.txt"
  echo "phone_minus_mac_ms=$off rtt_ms=$rtt"
}

cmd_logcat_start() {
  adb logcat -c
  nohup adb logcat -v epoch -v uid > "$PROBE_DIR/logcat-all.log" 2>&1 &
  echo $! > "$PROBE_DIR/logcat.pid"
  echo "logcat pid=$(cat "$PROBE_DIR/logcat.pid") → $PROBE_DIR/logcat-all.log"
}

cmd_logcat_stop() {
  [ -f "$PROBE_DIR/logcat.pid" ] && kill "$(cat "$PROBE_DIR/logcat.pid")" 2>/dev/null && echo "logcat 停了"
}

cmd_status() {
  local idle screen svc wl parts pid
  idle=$(adb shell dumpsys deviceidle | grep -E "mState=" | sed -E 's/^ *//')
  screen=$(adb shell dumpsys power | grep -E "^ *mWakefulness=" | head -1 | sed -E 's/^ *//')
  pid=$(adb shell pidof "$PKG" || echo "-")
  svc=$(adb shell "dumpsys activity services $PKG" | grep -c "RingStandbyService")
  wl=$(adb shell "dumpsys power" | grep -c "butler:ringStandby")
  parts=$(curl -s -m 5 "$WB/channel/status" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(p[:12] for p in d.get("participants",[])))' 2>/dev/null || echo "8791?")
  echo "$(date '+%T') mac=$(now_mac) $idle $screen pid=$pid ringsvc=$svc wakelock=$wl room=[$parts]"
}

cmd_watch() {
  local secs="${1:-120}" every="${2:-10}" end
  end=$(( $(date +%s) + secs ))
  while [ "$(date +%s)" -lt "$end" ]; do
    cmd_status | tee -a "$PROBE_DIR/watch.log"
    sleep "$every"
  done
}

cmd_doze_enter() {
  adb shell dumpsys battery unplug
  adb shell input keyevent KEYCODE_SLEEP
  sleep 3
  adb shell dumpsys deviceidle force-idle
  sleep 2
  cmd_status
}

cmd_doze_keep() {
  if ! adb shell dumpsys deviceidle | grep -q "mState=IDLE"; then
    adb shell dumpsys deviceidle force-idle
    sleep 2
  fi
  cmd_status
}

cmd_net_off() { adb shell svc wifi disable; sleep 2; adb shell "dumpsys connectivity | grep -E 'Active default network'"; }
cmd_net_on() { adb shell svc wifi enable; sleep 5; adb shell "dumpsys connectivity | grep -E 'Active default network'"; }

cmd_restore() {
  adb shell dumpsys deviceidle unforce
  adb shell dumpsys battery reset
  adb shell svc wifi enable
  sleep 2
  cmd_status
}

# 上一通 ring-test 收场了没(queued / ringing 时再按 /ring/test 是「停铃」语义,不会排新的一通)。
last_test_state() {
  python3 - "$LEDGER" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = [e for e in d['log'] if e.get('item_id') == 'ring-test']
print(t[-1]['state'] if t else 'none')
PY
}

# 台账里某一通的 queued_at / ringing_at / ended_at / state(ISO → epoch 秒)。
ledger_entry() {
  python3 - "$LEDGER" "$1" <<'PY'
import json, sys
from datetime import datetime, timezone
d = json.load(open(sys.argv[1]))
e = next((x for x in d['log'] if x['id'] == sys.argv[2]), None)
def ep(s):
    return '' if not s else f"{datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp():.3f}"
print('none' if e is None else f"{e['state']} {ep(e.get('queued_at'))} {ep(e.get('ringing_at'))} {ep(e.get('ended_at'))}")
PY
}

# 手机侧起铃的几步(logcat 手机时钟 ≥ since):通知贴出(PersonalContext 查这个包)/ 建铃声播放器(NuPlayerDriver,按
# App pid)/ 铃声真的出声(playState=Started, NotificationRingtone)/ 抬头通知可见(HUN)。基线实测它们相隔 ≤ 0.3 s。
phone_markers() {
  python3 - "$PROBE_DIR/logcat-all.log" "$1" "$2" <<'PY'
import re, sys
log, since, pid = sys.argv[1], float(sys.argv[2]), sys.argv[3]
want = {
    'notify': re.compile(r'PersonalContext: Personal Context disabled for package ai\.ben\.butler'),
    'player': re.compile(r'NuPlayerDriver\(.*\) created, clientPid\(' + re.escape(pid) + r'\)'),
    'tone':   re.compile(r'packageName=ai\.ben\.butler.*playState=Started.*NotificationRingtone|AudioPlayback\(packageName=ai\.ben\.butler, playId=\d+, uid=\d+, playState=Started'),
    'hun':    re.compile(r'HeadsUpNotificationVisibilityChange\(isVisible=true\)'),
    'wake':   re.compile(r'PowerManagerService: (Waking up|Powering on)'),
}
found = {}
with open(log, errors='replace') as f:
    for line in f:
        parts = line.split(None, 1)
        if not parts:
            continue
        try:
            ts = float(parts[0])
        except ValueError:
            continue
        if ts < since:
            continue
        for k, rx in want.items():
            if k not in found and rx.search(line):
                found[k] = ts
print(' '.join(f"{k}={found[k]:.3f}" for k in ('notify', 'player', 'tone', 'hun', 'wake') if k in found) or 'none')
PY
}

cmd_trigger() {
  local label="${1:?标签}" max_wait="${2:-300}" off pid state t0 resp call_id entry rang_at q_at r_at e_at st markers tone_phone tone_mac d_ring d_queue note
  off=$(cat "$PROBE_DIR/offset.txt" 2>/dev/null || echo 0)
  pid=$(adb shell pidof "$PKG" || echo 0)
  state=$(last_test_state)
  if [ "$state" = "queued" ] || [ "$state" = "ringing" ]; then
    echo "上一通试铃还 $state,再按会变成停铃;等它收场再来"; return 1
  fi
  echo "[$label] $(date '+%T') 触发前:$(cmd_status)"
  t0=$(now_mac)
  resp=$(curl -s -m 10 -X POST "$WB/ring/test")
  echo "[$label] mac_t0=$t0 resp=$resp"
  call_id=$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("call_id",""))')
  if [ -z "$call_id" ]; then echo "[$label] 没排出来"; return 1; fi
  # 等工人领走(ringing_at),最多 30 秒
  r_at=""
  for _ in $(seq 1 60); do
    entry=$(ledger_entry "$call_id"); read -r st q_at r_at e_at <<<"$entry"
    [ -n "$r_at" ] && break
    sleep 0.5
  done
  echo "[$label] 台账:state=$st queued_at=$q_at ringing_at=${r_at:-(还没领走)}"
  # 等手机起铃(logcat 里的几步),最多 max_wait 秒;同时记台账收场
  local since; since=$(python3 -c "print(f'{$t0 + $off/1000 - 0.2:.3f}')")
  local deadline=$(( $(date +%s) + max_wait )) tone=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    markers=$(phone_markers "$since" "$pid")
    tone=$(printf '%s' "$markers" | grep -oE 'tone=[0-9.]+' | cut -d= -f2)
    [ -n "$tone" ] && break
    sleep 1
  done
  entry=$(ledger_entry "$call_id"); read -r st q_at r_at e_at <<<"$entry"
  markers=$(phone_markers "$since" "$pid")
  if [ -n "$tone" ]; then
    tone_mac=$(python3 -c "print(f'{$tone - $off/1000:.3f}')")
    d_queue=$(python3 -c "print(f'{$tone_mac - $q_at:.2f}')")
    d_ring=$(python3 -c "print(f'{$tone_mac - ${r_at:-$q_at}:.2f}')")
    note="响了"
  else
    tone_mac=""; d_queue=""; d_ring=""
    note="$max_wait 秒内没响"
  fi
  echo "[$label] 手机侧(手机钟):$markers"
  echo "[$label] 结果:$note  排队→起铃 ${d_queue:-—} s,工人广播→起铃 ${d_ring:-—} s;台账收场 state=$st ended_at=${e_at:-—}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$(date '+%T')" "$call_id" "$q_at" "${r_at:-}" "${tone_mac:-}" "${d_queue:-}" "${d_ring:-}" "$st" "$markers" >> "$PROBE_DIR/trials.tsv"
}

cmd_report() {
  echo -e "label\ttime\tcall_id\tqueued_at\tringing_at\ttone_mac\tqueue→tone(s)\tring→tone(s)\tstate\tmarkers(phone clock)"
  cat "$PROBE_DIR/trials.tsv" 2>/dev/null
}

case "${1:-}" in
  env) cmd_env ;;
  offset) cmd_offset ;;
  logcat-start) cmd_logcat_start ;;
  logcat-stop) cmd_logcat_stop ;;
  status) cmd_status ;;
  watch) shift; cmd_watch "$@" ;;
  doze-enter) cmd_doze_enter ;;
  doze-keep) cmd_doze_keep ;;
  trigger) shift; cmd_trigger "$@" ;;
  net-off) cmd_net_off ;;
  net-on) cmd_net_on ;;
  restore) cmd_restore ;;
  report) cmd_report ;;
  markers) shift; phone_markers "${1:?since(手机钟 epoch)}" "${2:-$(adb shell pidof "$PKG")}" ;;
  *) sed -n 2,24p "$0"; exit 1 ;;
esac
