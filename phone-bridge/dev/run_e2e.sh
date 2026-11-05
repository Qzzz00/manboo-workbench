#!/usr/bin/env bash
# Mac 上跑一遍「工人发 ring → 派响铃 → 拿起 → 音轨互通 → 放下 → 结束」。
# 说明见同目录 README.md。需要:livekit-server、ffmpeg、装了 livekit 的 python。
set -uo pipefail
cd "$(dirname "$0")"

PY="${PY:-python3}"
OUT="${OUT:-/tmp/pb-e2e}"
rm -rf "$OUT" && mkdir -p "$OUT"

# 一段 3 秒的 440Hz,当作「他对着话筒说的话」。用 ffmpeg 生成,不额外引依赖。
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=660:duration=3" \
  -ar 48000 -ac 1 "$OUT/mic.wav" -y

# 声卡换成两根 ffmpeg 管子(audio.py 的 PB_RECORD_CMD / PB_PLAY_CMD 就是为这个留的)
export PB_RECORD_CMD="ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i $OUT/mic.wav -f s16le -ar 48000 -ac 1 -"
export PB_PLAY_CMD="ffmpeg -hide_banner -loglevel error -f s16le -ar 48000 -ac 1 -i - -y $OUT/earpiece.wav"
# 铃声:Mac 上不出声(七张卡同时在跑,不该突然响铃),而是把那段 wav 拷出来 ——
# 证明「放铃声那条命令真的带着铃声文件跑了」,而不是日志上一句「放不出」。
export PB_WAV_CMD="cp {file} $OUT/rang.wav"

echo "=== 起 livekit-server --dev ==="
livekit-server --dev >"$OUT/livekit.log" 2>&1 &
LK=$!
trap 'kill $LK 2>/dev/null; kill ${WK:-0} 2>/dev/null; kill ${HS:-0} 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  curl -sf http://127.0.0.1:7880 >/dev/null 2>&1 && break
  sleep 0.2
done

echo "=== 起假话筒(先进房,好让工人等得到) ==="
"$PY" fake_handset.py 4 12 >"$OUT/handset.log" 2>&1 &
HS=$!
sleep 2

echo "=== 起假工人 ==="
"$PY" fake_worker.py "$OUT/worker_heard.wav" >"$OUT/worker.log" 2>&1 &
WK=$!

wait $WK; WORKER_RC=$?
sleep 2
kill $HS 2>/dev/null

echo
echo "=== 假工人日志 ==="; cat "$OUT/worker.log"
echo "=== 假话筒日志 ==="; cat "$OUT/handset.log"

echo
echo "=== 铃到底响没响 ==="
if [ -f "$OUT/rang.wav" ]; then echo "  响了(放铃声的命令跑过:$OUT/rang.wav)"; RANG_RC=0
else echo "  没响"; RANG_RC=1; fi

echo
echo "=== 两个方向的声音(量能量,不看日志) ==="
"$PY" - "$OUT/worker_heard.wav" "$OUT/earpiece.wav" <<'PYEOF'
import struct, sys, wave

def energy(path):
    try:
        with wave.open(path, "rb") as w:
            raw = w.readframes(w.getnframes())
    except Exception as err:
        return None, f"读不了({err})"
    if not raw:
        return 0, "一帧都没有"
    peak = max(abs(v) for v in struct.unpack(f"<{len(raw)//2}h", raw[:len(raw)//2*2]))
    return peak, f"{len(raw)//2/48000:.2f} 秒,峰值 {peak}"

ok = True
for label, path in (("他 → 她(话筒的麦克风到了工人)", sys.argv[1]),
                    ("她 → 他(工人的声音到了听筒)", sys.argv[2])):
    peak, said = energy(path)
    good = peak is not None and peak > 1000
    ok = ok and good
    print(f"  {'通' if good else '不通'}  {label}:{said}")
sys.exit(0 if ok else 1)
PYEOF
AUDIO_RC=$?

echo
if [ "$WORKER_RC" = "0" ] && [ "$AUDIO_RC" = "0" ] && [ "$RANG_RC" = "0" ]; then
  echo "全程通过(工人退出码 0,铃响过,两个方向都有声音)。产物在 $OUT"
  exit 0
fi
echo "没通过:工人退出码 $WORKER_RC,铃 $RANG_RC,音频检查 $AUDIO_RC。产物在 $OUT"
exit 1
