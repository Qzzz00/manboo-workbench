/**
 * ★ **「这条会话」这件事的键,两端一个定法**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦ 第二条)。
 *
 * 现场(审计第二表第 15 条):同一个 `session:` 前缀在三处是三个意思 ——
 * 闸与账的 `session:<家>/<会话 id>`、座机台账的 `session:<会话 id>`、
 * `/state.waiting` 那一行的 `session:<家>:<会话 id>`。手机读的是第三种,
 * 而它自己在四处手拼这个串、用「只切第一刀」手拆 —— 分隔符是冒号,
 * 而窗口型那几条会话 id 自己带冒号(`window:825f1900`)。
 *
 * 现在三处同一种,手机这一侧只有 `api/protocol.ts` 的 {@link sessionJobId} / {@link sessionOfJob}。
 * 这一条**直接读插件源码**比对(顶层子目录互不 import):前缀与分隔符逐字相同、拼出来的串逐字相同。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_JOB_PREFIX, SESSION_JOB_SEP, sessionJobId, sessionOfJob } from '../src/api/protocol';

const PLUGIN_JOB_KEY = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'jobKey.ts');

function pluginConst(name: string): string {
  const source = readFileSync(PLUGIN_JOB_KEY, 'utf8');
  const hit = new RegExp(`export const ${name} = '([^']*)'`).exec(source);
  expect(hit, `插件 server/jobKey.ts 里找不到 ${name} —— 它改名了?这一条要跟着改`).not.toBeNull();
  return (hit as RegExpExecArray)[1] as string;
}

/** 插件 `sessionJobId` 的函数体(钉「拼法」本身,不只是两个常量)。 */
function pluginBuilderBody(): string {
  const source = readFileSync(PLUGIN_JOB_KEY, 'utf8');
  const at = source.indexOf('export function sessionJobId(');
  expect(at).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', at);
  return source.slice(at, end);
}

describe('★ 会话键:插件 server/jobKey.ts 是主人,手机这份跟着它', () => {
  it('★ 前缀与分隔符逐字相同', () => {
    expect(SESSION_JOB_PREFIX, '手机的 SESSION_JOB_PREFIX 与插件 jobKey.ts 漂了').toBe(pluginConst('SESSION_JOB_PREFIX'));
    expect(SESSION_JOB_SEP, '手机的 SESSION_JOB_SEP 与插件 jobKey.ts 漂了 —— 冒号那一版拆不开窗口型会话 id').toBe(pluginConst('SESSION_JOB_SEP'));
  });

  it('★ 拼法与插件那一处一致:前缀 + 家 + 分隔符 + 会话 id', () => {
    // 读插件那一处的函数体比对,而不是在注释里写「逐字相同」。
    expect(pluginBuilderBody()).toContain('${SESSION_JOB_PREFIX}${agent}${SESSION_JOB_SEP}${sessionId}');
    expect(sessionJobId('doubao', 'window:825f1900')).toBe('session:doubao/window:825f1900');
  });

  it('★ 窗口型那几条会话 id 自带冒号,照旧拆得对(冒号那一版正是在这里拆错的)', () => {
    expect(sessionOfJob('session:doubao/window:825f1900')).toEqual({ agent: 'doubao', sessionId: 'window:825f1900' });
    // 运行时发现的那一家:家名就是包标识(里面有点、没有斜杠)。
    expect(sessionOfJob(sessionJobId('com.anysphere.sand', 'window:5e0b9399')))
      .toEqual({ agent: 'com.anysphere.sand', sessionId: 'window:5e0b9399' });
  });

  it('★ 不是这一种的一律 undefined(不猜):别的前缀、老的冒号那一种、缺了半边的', () => {
    expect(sessionOfJob('question:q-1')).toBeUndefined();
    expect(sessionOfJob('session:claude:d999')).toBeUndefined();
    expect(sessionOfJob('session:/d999')).toBeUndefined();
    expect(sessionOfJob('session:claude/')).toBeUndefined();
  });
});
