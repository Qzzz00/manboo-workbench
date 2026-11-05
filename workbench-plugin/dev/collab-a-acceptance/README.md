# 协作A 真实验收架(2026-10-23)

卡 A `t-0c770bc0` 的真实执行验收:**真 DSH(3193/8993)+ 自有假 OpenAI 兼容端(19893)+ 本树现打的插件包 + 真 Kimi CLI(既有登录态)派活**。

- `instance.mts` — 隔离实例起停(配方派生自统筹已验的 key-final 验收,端口全换;临时 HOME 克隆 `~/.dsh` 的 node/runtime(APFS 克隆不改动真机那份);Kimi CLI 用 `KIMI_CODE_HOME` 直用真机现成登录态(**不复制凭据**),缓存落隔离目录;假 launchctl/osascript/open 拦住不碰真机服务)。
- `run.mts` — 场景:S1 模型目录 → S2 建事项(真 DSH 真模型往返)→ S3 同事项补句(同会话双历史)→ S4 turns 双历史 → S5 接续视图 → S6 继续这件事 → S7 record 零副作用 → S8 同号重放 → S9 失败与恢复 → S10 DSH 重启携带 → S11 用户改名保护 → S12 真 Kimi CLI 派活+接续探针。
- 跑:`node dev/collab-a-acceptance/run.mts`(从 workbench-plugin 目录)。证据落在 `./run-<时间戳>/evidence.json`。
- 浏览器腿(电脑/375/430 对真实例):`WB_TARGET=http://127.0.0.1:8993 node /tmp/collab-a-browser/cdp-real.mjs`(脚本在会话缓存;丢失则从交接重建)。

端口组(3193/8992/8993/8994/8996/8997/19893/19994-19996)只归本架;不碰日用 8791、root 三入口矩阵(3093/8893-8897)与 Gemini 组(3293/909x)。清理:脚本退出自动停自有进程并核端口清零。
