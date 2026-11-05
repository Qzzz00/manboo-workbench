# 三入口同一组句子 · 1a 矩阵(2026-10-24)

- 1a 矩阵(卡 t-1fc4c898 原范围补齐):真隔离 DSH/插件 + SAY_REAL=真 Kimi 听懂; judge/sentences 原文件未改。
- 手机的 chatModel.ts 载不进来(Cannot find module '/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/协作A同事项接续/butler-app/src/api/protocol' imported from /Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/协作A同事项接续/butler-app/src/chat/chatModel.ts),手机那一列的回话只到「刚送到」那一下
- 电话两列(真音频/文字口)是 1b,未跑;s7 旁人插话如实 n/a。

| 句 | 电脑对话框 | 手机文字 | 电话 |
|---|---|---|---|
| p2 1b s2 音频原句(ASR 逗号+样品) | — 没跑 | — 没跑 | n/a(这一句不走这个入口) |
| p5 1b s5 音频原句(记3条逗号分隔) | — 没跑 | — 没跑 | n/a(这一句不走这个入口) |
| p6 1b s6 音频原句(哦对顺便,逗号) | ✔ 过 | ✔ 过 | n/a(这一句不走这个入口) |
| p4 1b s4 音频原句(ASR 把 Claude 剪一版听成客户简易版——记那件必须干净) | — 没跑 | — 没跑 | n/a(这一句不走这个入口) |

合计:电脑对话框 过 1 / 4;手机文字 过 1 / 4;电话 过 0 / 0。

## 逐格细节

### p6 · 电脑对话框

- 判定:✔ 过
- 轮次 1;推回 0 次
- 第 1 轮 她说:「周四发样片。哦，对，顺便再记一下，周五交发票。」
  - 回话原文:「已建下,记下了 2 条。」(4026 ms)
  - 服务端原话:「记下了 2 条。」
- 卡 2 张:
  - 「周四发样片」 todo · 没派
  - 「周五交发票」 todo · 没派

### p6 · 手机文字

- 判定:✔ 过
- 轮次 1;推回 0 次
- 第 1 轮 她说:「周四发样片。哦，对，顺便再记一下，周五交发票。」
  - 回话原文:「记下了 2 条。」(16031 ms)
- 卡 2 张:
  - 「周四发样片」 todo · 没派
  - 「周五交发票」 todo · 没派

