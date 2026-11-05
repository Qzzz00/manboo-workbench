/**
 * **手机上 Antigravity 那一行的细账**(卡 AG 做的 `quotaRowWords`;2026-09-27 卡 AN 补钉两端对得上)。
 *
 * 手机那一行原来只说 `line` 一句(「额度:还剩约 98%」,说的是最紧的那一行),后面补一句照它页面怎么列的细账。
 * 卡 AN 把 Antigravity 改成以「直接问它自己在本机的语言服务」为主之后,顶上来的还是**同一副骨架**
 * (`AgentQuotaView.windows`),所以这一句一个字都不用改 —— 这几例就是钉这一点。
 */
import { describe, expect, it } from "vitest";
import type { AgentQuotaView } from "../src/api/protocol";
import { quotaRowWords } from "../src/settings/AgentCapsSection";

/** 原生那条路顶上来的那一份(与工作台 `antigravityNativeView` 出来的一字不差)。 */
const NATIVE: AgentQuotaView = {
  id: "antigravity",
  title: "Antigravity",
  state: "numbers",
  level: "ok",
  line: "还剩约 98%",
  source: "10:30 直接问 Antigravity 在本机的语言服务读到的:…",
  windows: [
    { group: "Gemini Models", label: "Weekly Limit Remaining", left_pct: 100 },
    { group: "Gemini Models", label: "Five Hour Limit Remaining", left_pct: 98 },
    { group: "Claude and GPT models", label: "Weekly Limit Remaining", left_pct: 100 },
    { group: "Claude and GPT models", label: "Five Hour Limit Remaining", left_pct: 100 },
  ],
};

describe("quotaRowWords", () => {
  it("★四行两组照它页面怎么列就怎么列地写成一句(与电脑上那四条横条同一份数)", () => {
    expect(quotaRowWords(NATIVE)).toBe(
      "Gemini Models:Weekly Limit Remaining 100% · Five Hour Limit Remaining 98%;" +
        "Claude and GPT models:Weekly Limit Remaining 100% · Five Hour Limit Remaining 100%",
    );
  });

  it("只有一行的那几家不出这一句(`line` 已经说完了,再写一遍是噪音)", () => {
    expect(quotaRowWords({ ...NATIVE, windows: [{ label: "周", left_pct: 62 }] })).toBeUndefined();
    expect(quotaRowWords({ id: "x", title: "X", state: "numbers", line: "还剩约 62%" })).toBeUndefined();
  });

  it("没分组的那几家(豆包办公两扇窗)照旧不写组名", () => {
    const doubao: AgentQuotaView = {
      id: "doubao", title: "豆包办公", state: "numbers", line: "还剩约 62%",
      windows: [{ label: "当前时段", left_pct: 81 }, { label: "近 7 天", left_pct: 62 }],
    };
    expect(quotaRowWords(doubao)).toBe("当前时段 81% · 近 7 天 62%");
  });
});
