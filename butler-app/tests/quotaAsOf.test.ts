/**
 * **手机上那一行也不许让陈旧的数冒充当下**(2026-10-02,卡 QA)。
 *
 * 现场:电脑上的 Claude 额度挂着 Claude 桌面端 **04:27** 那个样本算出来的 100%,到 21:3x 还在。
 * 手机这一侧读的是同一份判断(`/state.agent_quota` 的 `AgentQuotaView`),所以服务端过线那一档
 * 把 `left_pct` / `left` / `windows` 一并摘掉之后,这里**必须一个百分比都写不出来**。
 *
 * 这一份也兼**对照测试**(AGENTS.md「改契约的卡」):手机这一份协议是照抄工作台的(两个工程互不
 * import),所以**读那个文件比对** —— 不写「逐字相同」的注释当同步。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentQuotaView } from '../src/api/protocol';
import { quotaRowWords, quotaWords } from '../src/settings/AgentCapsSection';

/** 服务端过线那一档顶上来的那一份(`agentQuota.ts` 的 `dated`,与工作台一字不差)。 */
const OVER_THE_LINE: AgentQuotaView = {
  id: 'claude',
  title: 'Claude',
  state: 'numbers',
  line: '读不到最新的,上次 04:27 · Claude 桌面没在跑',
  short: '读不到最新的,上次 04:27',
  stale: true,
  read_at: '2026-10-02T04:27:40.000Z',
};

describe('手机那一行:过线不出百分比', () => {
  it('★那一句原样摆上去,里面带着截至时刻,一个百分比都没有', () => {
    expect(quotaWords(OVER_THE_LINE)).toBe('额度:读不到最新的,上次 04:27 · Claude 桌面没在跑');
    expect(quotaWords(OVER_THE_LINE)).not.toContain('%');
    // 「没接上」是「从没接上」的说法 —— 这一家读到过数,不许那么写。
    expect(quotaWords(OVER_THE_LINE)).not.toContain('没接上');
  });

  it('★细账那一句也出不来(服务端把 windows 摘掉了,这里就没有百分比可写)', () => {
    expect(quotaRowWords(OVER_THE_LINE)).toBeUndefined();
  });

  it('线以内照旧:那一句里带着「截至 HH:MM」,百分比照说', () => {
    const inside: AgentQuotaView = {
      id: 'claude', title: 'Claude', state: 'numbers', level: 'ok',
      line: '本周还剩约 82% · 截至 21:00', left_pct: 82,
    } as AgentQuotaView;
    expect(quotaWords(inside)).toBe('额度:本周还剩约 82% · 截至 21:00');
  });
});

describe('对照:与工作台那份协议同一套说法', () => {
  const source = readFileSync(
    resolve(__dirname, '../../workbench-plugin/src/protocol.ts'),
    'utf8',
  );
  const server = readFileSync(
    resolve(__dirname, '../../workbench-plugin/src/server/agentQuota.ts'),
    'utf8',
  );

  it('★过线那一格写的字是工作台那一句(读源头文件比对)', () => {
    expect(source).toContain("export const QUOTA_STALE_VALUE = '读不到最新的'");
    expect(OVER_THE_LINE.short).toContain('读不到最新的');
  });

  it('★过线那一档确实把百分比那几格摘掉了(不是只靠手机这边不画)', () => {
    // 服务端一处判:`dated` 里把 left_pct / left / reset_at / level / windows 一起解构丢掉。
    expect(server).toMatch(/const \{ left_pct: _pct, left: _left, reset_at: _reset, level: _level, windows: _windows, \.\.\.rest \} = view/);
  });

  it('★手机这份副本里 `stale` 与 `read_at` 两格都在(服务端靠它们说话)', () => {
    const copy = readFileSync(resolve(__dirname, '../src/api/protocol.ts'), 'utf8');
    expect(copy).toMatch(/read_at\?: string/);
    expect(copy).toMatch(/stale\?: boolean/);
  });
});
