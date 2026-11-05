"""`provisiond.py` 里那点**落盘**逻辑的用例(2026-09-30)。

这一份原来一条用例都没有(文件头写着"逻辑全在 provision.py"),而 09-30 真机上那个
「换了账号还进旧账号的房」正好卡在它这一行合并写上 —— 所以至少把 device.json 这一段
守起来。bluez / nmcli 那些脏活照旧不测(Mac 上压根跑不起来),这里只碰:

- `save_device(patch, clear=…)`:删与写在同一次读-改-写里
- `link_now`:重新接入走的是 `provision.LINK_STALE` 那份清单(nmcli 用假的顶掉)

`provisiond` 顶上的 import 只有标准库 + netcfg + provision,dbus/gi 是懒加载的,
所以这一份在 Mac 上 import 得动(见 provisiond.py 文件头「为什么 import 都包着 try」)。
"""
import json
import os
import tempfile
import unittest

import provision
import provisiond


class 落盘(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "device.json")
        self.before = provisiond.STATE_FILE
        provisiond.STATE_FILE = self.path
        self.addCleanup(lambda: setattr(provisiond, "STATE_FILE", self.before))

    def 写下(self, state: dict) -> None:
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False)

    def 读回(self) -> dict:
        with open(self.path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def test_不给_clear_时还是合并写(self):
        """老行为一个字不动:换网、改名那几条走的还是合并。"""
        self.写下({"device_id": "d1", "token": "lan"})
        provisiond.save_device({"name": "新名字"})
        self.assertEqual(self.读回(), {"device_id": "d1", "token": "lan", "name": "新名字"})

    def test_clear_里的键在同一次写里删掉(self):
        self.写下({"device_id": "d1", "token": "lan", "ticket": {"room": "wb-old"}})
        provisiond.save_device({"relay_token": "wb_new"}, clear=("token", "ticket"))
        self.assertEqual(self.读回(), {"device_id": "d1", "relay_token": "wb_new"})

    def test_写出来还是_0600(self):
        provisiond.save_device({"relay_token": "wb_new"}, clear=("token",))
        self.assertEqual(oct(os.stat(self.path).st_mode & 0o777), "0o600")

    def test_重新接入清掉旧账号那几样(self):
        """★ 09-30 真机那个现象:旧票 7 天有效 + 领票先看票 = 换了账号还进旧房。"""
        self.写下({"device_id": "handset-01", "name": "座机话筒",
                   "token": "lan-tok", "workbench_http": "http://old-mac:8791",
                   "relay": "https://old-relay", "relay_base": "https://old-relay",
                   "relay_token": "wb_old", "identity": "wb-phone-handset-01",
                   "room": "wb-old", "ticket": {"room": "wb-old", "token": "jwt-old"}})
        ran = []
        before = provisiond.run_nmcli
        provisiond.run_nmcli = lambda argv, *a, **k: (ran.append(argv) or (0, ""))
        self.addCleanup(lambda: setattr(provisiond, "run_nmcli", before))

        done = provisiond.link_now(
            {"op": "link", "relay": "https://new-relay", "token": "wb_new"}, "handset-01")

        self.assertTrue(done["ok"], done)
        got = self.读回()
        for gone in provision.LINK_STALE:
            self.assertNotIn(gone, got, f"{gone} 应该在重新接入时被清掉")
        self.assertEqual(got["relay_token"], "wb_new")
        self.assertEqual(got["relay"], "https://new-relay")
        self.assertEqual(got["device_id"], "handset-01")
        self.assertEqual(got["name"], "座机话筒")
        # 记下之后要重启 phone-bridge,不然它还拿着内存里那份旧的
        self.assertTrue(any("phone-bridge" in " ".join(argv) for argv in ran))

    def test_那份不全的连清都不清(self):
        """缺地址或令牌:一个字都不动 —— 清了旧的又写不下新的等于把座机扔在半路。"""
        self.写下({"device_id": "d1", "token": "lan", "ticket": {"room": "wb-old"}})
        done = provisiond.link_now({"op": "link", "relay": "https://new-relay"}, "d1")
        self.assertFalse(done["ok"])
        self.assertEqual(self.读回()["ticket"], {"room": "wb-old"})


if __name__ == "__main__":
    unittest.main()
