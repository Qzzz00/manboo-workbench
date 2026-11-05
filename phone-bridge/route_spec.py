"""连接路线规格 —— 听筒这一份实现(纯函数,2026-10-21,局域网主路卡 M3)。

规格正文:docs/规格-连接路线-2026-10-21.md。手机那一份是 butler-app/src/channel/routeSpec.ts,
**同一签名、同一输出形状**;两边的用例都读 butler-app/src/channel/routeSpec.cases.json、逐步比对同一份期望值
(本目录 route_spec_test.py、手机那边 tests/routeSpec.test.ts)。改这里就要同时改那边,再改用例。

一句话:`decide_route(state, event) -> {"state", "decision"}`。设备每碰到一件事就喂一个事件进来,拿回
「该走哪条路、该连哪间房、现在要做哪几件事、多久之后再判」。不碰 IO、不看钟(时刻在事件的 `at` 里)、
不改传进来的状态;真正去探测、进房、要票的是调用方(pairing.py / room_link.py,卡 M5),照 `actions` 做,
再把结果当事件喂回来。

状态、事件、动作都是普通 dict,键名一律 snake_case,与 TS 那份逐字相同(用例按排好键的 JSON 文本比对)。
令牌不进这里:规格只认票的地址、房间名、到期时刻。
"""
import copy

#: 规格里的常数。用例文件 `constants` 一格一格比对它;意思见 TS 那份 ROUTE_SPEC 的注释。
ROUTE_SPEC = {
    "PROBE_TIMEOUT_MS": 800,
    "MDNS_BROWSE_MS": 1500,
    "RECHECK_LAN_MS": 60000,
    "RECHECK_CLOUD_MS": 30000,
    "RECHECK_NONE_MS": 30000,
    "RECHECK_AFTER_MISS_MS": 10000,
    "LEAVE_LAN_MISSES": 2,
    "BACK_TO_LAN_HOLD_S": 60,
    "TICKET_MIN_LEFT_S": 600,
    "LAN_URLS_MAX": 4,
}


def initial_route_state(facts: dict) -> dict:
    """`facts` 是设备跨启动存着的那一份(机器 id、地址候选表、确认过的网络、两张票……),原样复制一份进来。"""
    return {
        "facts": copy.deepcopy(facts),
        "network": {"kind": "none", "id": None},
        "now": 0,
        "route": "none",
        "joined": None,
        "pending": None,
        "home": None,
        "check": None,
        "asking": None,
        "asked": [],
        "misses": 0,
        "left_lan_at": None,
        "call": {"active": False, "call_id": None, "resume": False},
        "notice": None,
    }


def _present(value) -> bool:
    return isinstance(value, str) and value != ""


def _source_of(route: str) -> str:
    return "workbench" if route == "lan" else "relay"


class _Step:
    """一步的工作区:复制出来的状态 + 这一步攒下的动作。只在 decide_route 里用。"""

    def __init__(self, state: dict, at: int):
        self.s = copy.deepcopy(state)
        self.s["now"] = at
        self.acts = []

    def set_route(self, route):
        self.s["route"] = route

    def notify(self, notice):
        if self.s["notice"] == notice:
            return
        self.s["notice"] = notice
        self.acts.append({"type": "notify", "notice": notice})

    def notify_down(self, notice):
        """路断了的提示:通话中说的是「这一通断了」。"""
        if self.s["call"]["active"]:
            self.s["call"]["resume"] = False
            self.notify("call_dropped")
            return
        self.notify(notice)

    def usable(self, ticket) -> bool:
        return ticket is not None and ticket["expires_at"] - self.s["now"] >= ROUTE_SPEC["TICKET_MIN_LEFT_S"]

    def joined_route(self):
        joined = self.s["joined"]
        return joined["route"] if joined is not None else None

    def pending_route(self):
        pending = self.s["pending"]
        return pending["route"] if pending is not None else None

    def revoke(self):
        s = self.s
        s["facts"]["revoked"] = True
        if s["joined"] is not None:
            self.acts.append({"type": "leave", "route": s["joined"]["route"]})
        s["joined"] = None
        s["pending"] = None
        s["home"] = None
        s["check"] = None
        s["asking"] = None
        self.set_route("none")
        self.notify("revoked")

    def relay_unreachable(self):
        if self.s["joined"] is not None:
            self.set_route(self.s["joined"]["route"])
            return
        self.set_route("none")
        self.notify_down("offline")

    def go_cloud(self, force: bool):
        s = self.s
        if self.joined_route() == "cloud":
            s["pending"] = None
            self.set_route("cloud")
            return
        if self.pending_route() == "cloud":
            self.set_route("cloud")
            return
        if not s["facts"]["has_relay"]:
            # 没有出门线路:本机房间还连着、只是探测没答,就留着。
            if self.joined_route() == "lan" and not force:
                return
            if self.joined_route() == "lan":
                self.acts.append({"type": "leave", "route": "lan"})
                s["joined"] = None
            s["pending"] = None
            self.set_route("none")
            self.notify_down("no_way_out")
            return
        if self.joined_route() == "lan":
            s["left_lan_at"] = s["now"]
            if s["call"]["active"]:
                s["call"]["resume"] = True
        self.set_route("cloud")
        ticket = s["facts"]["tickets"]["cloud"]
        if self.usable(ticket):
            s["pending"] = {"route": "cloud", "step": "join", "url": ticket["url"], "room": ticket["room"]}
            self.acts.append({"type": "join", "route": "cloud", "url": ticket["url"], "room": ticket["room"],
                              "ticket": "relay"})
        else:
            s["pending"] = {"route": "cloud", "step": "ticket", "url": None, "room": None}
            self.acts.append({"type": "fetch_ticket", "route": "cloud", "source": "relay", "from": None})

    def want_lan(self):
        s = self.s
        home = s["home"]
        if home is None:
            return
        if home["url"] is None or home["room"] is None:
            # 8791 答了,但本机房间没起:走云房间,HTTP 照样直连。
            self.notify("local_room_down")
            self.go_cloud(False)
            return
        joined = s["joined"]
        if joined is not None and joined["route"] == "lan" and joined["url"] == home["url"] \
                and joined["room"] == home["room"]:
            s["pending"] = None
            self.set_route("lan")
            return
        if self.pending_route() == "lan":
            self.set_route("lan")
            return
        # 通话中、房间还在:不主动换路,挂断后再判。
        if s["call"]["active"] and joined is not None:
            return
        # 刚从本机房间退出来:先在云房间待满,免得门口来回跳。
        if self.joined_route() == "cloud" and s["left_lan_at"] is not None \
                and s["now"] - s["left_lan_at"] < ROUTE_SPEC["BACK_TO_LAN_HOLD_S"]:
            return
        self.set_route("lan")
        ticket = s["facts"]["tickets"]["lan"]
        if self.usable(ticket) and ticket["room"] == home["room"]:
            s["pending"] = {"route": "lan", "step": "join", "url": home["url"], "room": home["room"]}
            self.acts.append({"type": "join", "route": "lan", "url": home["url"], "room": home["room"],
                              "ticket": "workbench"})
        else:
            s["pending"] = {"route": "lan", "step": "ticket", "url": home["url"], "room": home["room"]}
            self.acts.append({"type": "fetch_ticket", "route": "lan", "source": "workbench", "from": home["http"]})

    def finish_check(self, found: bool, urgent: bool):
        s = self.s
        s["check"] = None
        if found:
            s["misses"] = 0
            self.want_lan()
            return
        s["misses"] += 1
        if s["route"] == "lan" and self.joined_route() == "lan" and not urgent \
                and (s["misses"] < ROUTE_SPEC["LEAVE_LAN_MISSES"] or s["call"]["active"]):
            return
        self.go_cloud(urgent)

    def begin_check(self, urgent: bool):
        s = self.s
        s["check"] = None
        net = s["network"]
        facts = s["facts"]
        if net["kind"] == "none":
            if s["joined"] is None:
                self.set_route("none")
                self.notify_down("offline")
            return
        if net["kind"] not in ("wifi", "ethernet") or net["id"] is None or not facts["has_lan_token"] \
                or facts["mac_id"] is None:
            self.finish_check(False, urgent)
            return
        if net["id"] in facts["trusted_networks"]:
            if facts["lan_urls"]:
                s["check"] = {"phase": "known", "urgent": urgent, "tried": list(facts["lan_urls"])}
                self.acts.append({"type": "probe", "urls": list(facts["lan_urls"]),
                                  "timeout_ms": ROUTE_SPEC["PROBE_TIMEOUT_MS"]})
            else:
                s["check"] = {"phase": "mdns", "urgent": urgent, "tried": []}
                self.acts.append({"type": "browse_mdns", "ms": ROUTE_SPEC["MDNS_BROWSE_MS"]})
            return
        # 没确认过的网络:按出门走;手机另外只听 mDNS(不带令牌问任何地址),看到配对过的那台再问一句。
        if facts["kind"] == "phone" and net["id"] not in facts["declined_networks"] \
                and net["id"] not in s["asked"] and s["asking"] != net["id"]:
            s["asking"] = net["id"]
            self.acts.append({"type": "browse_mdns", "ms": ROUTE_SPEC["MDNS_BROWSE_MS"]})
        self.finish_check(False, urgent)

    # —— 事件 ——

    def on_start(self, event):
        s = self.s
        s["network"] = copy.deepcopy(event["network"])
        s["route"] = "none"
        s["joined"] = None
        s["pending"] = None
        s["home"] = None
        s["check"] = None
        s["asking"] = None
        s["asked"] = []
        s["misses"] = 0
        s["left_lan_at"] = None
        s["call"] = {"active": False, "call_id": None, "resume": False}
        s["notice"] = None
        self.begin_check(True)

    def on_net_changed(self, event):
        s = self.s
        network = event["network"]
        changed = network["kind"] != s["network"]["kind"] or network["id"] != s["network"]["id"]
        s["network"] = copy.deepcopy(network)
        if changed:
            s["home"] = None
            s["asking"] = None
            if self.pending_route() == "lan":
                s["pending"] = None
        self.begin_check(changed)

    def on_tick(self, event):
        self.begin_check(False)

    def on_probe_result(self, event):
        s = self.s
        check = s["check"]
        if check is None or check["phase"] == "mdns":
            return
        mine = s["facts"]["mac_id"]
        answers = event.get("answers") or []
        if any(a.get("status") == "unauthorized" and _present(a.get("mac_id")) and a.get("mac_id") == mine
               for a in answers):
            self.revoke()
            return
        # 明说是别的机器的地址:从候选表里拿掉,下次不再把令牌发给它。
        others = [a["url"] for a in answers if _present(a.get("mac_id")) and a.get("mac_id") != mine]
        s["facts"]["lan_urls"] = [u for u in s["facts"]["lan_urls"] if u not in others]
        match = next((a for a in answers
                      if a.get("status") == "ok" and _present(a.get("mac_id")) and a.get("mac_id") == mine), None)
        if match is not None:
            s["home"] = {
                "http": match["url"],
                "url": match["lan_url"] if _present(match.get("lan_url")) else None,
                "room": match["room"] if _present(match.get("room")) else None,
                "network_id": s["network"]["id"],
            }
            rest = [u for u in s["facts"]["lan_urls"] if u != match["url"]]
            s["facts"]["lan_urls"] = ([match["url"]] + rest)[:ROUTE_SPEC["LAN_URLS_MAX"]]
            self.finish_check(True, check["urgent"])
            return
        if check["phase"] == "known":
            s["check"] = {"phase": "mdns", "urgent": check["urgent"], "tried": check["tried"]}
            self.acts.append({"type": "browse_mdns", "ms": ROUTE_SPEC["MDNS_BROWSE_MS"]})
            return
        self.finish_check(False, check["urgent"])

    def on_mdns_result(self, event):
        s = self.s
        check = s["check"]
        mine = s["facts"]["mac_id"]
        services = event.get("services") or []
        if check is not None and check["phase"] == "mdns":
            candidates = []
            for svc in services:
                if _present(svc.get("mac_id")) and svc.get("mac_id") != mine:
                    continue
                if svc["url"] in check["tried"] or svc["url"] in candidates:
                    continue
                candidates.append(svc["url"])
            if candidates:
                s["check"] = {"phase": "found", "urgent": check["urgent"], "tried": check["tried"] + candidates}
                self.acts.append({"type": "probe", "urls": candidates, "timeout_ms": ROUTE_SPEC["PROBE_TIMEOUT_MS"]})
            else:
                self.finish_check(False, check["urgent"])
            return
        if s["asking"] is not None:
            network_id = s["asking"]
            s["asking"] = None
            if network_id == s["network"]["id"] \
                    and network_id not in s["facts"]["trusted_networks"] \
                    and network_id not in s["facts"]["declined_networks"] \
                    and any(_present(svc.get("mac_id")) and svc.get("mac_id") == mine for svc in services):
                s["asked"].append(network_id)
                self.acts.append({"type": "ask_home_network", "network_id": network_id})

    def on_ticket_result(self, event):
        s = self.s
        if event.get("revoked") is True:
            self.revoke()
            return
        route = event["route"]
        got = event.get("ticket") if event.get("ok") and event.get("ticket") is not None else None
        if got is not None:
            s["facts"]["tickets"][route] = {"url": got["url"], "room": got["room"], "expires_at": got["expires_at"]}
        pending = s["pending"]
        # 续期或过时的回包:只存。
        if pending is None or pending["route"] != route or pending["step"] != "ticket":
            return
        if got is not None:
            if route == "lan":
                url = pending["url"] if pending["url"] is not None else got["url"]
                room = pending["room"] if pending["room"] is not None else got["room"]
            else:
                url, room = got["url"], got["room"]
            s["pending"] = {"route": route, "step": "join", "url": url, "room": room}
            self.acts.append({"type": "join", "route": route, "url": url, "room": room, "ticket": _source_of(route)})
            return
        s["pending"] = None
        if route == "lan":
            self.notify("local_room_down")
            self.go_cloud(False)
        else:
            self.relay_unreachable()

    def on_join_result(self, event):
        s = self.s
        route = event["route"]
        pending = s["pending"]
        if pending is None or pending["route"] != route or pending["step"] != "join":
            # 进了一间已经不要的房:退出来。
            if event.get("ok") and self.joined_route() != route:
                self.acts.append({"type": "leave", "route": route})
            return
        s["pending"] = None
        if event.get("ok"):
            previous = s["joined"]
            s["joined"] = {"route": route,
                           "url": pending["url"] if pending["url"] is not None else "",
                           "room": pending["room"] if pending["room"] is not None else ""}
            self.set_route(route)
            # 先在新房里续上这一通,再退旧房:反过来工人会当她挂了。
            if s["call"]["active"] and s["call"]["resume"]:
                self.acts.append({"type": "resume_call", "call_id": s["call"]["call_id"]})
                s["call"]["resume"] = False
            if previous is not None and previous["route"] != route:
                self.acts.append({"type": "leave", "route": previous["route"]})
            if route == "lan" or s["notice"] != "local_room_down":
                s["notice"] = None
            return
        if route == "lan":
            self.notify("local_room_down")
            self.go_cloud(False)
        else:
            self.relay_unreachable()

    def on_room_lost(self, event):
        s = self.s
        route = event["route"]
        if s["joined"] is None or s["joined"]["route"] != route:
            return
        s["joined"] = None
        if route == "lan":
            s["left_lan_at"] = s["now"]
        if s["call"]["active"]:
            s["call"]["resume"] = True
        # 通话中本机房间掉了:直接去云房间续上,不先探测。
        if route == "lan" and s["call"]["active"] and s["facts"]["has_relay"]:
            self.go_cloud(True)
            return
        self.begin_check(True)

    def on_call_state(self, event):
        s = self.s
        was = s["call"]["active"]
        call_id = event.get("call_id")
        if event.get("active"):
            if not was:
                s["call"] = {"active": True, "call_id": call_id, "resume": False}
            elif call_id is not None:
                s["call"]["call_id"] = call_id
            return
        s["call"] = {"active": False, "call_id": None, "resume": False}
        if was:
            self.begin_check(False)

    def on_home_network_answer(self, event):
        s = self.s
        facts = s["facts"]
        network_id = event["network_id"]
        facts["trusted_networks"] = [n for n in facts["trusted_networks"] if n != network_id]
        facts["declined_networks"] = [n for n in facts["declined_networks"] if n != network_id]
        if event.get("yes"):
            facts["trusted_networks"].append(network_id)
        else:
            facts["declined_networks"].append(network_id)
        if event.get("yes") and network_id == s["network"]["id"]:
            self.begin_check(False)

    # —— 输出 ——

    def decision(self) -> dict:
        return {"route": self.s["route"], "room": self.room(), "http": self.http(),
                "recheck_ms": self.recheck_ms(), "actions": self.acts}

    def room(self):
        s = self.s
        home = s["home"]
        if s["route"] == "lan" and home is not None and home["url"] is not None and home["room"] is not None:
            return {"url": home["url"], "room": home["room"], "ticket": "workbench"}
        cloud = s["facts"]["tickets"]["cloud"]
        if s["route"] == "cloud" and cloud is not None:
            return {"url": cloud["url"], "room": cloud["room"], "ticket": "relay"}
        return None

    def http(self):
        home = self.s["home"]
        return home["http"] if home is not None and self.s["misses"] == 0 else None

    def recheck_ms(self):
        s = self.s
        if s["facts"]["revoked"]:
            return None
        if s["route"] == "lan":
            return ROUTE_SPEC["RECHECK_AFTER_MISS_MS"] if s["misses"] > 0 else ROUTE_SPEC["RECHECK_LAN_MS"]
        if s["route"] == "cloud":
            if s["left_lan_at"] is not None:
                left = ROUTE_SPEC["BACK_TO_LAN_HOLD_S"] - (s["now"] - s["left_lan_at"])
                if left > 0:
                    return min(ROUTE_SPEC["RECHECK_CLOUD_MS"], left * 1000)
            return ROUTE_SPEC["RECHECK_CLOUD_MS"]
        return ROUTE_SPEC["RECHECK_NONE_MS"]


_HANDLERS = {
    "start": _Step.on_start,
    "net_changed": _Step.on_net_changed,
    "tick": _Step.on_tick,
    "probe_result": _Step.on_probe_result,
    "mdns_result": _Step.on_mdns_result,
    "ticket_result": _Step.on_ticket_result,
    "join_result": _Step.on_join_result,
    "room_lost": _Step.on_room_lost,
    "call_state": _Step.on_call_state,
    "home_network_answer": _Step.on_home_network_answer,
}


def decide_route(state: dict, event: dict) -> dict:
    """喂一个事件,回 `{"state": 新状态, "decision": {route, room, http, recheck_ms, actions}}`。"""
    step = _Step(state, event["at"])
    if step.s["facts"]["revoked"]:
        # 撤销之后什么都不做;撤销前发出去的进房如果成了,退出来。
        if event.get("type") == "join_result" and event.get("ok"):
            step.acts.append({"type": "leave", "route": event["route"]})
        return {"state": step.s, "decision": step.decision()}
    handler = _HANDLERS.get(event.get("type"))
    if handler is not None:
        handler(step, event)
    return {"state": step.s, "decision": step.decision()}
