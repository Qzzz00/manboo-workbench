/**
 * ★ **展示台会话区灯色 / 额度判据不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 两处都是「电脑上现成的那一套,展示台各抄一份」:
 *   · 灯色 / 接上没有:电脑 `workbench-plugin/src/client/agentRegistryView.ts` 的
 *     `entryLamp` / `entryConnected`,展示台 `displayBoard.ts` 的 `lampOf` / `connectedOf`
 *     (displayBoard.ts 文件头自注「灯色 / 接上没有:… entryLamp / entryConnected」);
 *   · 额度三档:电脑 `workbench-plugin/src/client/quotaCells.ts` 的 `levelForPct`(阈值
 *     `warnPct ?? 20`),展示台 `displayBoard.ts` 的 `levelOf` + `QUOTA_WARN_PCT`(阈值钉死 20)。
 *
 * 直接读电脑源码取函数体比对(顶层子目录互不 import,只能读文本;范本
 * `display-client/src/swarm/swarmSource.test.ts`)。有意的两处差异在归一化里写清:
 * `connectedOf` 多一行 `self === true` 短路(登记表里事务官自己那条直接算接上);
 * `levelOf` 的阈值钉成常量 20(电脑那份可配、缺省 20)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUOTA_WARN_PCT } from './displayBoard';

const PLUGIN_VIEW = resolve(__dirname, '../../../workbench-plugin/src/client/agentRegistryView.ts');
const PLUGIN_QUOTA = resolve(__dirname, '../../../workbench-plugin/src/client/quotaCells.ts');
const DISPLAY_BOARD = resolve(__dirname, './displayBoard.ts');

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

const norm = (body: string): string => body.split('\n')
  .map(line => line.replace(/;+\s*$/u, '').trimEnd())
  .filter(line => line !== '')
  .join('\n');

/** 从 `export type <Name> = 'a' | 'b'` 取值集。 */
function typeUnion(source: string, name: string): string[] {
  const at = source.indexOf(`export type ${name} =`);
  expect(at, `源码里找不到 \`export type ${name}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const line = source.slice(at, source.indexOf('\n', at));
  return [...line.matchAll(/'([^']+)'/g)].map(m => m[1] as string);
}

describe('★ 灯色与额度判据:电脑那份是源头,展示台这份照抄', () => {
  it('灯色 lampOf 与电脑 entryLamp 逐行相同;灯色值集 FamilyLamp == EntryLamp', () => {
    const display = readFileSync(DISPLAY_BOARD, 'utf8');
    const plugin = readFileSync(PLUGIN_VIEW, 'utf8');
    expect(norm(functionBody(display, 'lampOf'))).toBe(norm(functionBody(plugin, 'entryLamp')));
    expect(typeUnion(display, 'FamilyLamp').sort()).toEqual(typeUnion(plugin, 'EntryLamp').sort());
  });

  it('接上没有 connectedOf 与电脑 entryConnected 逐行相同(展示台多一行 self 短路,归一化掉)', () => {
    const display = readFileSync(DISPLAY_BOARD, 'utf8');
    const plugin = readFileSync(PLUGIN_VIEW, 'utf8');
    const squash = (body: string): string => body.replace(/;+\s*$/gm, '').replace(/\s+/g, '');
    const mine = squash(functionBody(display, 'connectedOf').split('\n').filter(line => !line.includes('entry.self === true')).join('\n'));
    expect(mine).toBe(squash(functionBody(plugin, 'entryConnected')));
  });

  it('额度三档 levelOf 与电脑 levelForPct 逐行相同(阈值钉成 20,电脑可配、缺省 20)', () => {
    const display = readFileSync(DISPLAY_BOARD, 'utf8');
    const plugin = readFileSync(PLUGIN_QUOTA, 'utf8');
    const mine = norm(functionBody(display, 'levelOf')).replace(/QUOTA_WARN_PCT/g, 'WARN_PCT');
    const theirs = norm(functionBody(plugin, 'levelForPct')).replace(/warnPct/g, 'WARN_PCT');
    expect(mine).toBe(theirs);
    // 阈值同源:展示台钉死 20 = 电脑那份的缺省 20。
    expect(QUOTA_WARN_PCT).toBe(20);
    expect(plugin).toContain('warnPct ?? 20');
  });
});
