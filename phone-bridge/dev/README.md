# Mac 上的假环境(没有派、没有 POP、没有工人也能跑一遍)

派现在不在网上(`pizero.local` 与 `172.20.10.x` 都不通,2026-09-21)。
这一套是为了让「工人发 ring → 派响铃 → 拿起听筒 → 音轨互通 → 放回去结束」
这条链在 Mac 上**真的跑一遍**,而不是嘴上说通。

三件东西被换掉,**别的都是派上要跑的那一份代码**:

| 真机 | 假环境 | 换在哪 |
|---|---|---|
| 事务官工人(channel-worker,要模型/TTS/火山凭据) | `fake_worker.py`:只发 ring / 收 answer / 放一段 440Hz | 另一个进程 |
| POP 声卡(`arecord`/`aplay`) | `ffmpeg` 读一个 wav 当麦克风、写一个 wav 当听筒 | `PB_RECORD_CMD` / `PB_PLAY_CMD`(audio.py) |
| 叉簧开关(GPIO17) | 按时刻往同一个队列里塞 `hook_event` | `fake_handset.py` |

状态机、信号解析、RoomLink、动作循环(`popphone.run_phone`)跑的都是真的那一份。

## 跑

```bash
brew install livekit-server ffmpeg          # 一次
python3 -m venv .venv && .venv/bin/pip install -r ../requirements.txt
./run_e2e.sh
```

`run_e2e.sh` 会:起 `livekit-server --dev`(devkey/secret,7880)→ 起假工人 →
起假话筒 → 按时刻拿起/放下 → 最后**量两个 wav 的能量**,两边都有声音才算通。

## 为什么要量能量,而不是看日志上有没有 "track subscribed"

订上一条轨和听见声音是两件事:采样率对不上、帧长不够、管子反了,
日志全是绿的而听筒里一片寂静 —— 2026-08-21 那次「录到寂静」就是这么来的。
