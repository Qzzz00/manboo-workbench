/**
 * ★ **手机设置里规矩 / 习惯的视图形状不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 手机这两张视图(`PhoneRuleView` / `PhoneHabitView`)是插件
 * (`workbench-plugin/src/protocol.ts` 的 `ButlerRuleView` / `HabitView`)的**刻意子集**:
 * 只取手机用得到的几格,字段名一字不改。所以这里的对照钉的是**两边共有的值域**:
 * area / status / origin 的值集手机那份不能比插件少、也不能多加一种 —— 漂了这条红给你看;
 * 缺的那一格(rule.origin 少了 `'onboarding'`、habit 的 `kind` 不收窄、`kind_title` 可选)
 * 是刻意子集的取舍,下面逐条钉着,不算漂。
 *
 * 直接读两边源码取值集比对(顶层子目录互不 import,只能读文本;范本
 * `channel-worker/tests/calendar-note-sync.test.ts`)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WP = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src');
const BA = join(import.meta.dirname, '..', 'src');

/** 从 `export type <Name> =` 之后抓到下一个声明为止,取里面所有单引号字面量。 */
function typeUnion(source: string, name: string): string[] {
  const at = source.indexOf(`export type ${name} =`);
  expect(at, `源码里找不到 \`export type ${name}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(at + 1);
  const next = /\n\s*export\b/.exec(rest);
  const block = next === null ? rest : rest.slice(0, next.index);
  return [...block.matchAll(/'([^']+)'/g)].map(one => one[1] as string);
}

/** 从 `interface <Name>` 里某一格 `field: '…' | …` 取值集。 */
function interfaceFieldUnion(source: string, iface: string, field: string): string[] {
  const at = source.indexOf(`interface ${iface}`);
  expect(at, `源码里找不到 \`interface ${iface}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const close = source.indexOf('\n}', at);
  const line = source.slice(at, close).split('\n').find(one => one.trim().startsWith(`${field}:`));
  expect(line, `interface ${iface} 里找不到 ${field} 那一格`).toBeDefined();
  return [...(line ?? '').matchAll(/'([^']+)'/g)].map(one => one[1] as string);
}

const plugin = readFileSync(join(WP, 'protocol.ts'), 'utf8');
const rules = readFileSync(join(BA, 'settings', 'RulesSection.tsx'), 'utf8');
const habits = readFileSync(join(BA, 'settings', 'HabitsSection.tsx'), 'utf8');

describe('★ 规矩 / 习惯视图形状:手机那份是插件的子集,共有值域不许漂', () => {
  it('rule.area 与插件 ButlerRuleArea 同一个值集', () => {
    expect(interfaceFieldUnion(rules, 'PhoneRuleView', 'area').sort()).toEqual(typeUnion(plugin, 'ButlerRuleArea').sort());
  });

  it('rule.status 与插件 ButlerRuleStatus 同一个值集', () => {
    expect(interfaceFieldUnion(rules, 'PhoneRuleView', 'status').sort()).toEqual(typeUnion(plugin, 'ButlerRuleStatus').sort());
  });

  it('rule.origin 是插件那份的子集,缺的只许是「onboarding」(引导里说的那条手机不标,刻意子集)', () => {
    const mine = interfaceFieldUnion(rules, 'PhoneRuleView', 'origin');
    const theirs = interfaceFieldUnion(plugin, 'ButlerRuleView', 'origin');
    expect(mine.filter(one => !theirs.includes(one)), '手机 rule.origin 有插件没有的值 —— 以插件为源头').toEqual([]);
    expect(theirs.filter(one => !mine.includes(one))).toEqual(['onboarding']);
  });

  it('habit.status 与插件 HabitStatus(规矩表去掉 active)同一个值集', () => {
    const habitStatus = typeUnion(plugin, 'ButlerRuleStatus').filter(one => one !== 'active');
    expect(interfaceFieldUnion(habits, 'PhoneHabitView', 'status').sort()).toEqual(habitStatus.sort());
  });

  it('habit.kind 不收窄、kind_title 可选(刻意子集:手机按通用形状显示,新种类照样收)', () => {
    const kindLine = habits.split('\n').find(one => one.trim().startsWith('kind:'));
    const kindTitleLine = habits.split('\n').find(one => one.trim().startsWith('kind_title'));
    expect(kindLine).toMatch(/kind: string;/);
    expect(kindTitleLine).toMatch(/kind_title\?: string;/);
  });
});
