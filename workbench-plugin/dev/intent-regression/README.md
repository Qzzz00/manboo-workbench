# 回归集 harness:理解中枢「指哪张 / 做什么」

设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第七节;用例来源 `docs/回归集-事务官真实交代-2026-10-22至10-28.md`。

- `cases.ts`:回归集里**电脑入口**那几行,一行一条用例(原话、预置板、那一句之前的话、点名的文件、期望命令);
  原话只有梗概的标 `synopsis`。电话 / 手机 / API 入口的行留给 A2。
- `score.ts`:打分,只看命令,不看回话 —— 对 / 过度 / 不足 / 模糊 / 错(= 不足 + 过度,改派落成改名这类)。
  `tests/hub-intent-regression-score.test.ts` 管打分判据与用例表自洽。
- `run.mts` + `run.mjs`:在预置板上跑**真模型**(modelService 定的那一家,只读 `~/.dsh/workbench/model.json`),
  到「模型出了什么命令」为止,不执行、不碰板。`run.mjs` 先用 rolldown 把 `run.mts` 打成一个 .mjs 再跑(模型服务那一串里有 Node 剥类型剥不了的写法)。
- `report.ts`:跑完写同目录的 **`report.json`**(A3 发版门读)与 **`summary.md`**(人读)。

```bash
node dev/intent-regression/run.mjs --entrance desktop --repeat 3
```

在 `workbench-plugin/` 下跑。`--entrance` 只跑那一个入口;`--only <行的时间>` 只跑一行;`--repeat` 每行跑几遍(模型温度 0 也会抖,发版门看多遍);
`--out <文件>` 另存每一遍的明细。

`report.json` 契约(统筹 10-28 定):

```json
{ "at": "<ISO>", "entrances": ["desktop"], "total": 23, "passed": 23, "rate": 1,
  "rows": [{ "id": "10-28 09:35", "entrance": "desktop", "said": "…", "expect": ["reassign"], "got": ["reassign"], "verdict": "对", "note": "3 遍:对对对" }] }
```

- `verdict` 只有「对 / 过度 / 不足 / 模糊」,只有「对」算 passed,`rate = passed / total`。
- 一行跑几遍取最差那一遍;打分里的「错」(不足 + 过度)记成「过度」并在 note 注明,模型没接上 / 坏结构记成「不足」。
- 各入口写同一份:按 `id`(回归集那一行)覆盖,不丢别的入口的行。

新的误判**先进 `cases.ts` 再修**(回归集文档那张表同步加一行)。
