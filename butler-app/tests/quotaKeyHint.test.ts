/**
 * **手机上那一行也说清为什么**(2026-10-02,卡 QK)。
 *
 * 卡 QA 之后那一行写的是「额度:读不到最新的,上次 04:27」—— 不骗人了,可**为什么**读不到、
 * 她能做什么,一个字都没有。那两句(「Claude 桌面没在跑」「点一下「接上」就实时」)
 * 由各家额度来源自己声明(工作台 `quota/liveSources.ts` 一处),服务端已经拼进 `line`,
 * **手机照念就够了** —— 这一侧不另写一套说法。
 *
 * 另一条:那颗入口键**只能在电脑前按**(`desk_only`),所以手机上一颗按钮都不画
 * (同这一页其余的修法:按了也够不着那台 Mac 的屏幕)。
 *
 * 这一份也兼**对照测试**(AGENTS.md「改契约的卡」):手机这份协议是照抄工作台的
 * (两个工程互不 import),所以**读那个文件比对**。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentQuotaView } from '../src/api/protocol';
import { quotaRowWords, quotaWords } from '../src/settings/AgentCapsSection';

/**
 * 工作台那一处声明的两句(`quota/liveSources.ts`)。
 *
 * ★ 2026-10-03(卡「Claude 额度一键接上」):第二句与那颗键的字都换了 —— 原来是
 * 「配一把 Claude 的密钥就能实时」/「去设置里配」。维护者照着那句话去配,发现要先在终端里跑一条
 * 命令,于是说:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」现在那一步只剩一颗「接上」键。
 * **手机这一侧一个字没动**:它照旧只念服务端拼好的那一句(下面最后一组读源头文件比对)。
 */
const STALE_WHY = 'Claude 桌面没在跑';
const LIVE_WHY = '点一下「接上」,在浏览器里用 Claude 账号授权一次就实时';

/** 服务端过线那一档顶上来的那一份(`agentQuota.ts` 的 `dated`,三段都在)。 */
const OVER_THE_LINE: AgentQuotaView = {
  id: 'claude',
  title: 'Claude',
  state: 'numbers',
  line: `读不到最新的,上次 04:27 · ${STALE_WHY} · ${LIVE_WHY}`,
  short: '读不到最新的,上次 04:27',
  stale: true,
  read_at: '2026-10-02T04:27:40.000Z',
  stale_hint: {
    why: STALE_WHY,
    live: {
      why: LIVE_WHY,
      fix: { label: '去接上', at: { group: 'agents', row: 'claude_api' }, desk_only: true },
    },
  },
};

/** 没有更实时来源的那一家(今天从窗口上读的那几家全是这一档)。 */
const NO_LIVE_SOURCE: AgentQuotaView = {
  id: 'manus',
  title: 'Manus',
  state: 'numbers',
  line: '读不到最新的,上次昨晚 20:42',
  short: '读不到最新的,上次昨晚 20:42',
  stale: true,
  read_at: '2026-10-01T12:42:00.000Z',
};

describe('手机那一行:说清为什么,但一颗按钮都不画', () => {
  it('★那一句原样摆上去,三段都在,一个百分比都没有', () => {
    expect(quotaWords(OVER_THE_LINE))
      .toBe(`额度:读不到最新的,上次 04:27 · ${STALE_WHY} · ${LIVE_WHY}`);
    expect(quotaWords(OVER_THE_LINE)).not.toContain('%');
    // 「没接上」是「从没接上」的说法 —— 这一家读到过数,不许那么写。
    expect(quotaWords(OVER_THE_LINE)).not.toContain('没接上');
  });

  it('★没有更实时来源的那一家只说「上次 HH:MM」—— 不凭空多一句(D13)', () => {
    expect(quotaWords(NO_LIVE_SOURCE)).toBe('额度:读不到最新的,上次昨晚 20:42');
    expect(NO_LIVE_SOURCE.stale_hint).toBeUndefined();
  });

  it('★那一行上不出现任何密钥、也不出现技术词', () => {
    const words = quotaWords(OVER_THE_LINE) ?? '';
    expect(words).not.toMatch(/sk-/);
    expect(words).not.toContain('setup-token');
    expect(words).not.toContain('API Key');
  });

  it('★那颗键是「只能在电脑前做」的那一档,手机这一侧根本不读它 —— 细账那一句照旧出不来', () => {
    expect(OVER_THE_LINE.stale_hint?.live?.fix?.desk_only).toBe(true);
    expect(quotaRowWords(OVER_THE_LINE)).toBeUndefined();
  });
});

describe('对照:与工作台那一处同一个字段、同一句话', () => {
  const source = readFileSync(resolve(__dirname, '../../workbench-plugin/src/protocol.ts'), 'utf8');
  const decl = readFileSync(resolve(__dirname, '../../workbench-plugin/src/quota/liveSources.ts'), 'utf8');
  const server = readFileSync(resolve(__dirname, '../../workbench-plugin/src/server/agentQuota.ts'), 'utf8');
  const copy = readFileSync(resolve(__dirname, '../src/api/protocol.ts'), 'utf8');

  it('★那两句话的出处是工作台那一处声明(读源头文件比对,不是手机这边编的)', () => {
    expect(decl).toContain(`export const CLAUDE_STALE_WHY = '${OVER_THE_LINE.stale_hint!.why}'`);
    expect(decl).toContain(`export const CLAUDE_LIVE_WHY = '${OVER_THE_LINE.stale_hint!.live!.why}'`);
  });

  it('★服务端确实把这两句拼进了 `line`(手机念的就是它)', () => {
    expect(server).toContain('...staleWords(view)');
    expect(server).toMatch(/function staleWords\(view: AgentQuotaView\)/);
    // 那张按家名写死的表没了(卡 QK:声明搬进了各家额度来源那一处)。
    expect(server).not.toContain('const STALE_HINTS');
  });

  it('★手机这份副本里那一格在,形状跟工作台对得上', () => {
    expect(copy).toContain('stale_hint?: {');
    expect(source).toContain('stale_hint?: QuotaStaleHint');
    expect(source).toContain('export interface QuotaStaleFix');
  });
});
