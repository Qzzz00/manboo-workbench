/**
 * 手机读对话的契约(2026-10-01):手机 `src/api/protocol.ts` 那一段与工作台 `workbench-plugin/src/protocol.ts` **同名同值**。
 * 读两边源文件比对(接缝规矩:不写「逐字相同」注释代替测试)—— 常量的值、每个接口的字段名、附件种类的那一串。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as phone from '../src/api/protocol';

const PLUGIN = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8');
const PHONE = readFileSync(resolve(process.cwd(), 'src/api/protocol.ts'), 'utf8');

/** `export const NAME = <值>` 的值(源码原文,去掉行尾分号)。 */
function constOf(source: string, name: string): string | undefined {
  return new RegExp(`export const ${name} = ([^\\n]+)`).exec(source)?.[1]?.replace(/;\s*$/, '').trim();
}

/** `export interface NAME { … }` 里的字段名(只看顶层那一层)。 */
function fieldsOf(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) return [];
  let depth = 0;
  let body = '';
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    if (ch === '}') { depth -= 1; if (depth === 0) break; }
    if (depth === 1) body += ch;
  }
  return [...body.matchAll(/^\s*([a-z_]+)\??:/gm)].map((m) => m[1]!).sort();
}

/** `export type NAME = …` 那一串里的字面量。 */
function literalsOf(source: string, name: string): string[] {
  const start = source.indexOf(`export type ${name} =`);
  const end = source.indexOf('\n\n', start);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe('手机读对话:两边契约同名同值', () => {
  it('常量', () => {
    for (const name of ['SESSION_HISTORY_DAYS', 'SESSION_HISTORY_LIMIT', 'SESSION_HISTORY_PER_FAMILY', 'SESSION_WINDOW_ONLY_NOTE', 'SESSION_WINDOW_ONLY_MEDIA_NOTE', 'SESSION_TRANSCRIPT_ROUNDS', 'SESSION_ATTACHMENT_PART_BYTES', 'SESSION_ATTACHMENT_TEXT_PART']) {
      expect(constOf(PLUGIN, name), name).toBeDefined();
      expect(constOf(PHONE, name), name).toBe(constOf(PLUGIN, name));
      expect(name in phone, name).toBe(true);
    }
  });

  it('接口字段', () => {
    for (const name of ['SessionHistoryItem', 'SessionHistoryView', 'SessionAttachmentRef', 'SessionTranscriptView', 'SessionAttachmentInfo', 'SessionAttachmentChunk']) {
      expect(fieldsOf(PLUGIN, name).length, name).toBeGreaterThan(0);
      expect(fieldsOf(PHONE, name), name).toEqual(fieldsOf(PLUGIN, name));
    }
  });

  it('附件种类、对话条目的种类', () => {
    expect(literalsOf(PHONE, 'SessionAttachmentKind')).toEqual(literalsOf(PLUGIN, 'SessionAttachmentKind'));
    expect(literalsOf(PHONE, 'SessionTranscriptEntry')).toEqual(literalsOf(PLUGIN, 'SessionTranscriptEntry'));
    expect(literalsOf(PLUGIN, 'SessionAttachmentKind')).toContain('image');
  });
});
