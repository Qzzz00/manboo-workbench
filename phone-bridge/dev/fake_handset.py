"""假话筒:**跑的是派上那一份代码**,只换掉三样够不着的东西。

换掉的三样(理由见同目录 README):
  - 凭证:不走 `/pair/claim` + `/channel/token`,直接自己签一张(dev/sign_token.py);
  - 声卡:`PB_RECORD_CMD` / `PB_PLAY_CMD` 让 audio.py 用 ffmpeg 读写 wav;
  - 叉簧:按时刻往同一个队列里塞 `hook_event`,和 gpiozero 塞进去的一模一样。

真的那一份:`phone_state.transition`、`signals.parse_room_signal`、
`room_link.RoomLink`、`popphone.run_phone`。

用法:python fake_handset.py <来电到达后几秒拿起> <通话几秒后放下>

**「来电到达之后」而不是「开跑之后第几秒」**:按绝对时刻排的第一版在本机就翻了车
—— 假工人要等话筒进房才发 ring,而话筒进房要多久取决于 livekit-server 那一秒的心情,
于是「拿起」排在了来电前面,状态机在待机态老老实实忽略了它。
一个靠时间窗猜的写法在真机上一定会翻车(同 agent.ts 里那条老教训)。

2026-09-22 晚:等的那个信号从「铃真的在响」换成「那条 ring 进了队列」——
**派从今天起不响铃**(Ben 定),铃在手机 App 上。
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from audio import audio_device, prepare_sounds  # noqa: E402
from phone_state import hook_event  # noqa: E402
from popphone import run_phone, ticker  # noqa: E402
from room_link import RoomLink  # noqa: E402
from sign_token import ticket  # noqa: E402

class RingWatchQueue(asyncio.Queue):
    """和真机跑的是同一个队列,只是多记一件事:**那条 `ring` 到了没有**。

    2026-09-22 晚以前这里等的是那个铃声播放器在不在响 —— 铃真的在响就说明「他听见了」。
    从今天起**派不响铃**(Ben:「响铃应该是手机发出,话筒自己是用来对话的」),
    那个信号没有了,于是改成盯队列里那条 ring。

    为什么不去读状态机的状态:`popphone.run_phone` 自己持有那份状态,读它就要改
    run_phone 的签名 —— 而这份假环境存在的全部意义是**跑真的那一份代码**。
    队列是两边本来就共用的那个东西。
    """

    def __init__(self):
        super().__init__()
        self.rang = asyncio.Event()

    async def put(self, item):
        if isinstance(item, dict) and item.get("kind") == "ring" and item.get("silent") is not True:
            self.rang.set()
        await super().put(item)


#: 这台假话筒的身份与属性。**和真机一模一样**:身份 `wb-phone-<device_id>`,
#: 属性里 `wb_kind=handset`(真机上这两样是 8791 按设备令牌签的,见 channel.ts)。
IDENTITY = "wb-phone-pi-dev"
ATTRIBUTES = {"wb_device_id": "pi-dev", "wb_kind": "handset"}


async def main() -> int:
    pick_at = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
    hang_at = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0

    queue = RingWatchQueue()
    dev = audio_device()
    paths = prepare_sounds()

    room = RoomLink(queue, dev, log=lambda line: print(line, flush=True))
    one = ticket(IDENTITY, attributes=ATTRIBUTES, name="座机话筒")
    asyncio.create_task(room.run(lambda: one))
    asyncio.create_task(ticker(queue))

    async def hooks() -> None:
        # 等那条 `ring` 真的进了队列 —— 从 2026-09-22 晚起这就是「有一通电话在等他提机」
        # (派不响铃,铃在手机上)。
        try:
            await asyncio.wait_for(queue.rang.wait(), timeout=60)
        except asyncio.TimeoutError:
            print("[dev] 等了 60 秒没等到那条 ring", flush=True)
            os._exit(1)
        print("[dev] 来电到了(派不响铃,等提机)", flush=True)
        await asyncio.sleep(pick_at)
        print("[dev] 模拟:拿起听筒(叉簧松开)", flush=True)
        await queue.put(hook_event(off=True))
        await asyncio.sleep(hang_at)
        print("[dev] 模拟:放回去(叉簧压住)", flush=True)
        await queue.put(hook_event(off=False))
        await asyncio.sleep(1.5)
        await room.audio_off()
        print("[dev] 收工", flush=True)
        os._exit(0)
    asyncio.create_task(hooks())

    # http_base 给一个打不通的地址:这一遍走的是房间那条路,
    # 老路那几条 POST 本来就不该发出去(发了也只会 404,不影响结论)。
    await run_phone(queue, room, paths, "http://127.0.0.1:1", dev)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
