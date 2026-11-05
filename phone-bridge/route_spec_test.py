"""连接路线规格(docs/规格-连接路线-2026-10-21.md)的对照用例 —— Python 这一半。

用例只有一份,在手机那边:butler-app/src/channel/routeSpec.cases.json。这里按相对路径读**源头那个文件**,
不抄一份;两边逐步比对的都是文件里写的期望值,一边的实现改了另一边没改,那一边红。
比对用排好键的 JSON 文本(与 TS 那边同一个写法),`1` 与 `True`、缺一格与 `None` 都分得出来。
"""
import copy
import json
import os
import unittest

import route_spec

CASES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "butler-app", "src", "channel", "routeSpec.cases.json")


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def load_spec() -> dict:
    with open(CASES_PATH, encoding="utf-8") as fh:
        return json.load(fh)


class RouteSpecTest(unittest.TestCase):
    spec = load_spec()

    def test_constants_match_cases_file(self):
        self.assertEqual(canonical(route_spec.ROUTE_SPEC), canonical(self.spec["constants"]))

    def test_at_least_twelve_cases_with_unique_names(self):
        names = [c["name"] for c in self.spec["cases"]]
        self.assertGreaterEqual(len(names), 12)
        self.assertEqual(len(set(names)), len(names))

    def test_every_case_step_by_step(self):
        for case in self.spec["cases"]:
            with self.subTest(case=case["name"]):
                facts = {**copy.deepcopy(self.spec["default_facts"]), **copy.deepcopy(case["facts"])}
                state = route_spec.initial_route_state(facts)
                for index, step in enumerate(case["steps"]):
                    where = f"{case['name']} · 第 {index + 1} 步({step['event']['type']})"
                    before = canonical(state)
                    result = route_spec.decide_route(state, step["event"])
                    self.assertEqual(canonical(state), before, f"{where}:不许改传进来的状态")
                    self.assertEqual(canonical(result["decision"]), canonical(step["expect"]), where)
                    for key, value in step.get("expect_facts", {}).items():
                        self.assertEqual(canonical(result["state"]["facts"][key]), canonical(value),
                                         f"{where} · facts.{key}")
                    state = result["state"]


if __name__ == "__main__":
    unittest.main()
