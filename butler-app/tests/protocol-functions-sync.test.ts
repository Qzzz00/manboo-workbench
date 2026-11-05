/**
 * ★ **手机从插件抄的那批纯函数不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 函数对:isTrackedItem / shortMoment / friendlyWhen / taskOriginOf(源头都在
 * `workbench-plugin/src/protocol.ts`)、deckRunBadge(源头 `workbench-plugin/src/client/DeckModel.ts`)。
 * 手机各抄一份,注释都自称「逐字同一条 / 同一份规矩」,没有用例守着。
 *
 * 直接读源头源码取函数体比对(顶层子目录互不 import,只能读文本;范本
 * `channel-worker/tests/calendar-note-sync.test.ts`)。比对口径:两边的函数体在
 * 去掉分号 / 空白之后**逐行相同**;taskOriginOf 那一条,手机因 `TaskView.source` 可选而写
 * `source?.kind`、插件必填写 `source.kind` —— 归一化后应一致。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTrackedItem, shortMoment, friendlyWhen, taskOriginOf } from '../src/api/protocol';
import { deckRunBadge } from '../src/feature/featureModel';

const WP = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src');
const BA = join(import.meta.dirname, '..', 'src');

/** 从源码里取出 `function <name>(…){ … }` 那一整段函数体(参数类型里也可能有 `{ }`,先配平参数括号再找体)。 */
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

/** 归一化:去掉每行末尾分号与空白、丢掉空行与注释行、把 `(one) =>` 收成 `one =>`。 */
function normalize(body: string): string {
  return body.split('\n')
    .map(line => line.replace(/;+\s*$/u, '').trimEnd())
    .filter(line => line !== '' && !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\(([A-Za-z_][A-Za-z0-9_]*)\)\s*=>/g, '$1 =>');
}

/** 插件 protocol.ts 里那个函数的归一化函数体。 */
function pluginFn(name: string): string {
  return normalize(functionBody(readFileSync(join(WP, 'protocol.ts'), 'utf8'), name));
}

describe('★ 手机抄的纯函数对照(源头在插件)', () => {
  it('isTrackedItem:手机那份与插件 protocol.ts 那份逐行相同', () => {
    expect(normalize(functionBody(readFileSync(join(BA, 'api/protocol.ts'), 'utf8'), 'isTrackedItem'))).toBe(pluginFn('isTrackedItem'));
    // 行为也钉一下:选题池的卡只按 mine 算。
    expect(isTrackedItem({ direction: 'mine', kind: 'topic', assignee: 'codex' })).toBe(true);
    expect(isTrackedItem({ direction: 'butler', kind: 'topic', assignee: 'codex' })).toBe(false);
    expect(isTrackedItem({ direction: 'butler', kind: 'feature', assignee: undefined })).toBe(false);
  });

  it('shortMoment:手机那份与插件 protocol.ts 那份逐行相同', () => {
    expect(normalize(functionBody(readFileSync(join(BA, 'api/protocol.ts'), 'utf8'), 'shortMoment'))).toBe(pluginFn('shortMoment'));
    expect(shortMoment('2026-09-24')).toBe('9月24日');
  });

  it('friendlyWhen:手机那份与插件 protocol.ts 那份逐行相同', () => {
    expect(normalize(functionBody(readFileSync(join(BA, 'api/protocol.ts'), 'utf8'), 'friendlyWhen'))).toBe(pluginFn('friendlyWhen'));
    expect(friendlyWhen('2026-09-24', '2026-09-24T12:00:00')).toBe('今天');
  });

  it('taskOriginOf:手机那份与插件那份逐行相同(手机 `source?.kind` = 插件 `source.kind`,字段可选性差异,归一化)', () => {
    const mine = normalize(functionBody(readFileSync(join(BA, 'api/protocol.ts'), 'utf8'), 'taskOriginOf')).replace(/source\?\.kind/g, 'source.kind');
    expect(mine).toBe(pluginFn('taskOriginOf'));
    expect(taskOriginOf({ origin: undefined, title: '和事务官通了电话', desc: undefined, source: undefined })).toBe('call');
  });

  it('deckRunBadge:手机 featureModel.ts 那份与插件 client/DeckModel.ts 那份逐行相同', () => {
    const mine = normalize(functionBody(readFileSync(join(BA, 'feature/featureModel.ts'), 'utf8'), 'deckRunBadge'));
    const theirs = normalize(functionBody(readFileSync(join(WP, 'client/DeckModel.ts'), 'utf8'), 'deckRunBadge'));
    expect(mine).toBe(theirs);
    // 行为也钉一下:「排队」这一档要她刚点过按钮、那头还没报更新。
    expect(deckRunBadge({ dispatch: { status: 'running', started_at: 't1' }, lastRunAt: 't2' })).toBe('排队');
  });
});

it('运行回执字段与插件唯一契约一致', () => {
  const plugin = readFileSync(join(WP, 'protocol.ts'), 'utf8');
  const phone = readFileSync(join(BA, 'api/protocol.ts'), 'utf8');
  const body = (text: string, name: string) => text.split(`export interface ${name} {`)[1]!.split('\n}')[0]!;
  const normalizeType = (text: string) => text.replace(/[;,\s]/g, '').replaceAll('RuntimeConfig', '{model?:stringeffort?:string}');
  expect(normalizeType(body(phone, 'DispatchRuntimeView'))).toBe(normalizeType(body(plugin, 'DispatchRuntime')));
});
