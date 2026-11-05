import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const source = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8');
const mirror = readFileSync(resolve(process.cwd(), 'src/api/protocol.ts'), 'utf8');

function fields(text: string, name: string): string[] {
  const start = text.indexOf(`interface ${name} {`);
  if (start < 0) throw new Error(`missing interface ${name}`);
  const bodyStart = start + `interface ${name} {`.length;
  let depth = 1;
  const body: string[] = [];
  for (let i = bodyStart; i < text.length && depth > 0; i += 1) {
    const ch = text[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 1) body.push(ch);
  }
  const clean = body.join('').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const out: string[] = [];
  for (const match of clean.matchAll(/([A-Za-z_$][\w$]*)\??\s*:/g)) out.push(match[1]!);
  return out;
}

const mirrored = ['NoteFrom', 'NoteReceipt', 'NoteComment', 'NoteMessage', 'MessageDelivery', 'TaskTransition', 'GoalConditionVerification', 'GoalCondition', 'RunSegment', 'CapacityItem', 'LanIdentity', 'LanMember', 'LanHello', 'LanChannelMessage', 'LanChannelTopic', 'LanChannelRef', 'LanChannelSource', 'LanChannelSourcePolicy', 'LanChannelSourceScope', 'TaskRelation', 'CollabGoal', 'CollabSprint', 'AgentCard'];

describe('手机协作公共协议镜像', () => {
  it('Task/Goal/Collab 类型的字段名与唯一服务端协议同源', () => {
    for (const name of mirrored) expect(fields(mirror, name), name).toEqual(fields(source, name));
  });
  it('目标条件状态完整包含候选与未知态', () => {
    expect(mirror.match(/export type GoalConditionState = ([^;]+);/)?.[1]).toBe("'pending' | 'dispatched' | 'doing' | 'unknown' | 'blocked' | 'submitted' | 'rework' | 'verified' | 'delivered'");
  });
  it('运行观察时刻两端均为可选string,旧assigned时刻仍必填', () => {
    for (const text of [source, mirror]) {
      const ast = ts.createSourceFile('protocol.ts', text, ts.ScriptTarget.Latest, true);
      const run = ast.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'RunSegment')!;
      for (const name of ['execution_started_observed_at', 'execution_finished_observed_at']) {
        const field = run.members.find((node): node is ts.PropertySignature => ts.isPropertySignature(node) && node.name.getText(ast) === name);
        expect(field, name).toBeDefined();
        expect(field?.questionToken, name).toBeDefined();
        expect(field?.type?.getText(ast), name).toBe('string');
      }
      const assigned = run.members.find((node): node is ts.PropertySignature => ts.isPropertySignature(node) && node.name.getText(ast) === 'started_at');
      expect(assigned?.questionToken).toBeUndefined();
      expect(assigned?.type?.getText(ast)).toBe('string');
    }
  });
});
