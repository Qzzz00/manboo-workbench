/**
 * ★ **「派给 X」那颗标签不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 同一件事「待办卡上那颗『派给 X』/『交给事务官』给什么字」两份 —— 源头在插件
 * (`workbench-plugin/src/protocol.ts` 的 `driveLabel`),抄本在手机(`butler-app/src/api/protocol.ts`)。
 * 原来手机这份已经漂了:家名判断走**开集** `isDispatchFamily`(随便一个字符串都算一家),
 * 而插件那份 2026-09-25 起就收紧成 `isAgentDispatchFamily`(登记表里有或像包标识才算)。
 *
 * 对齐口径(**以插件那份为源头**,2026-10-22):手机这份照插件的判法 —— 人那三档走
 * `isPersonAssignee`、家名走收紧后的 `isDispatchFamily`(登记过的一家或包标识形状);
 * 末了 `?? who` 是手机这边**保留的安全网**(包标识家名不在 ASSIGNEE_NAMES 时原样显示,
 * 不念「undefined」;插件那头缺这一档,是它的潜在空当,不在本卡动插件)。
 *
 * 直接读插件源码取函数体比对(顶层子目录互不 import,只能读文本;范本
 * `channel-worker/tests/calendar-note-sync.test.ts`)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driveLabel, isDispatchFamily } from '../src/api/protocol';

const PLUGIN_PROTOCOL = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts');
const PHONE_PROTOCOL = join(import.meta.dirname, '..', 'src', 'api', 'protocol.ts');

function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `源码里找不到 \`function ${name}(\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(open + 1, i);
}

function normalize(body: string): string {
  return body.split('\n')
    .map(line => line.replace(/;+\s*$/u, '').trimEnd())
    .filter(line => line !== '')
    .join('\n');
}

describe('★ 派活标签 driveLabel:插件那份是源头,手机这份照抄(只多 `?? who` 安全网)', () => {
  it('手机 driveLabel 与插件 driveLabel 逐行相同(归一化:去分号;家名判断代称;手机多那一格 `?? who`)', () => {
    const plugin = normalize(functionBody(readFileSync(PLUGIN_PROTOCOL, 'utf8'), 'driveLabel'))
      .replace(/isAgentDispatchFamily\(who\)/g, 'FAMILY(who)');
    const mine = normalize(functionBody(readFileSync(PHONE_PROTOCOL, 'utf8'), 'driveLabel'))
      .replace(/isDispatchFamily\(who\)/g, 'FAMILY(who)')
      .replace(/\s*\?\? who/g, '');
    expect(mine, '手机 driveLabel 与插件那份漂了 —— 以插件为源头收成一样(只许多 `?? who` 安全网)').toBe(plugin);
  });

  it('★ 家名判断已收紧:登记过的一家 / 包标识形状才算(插件 isAgentDispatchFamily 同一条)', () => {
    expect(isDispatchFamily('codex')).toBe(true);
    expect(isDispatchFamily('com.meta.endo')).toBe(true);
    expect(isDispatchFamily('some-random-name')).toBe(false);
    expect(isDispatchFamily('dsh')).toBe(false);
    expect(isDispatchFamily('me')).toBe(false);
    expect(isDispatchFamily('com.tencent.xinWeChat')).toBe(false);
    // 插件那头的要求(读源码钉着):登记表里有或像包标识。
    const plugin = readFileSync(PLUGIN_PROTOCOL, 'utf8');
    const hit = plugin.match(/export function isAgentDispatchFamily[\s\S]*?Object\.hasOwn\(DISPATCH_FAMILY_TITLES, id\) \|\| BUNDLE_ID\.test\(id\)/);
    expect(hit, '插件 protocol.ts 的 isAgentDispatchFamily 不再是「登记表里有或像包标识」的判法 —— 这条要跟着改').not.toBeNull();
  });

  it('行为:同一张卡两边给同一颗字(手机侧钉几条)', () => {
    expect(driveLabel({ status: 'todo', kind: 'topic', assignee: 'codex', dispatch: {} as never })).toBeUndefined();
    expect(driveLabel({ status: 'todo', kind: 'feature', assignee: 'codex', dispatch: {} as never })).toBeUndefined();
    expect(driveLabel({ status: 'todo', kind: 'other' as never, assignee: 'me', dispatch: {} as never })).toBeUndefined();
    expect(driveLabel({ status: 'todo', kind: 'other' as never, assignee: 'dsh', dispatch: {} as never })).toBe('交给事务官');
    expect(driveLabel({ status: 'todo', kind: 'other' as never, assignee: 'codex', dispatch: { status: 'running' } as never })).toBeUndefined();
    expect(driveLabel({ status: 'todo', kind: 'other' as never, assignee: 'codex', dispatch: {} as never })).toBe('派给 Codex');
    expect(driveLabel({ status: 'doing', kind: 'other' as never, assignee: 'codex', dispatch: {} as never })).toBeUndefined();
  });
});
