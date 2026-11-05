/**
 * 派活排着等电脑解锁(2026-10-12):手机 `src/api/protocol.ts` 那一格与工作台 `workbench-plugin/src/protocol.ts` 同名同值。
 * 读两边源文件比对(接缝规矩:不写「逐字相同」注释代替测试)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNLOCK_WAIT_LABEL } from '../src/api/protocol';

const PLUGIN = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8');
const PHONE = readFileSync(resolve(process.cwd(), 'src/api/protocol.ts'), 'utf8');

function blockOf(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('「在等你解锁电脑」两边同名同值', () => {
  it('那一句字', () => {
    const plugin = /export const UNLOCK_WAIT_LABEL = '([^']+)'/.exec(PLUGIN)?.[1];
    expect(plugin).toBeDefined();
    expect(UNLOCK_WAIT_LABEL).toBe(plugin);
  });
  it('卡上那一格叫 unlock(工作台 TaskDispatchBlock ↔ 手机 TaskDispatchBlockView)', () => {
    expect(blockOf(PLUGIN, 'TaskDispatchBlock')).toMatch(/^\s*unlock\?: true$/m);
    expect(blockOf(PHONE, 'TaskDispatchBlockView')).toMatch(/^\s*unlock\?: true;$/m);
  });
});
