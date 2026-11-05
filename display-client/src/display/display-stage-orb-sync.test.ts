/**
 * ★ **展示台粒子球的态不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:展示台 `displayStage.ts` 的态推算(「照抄手机端」)从手机 `butler-app/src/swarm/orbState.ts`
 * 的 `signalsFromState` + `stageModeOf` 抄来,**去掉了说话 / 聆听 / 在想**(展示台没人对它说话)。
 * 靠注释互相指着,没有用例守着 —— 手机口径一改,这块屏的球色就悄悄不一样(电脑 / 手机 / 展示台
 * 三处球色本来就是事故高发区,见 2026-10-04「球的颜色一处算」)。
 *
 * 直接读手机源码比对(顶层子目录互不 import,只能读文本;范本
 * `display-client/src/swarm/swarmSource.test.ts`)。比对口径:
 *   · `SETTLED`(事项收场没)两张表逐字相同;
 *   · `particleModeOf` 的每一个 return 与手机 `stageModeOf` 里同名的分支逐字相同
 *     (手机多出来的 speaking / listening / thinking 三支是展示台没有的交互态,不算);
 *   · `isOpenFailure` 的判据逐字相同(展示台因 Task 的 status 可选多一层守卫,归一化)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PHONE_ORB = resolve(__dirname, '../../../butler-app/src/swarm/orbState.ts');
const DISPLAY_STAGE = resolve(__dirname, './displayStage.ts');

function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `源码里找不到 \`function ${name}(\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const openParen = source.indexOf('(', at);
  let depth = 0;
  let i = openParen;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const open = source.indexOf('{', i);
  depth = 0;
  i = open;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(open + 1, i);
}

/** 一段函数体 → 只留 return 行、去掉分号与 `=== true`。 */
function returns(body: string): string {
  return body.split('\n')
    .filter(line => line.trim().startsWith('return { mode:'))
    .map(line => line.replace(/;+\s*$/u, '').trim().replace(/=== true/g, ''))
    .join('\n');
}

describe('★ 粒子球的态:手机那份是源头,展示台这份去掉交互态照抄', () => {
  it('SETTLED(事项收场了没)两张表逐字相同', () => {
    const phone = readFileSync(PHONE_ORB, 'utf8');
    const display = readFileSync(DISPLAY_STAGE, 'utf8');
    const phoneSet = /new Set\(\[([^\]]*)\]\)/.exec(phone)?.[1] ?? '';
    const displaySet = /new Set\(\[([^\]]*)\]\)/.exec(display)?.[1] ?? '';
    expect(phoneSet, '手机 orbState.ts 里找不到 SETTLED 的 Set 字面量').not.toBe('');
    expect(displaySet, '展示台 displayStage.ts 里找不到 SETTLED 的 Set 字面量').not.toBe('');
    expect([...displaySet.matchAll(/'([^']+)'/g)].map(m => m[1] as string)).toEqual([...phoneSet.matchAll(/'([^']+)'/g)].map(m => m[1] as string));
  });

  it('★ particleModeOf 的每个 return 与手机 stageModeOf 同名的分支逐字相同(手机多的是说话 / 聆听 / 在想三支)', () => {
    const phone = readFileSync(PHONE_ORB, 'utf8');
    const display = readFileSync(DISPLAY_STAGE, 'utf8');
    const phoneReturns = returns(functionBody(phone, 'stageModeOf'));
    const displayReturns = returns(functionBody(display, 'particleModeOf'));
    expect(displayReturns, '展示台 particleModeOf 与手机 stageModeOf 同名分支漂了 —— 以手机为源头收成一样').toBe(phoneReturns);
  });

  it('★ isOpenFailure 判据逐字相同(展示台因 Task.status 可选多一层守卫,归一化掉)', () => {
    const phone = readFileSync(PHONE_ORB, 'utf8');
    const display = readFileSync(DISPLAY_STAGE, 'utf8');
    // 整段压成一行比(展示台的 return 是多行折行写的,逐行比会误报);守卫差异只归一化那一层,注释剥掉。
    const squash = (body: string): string => body
      .replace(/\/\/[^\n]*/g, '')
      .replace(/;+\s*$/gm, '')
      .replace(/task\.status !== undefined && /g, '')
      .replace(/\s+/g, '');
    expect(squash(functionBody(display, 'isOpenFailure'))).toBe(squash(functionBody(phone, 'isOpenFailure')));
  });
});
