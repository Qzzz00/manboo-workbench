/**
 * ★ **「派活的眼睛」那几样的判据不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 同一套判据两份 —— 源头在 `workbench-plugin/src/client/itemControlsModel.ts`,抄本在手机
 * `butler-app/src/items/itemControls.ts`(两份都注释「逐字同一套」)。原来已经漂了两处:
 *
 *  · `budgetLine`:手机用 `agentTitle(cli_family)`(不带 state 落到**原样家名**,「豆包办公」念成
 *    「doubao」),插件用静态那张表 —— 已对齐成静态表(`ASSIGNEE_NAMES`,值同插件的
 *    `DISPATCH_FAMILY_TITLES`);表里没有的家(运行时新登记的,包标识 / agent 名片的家)
 *    两份都**原样念家名**、不念 undefined(2026-10-22 统筹验收补,手机 driveLabel 那份
 *    同款兜底 `?? who` 照旧);
 *  · `blockLine`:插件带 `desk` 参数(只在**不在电脑前**且 `desk_only` 时补「要在电脑前点…」,
 *    其余只念 why);手机永远不在电脑前,已对齐成 desk=false 的写法 —— 非 desk_only 的修法
 *    不再把 fix.label 接在 why 后面。
 * 手机这份还**没有**插件那三个函数(capMark / capCellTitle / clockOf,体检格,手机上不用),
 * 是刻意子集,不齐不算漂。
 *
 * 直接读插件源码取函数体比对(顶层子目录互不 import,只能读文本;范本
 * `channel-worker/tests/calendar-note-sync.test.ts`)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockLine, budgetLine } from '../src/items/itemControls';

const PLUGIN_MODEL = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'client', 'itemControlsModel.ts');
const PHONE_MODEL = join(import.meta.dirname, '..', 'src', 'items', 'itemControls.ts');

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

/** 归一化:去掉每行末尾分号与空白、丢掉空行与注释行、把 `(one) =>` 收成 `one =>`。 */
function normalize(body: string): string {
  return body.split('\n')
    .map(line => line.replace(/;+\s*$/u, '').trimEnd())
    .filter(line => line !== '' && !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\(([A-Za-z_][A-Za-z0-9_]*)\)\s*=>/g, '$1 =>');
}

/** 手机那份的归一化函数体;插件那份先做同款归一化再套这组「有意差异」的改写。 */
function phoneBody(name: string): string {
  return normalize(functionBody(readFileSync(PHONE_MODEL, 'utf8'), name));
}
function pluginBody(name: string, rewrites: Array<[RegExp | string, string]> = []): string {
  let body = normalize(functionBody(readFileSync(PLUGIN_MODEL, 'utf8'), name));
  for (const [from, to] of rewrites) body = body.replace(from, to);
  return body;
}

describe('★ 派活的眼睛:插件那份是源头,手机这份逐字同一套(只差两个有意差异)', () => {
  it('yuanText / stoppable / pausedLine:手机那份与插件那份逐行相同', () => {
    for (const name of ['yuanText', 'stoppable', 'pausedLine']) {
      expect(phoneBody(name), `${name} 与插件那份漂了`).toBe(pluginBody(name));
    }
  });

  it('budgetLine:手机那份与插件那份逐行相同(人名取静态表,表里没有原样念家名,归一化两张表名)', () => {
    const mine = phoneBody('budgetLine').replace('ASSIGNEE_NAMES[view.cli_family] ?? view.cli_family', 'TITLE[view.cli_family] ?? view.cli_family');
    const theirs = pluginBody('budgetLine', [['DISPATCH_FAMILY_TITLES[view.cli_family] ?? view.cli_family', 'TITLE[view.cli_family] ?? view.cli_family']]);
    expect(mine).toBe(theirs);
    // 行为钉一下:登记过的家念正名,不念原样家名。
    expect(budgetLine({ cli_family: 'doubao', limit_cny: 0.5, limit_minutes: 30, state: 'running', run_minutes: 2 })).toBe(
      '豆包办公 在后台做了 2 分钟(上限 30 分钟;花的是 豆包办公 自己的额度,这里只管时间)',
    );
  });

  it('budgetLine:名表里没有的家(运行时新登记的,包标识 / agent 名片的家)原样念家名,不出现 undefined', () => {
    expect(budgetLine({ cli_family: 'com.google.antigravity', limit_cny: 0.5, limit_minutes: 30, state: 'running', run_minutes: 2 })).toBe(
      'com.google.antigravity 在后台做了 2 分钟(上限 30 分钟;花的是 com.google.antigravity 自己的额度,这里只管时间)',
    );
    // run_minutes 缺席时的那一档也一样兜得住。
    expect(budgetLine({ cli_family: 'com.google.antigravity', limit_cny: 0.5, limit_minutes: 30, state: 'running' })).toBe(
      'com.google.antigravity 在后台做(上限 30 分钟;花的是 com.google.antigravity 自己的额度,这里只管时间)',
    );
    expect(budgetLine({ cli_family: 'com.google.antigravity', limit_cny: 0.5, limit_minutes: 30, state: 'running' })).not.toContain('undefined');
  });

  it('blockLine:手机那份与插件 desk=false 的写法逐行相同(插件 `!desk && ` 在手机上恒成立)', () => {
    expect(phoneBody('blockLine')).toBe(pluginBody('blockLine', [['!desk && ', '']]));
    // 行为钉一下:desk_only 的修法才补「要在电脑前点…」;非 desk_only 只念 why。
    expect(blockLine({ dispatch_block: { why: '没登录', fix: { desk_only: true, label: '帮我接上' } }, note: '' } as never)).toBe('没登录(要在电脑前点「帮我接上」)');
    expect(blockLine({ dispatch_block: { why: '没登录', fix: { desk_only: false, label: '重新登录' } }, note: '' } as never)).toBe('没登录');
  });
});
