"""假工人:只做座机那条链上工人该做的四件事,一个模型、一份凭据都不要。

  1. 以 `wb-channel-worker` 的身份进房(真工人也是这个身份);
  2. 广播一条 `ring`(字段抄 channel-worker/src/callOut.ts 的 `RingSignal`);
  3. 收到 `{type:'call',action:'answer'}` → 回一条 ok + 广播 `ring_end(answered)`
     (真工人是同一个次序:先 ring_end 再开口,见 callOut.ts 的 answer());
  4. 接起之后往房里放一段 440Hz —— 代替"她说话",好让听筒那头有东西可量;
     同时把话筒推上来的那条轨录成 wav,好让我们量"他说的话过去了没有"。

收到 `hangup` 就收工、退出码 0。等不到就超时退出码 1。
"""
import asyncio
import json
import math
import os
import time
import struct
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sign_token import ticket  # noqa: E402  (同目录)

from livekit import rtc  # noqa: E402

RATE, CHANNELS, FRAME = 48000, 1, 480
TOPIC = "wb.rpc"
CALL_ID = "fake-call-1"


def tone_frame(phase: int, freq: int = 440) -> bytes:
    out = bytearray()
    for i in range(FRAME):
        out += struct.pack("<h", int(9000 * math.sin(2 * math.pi * freq * (phase + i) / RATE)))
    return bytes(out)


async def main() -> int:
    out_wav = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fake_worker_heard.wav"
    room = rtc.Room()
    done = asyncio.Event()
    answered = asyncio.Event()
    heard = {"frames": 0, "peak": 0}

    @room.on("track_subscribed")
    def _sub(track, publication, participant):
        print(f"[worker] 订上 {participant.identity} 的轨", flush=True)
        asyncio.create_task(record(track, out_wav, heard))

    def on_text(reader, identity: str) -> None:
        asyncio.create_task(handle(reader, identity))

    async def handle(reader, identity: str) -> None:
        raw = await reader.read_all()
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        if msg.get("type") != "call":
            return
        action = msg.get("action")
        print(f"[worker] ← {identity}:{action} {msg.get('call_id')}", flush=True)
        await room.local_participant.send_text(
            json.dumps({"id": msg.get("id"), "type": "call", "ok": True}),
            topic=TOPIC, destination_identities=[identity])
        if action == "answer":
            # 真工人在 answer() 里就是这个次序:先广播 ring_end,再开口。
            await room.local_participant.send_text(
                json.dumps({"type": "ring_end", "call_id": CALL_ID, "outcome": "answered"}),
                topic=TOPIC)
            answered.set()
        elif action == "hangup":
            done.set()

    room.register_text_stream_handler(TOPIC, on_text)
    await room.connect("ws://127.0.0.1:7880", ticket("wb-channel-worker")["token"])
    print("[worker] 进房了", flush=True)

    # 等话筒进房(真工人那边是「房里没有设备就不领电话」)
    for _ in range(100):
        if any(i.startswith("wb-phone-") for i in room.remote_participants.keys()):
            break
        await asyncio.sleep(0.1)
    else:
        print("[worker] 等不到话筒进房", flush=True)
        return 1

    await asyncio.sleep(0.5)
    # ★ 必须是**墙上时钟毫秒**(真工人用 Date.now())。第一版这里写的是事件循环的
    # 单调时钟,结果 until 是个接近 0 的数,派收到铃的下一秒就按"保险丝到点"停了 ——
    # 这一遍假环境抓到的第一个真 bug,记在这儿免得再犯。
    until = int(time.time() * 1000) + 60_000
    await room.local_participant.send_text(json.dumps({
        "type": "ring", "call_id": CALL_ID, "reason": "confirm", "item_id": "it-1",
        "title": "把首页文案改一版", "at": "2026-09-21T14:00:00+08:00",
        "silent": False, "until": until,
    }, ensure_ascii=False), topic=TOPIC)
    print("[worker] 铃发出去了", flush=True)

    # 接起之后才出声:真工人也是接起来才 say(ringOpener)。
    try:
        await asyncio.wait_for(answered.wait(), timeout=30)
    except asyncio.TimeoutError:
        print("[worker] 没人接", flush=True)
        return 1

    source = rtc.AudioSource(RATE, CHANNELS)
    track = rtc.LocalAudioTrack.create_audio_track("her-voice", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    print("[worker] 开始说话(440Hz)", flush=True)

    async def speak() -> None:
        phase = 0
        while not done.is_set():
            await source.capture_frame(rtc.AudioFrame(tone_frame(phase), RATE, CHANNELS, FRAME))
            phase += FRAME
    speaking = asyncio.create_task(speak())

    try:
        await asyncio.wait_for(done.wait(), timeout=40)
    except asyncio.TimeoutError:
        print("[worker] 等不到挂机", flush=True)
        speaking.cancel()
        return 1
    speaking.cancel()
    await asyncio.sleep(0.3)
    await room.disconnect()
    print(f"[worker] 收工。听到话筒 {heard['frames']} 帧,峰值 {heard['peak']}", flush=True)
    return 0


async def record(track, path: str, heard: dict) -> None:
    stream = rtc.AudioStream(track, sample_rate=RATE, num_channels=CHANNELS)
    with wave.open(path, "wb") as w:
        w.setnchannels(CHANNELS); w.setsampwidth(2); w.setframerate(RATE)
        async for event in stream:
            data = bytes(event.frame.data)
            w.writeframes(data)
            heard["frames"] += 1
            for i in range(0, len(data) - 1, 2):
                heard["peak"] = max(heard["peak"], abs(struct.unpack_from("<h", data, i)[0]))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
