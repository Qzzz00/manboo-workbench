# 合成经典电话铃：440Hz+480Hz 双音（北美 ringback 标准音对），20Hz 颤音包络，
# 节奏 2 秒响 / 2 秒停（US 铃节奏缩短版），22050Hz 16-bit 单声道 WAV。
# 无版权问题：纯程序合成。输出给 display-client res/raw，MediaPlayer 循环播放。
import math
import struct
import sys
import wave

RATE = 22050
RING_S = 2.0
SILENCE_S = 2.0
F1, F2 = 440.0, 480.0
TREMOLO_HZ = 20.0
PEAK = 0.55
FADE_S = 0.015  # 响段首尾 15ms 淡入淡出，去咔哒声

out = sys.argv[1]
frames = bytearray()

ring_n = int(RING_S * RATE)
for i in range(ring_n):
    t = i / RATE
    carrier = 0.5 * (math.sin(2 * math.pi * F1 * t) + math.sin(2 * math.pi * F2 * t))
    # 颤音：0..1 的抬升余弦，让双音像老电话铃一样"打颤"
    trem = 0.5 * (1.0 - math.cos(2 * math.pi * TREMOLO_HZ * t))
    env = 1.0
    if t < FADE_S:
        env = t / FADE_S
    elif t > RING_S - FADE_S:
        env = (RING_S - t) / FADE_S
    sample = PEAK * carrier * trem * env
    frames += struct.pack('<h', int(max(-1.0, min(1.0, sample)) * 32767))

frames += b'\x00\x00' * int(SILENCE_S * RATE)

with wave.open(out, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(bytes(frames))

print(f'写出 {out}: {len(frames)} 字节, {RING_S + SILENCE_S}s 循环')
