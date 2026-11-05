/**
 * 连接路线规格(docs/规格-连接路线-2026-10-21.md)的对照用例 —— TS 这一半。
 *
 * 用例只有一份:src/channel/routeSpec.cases.json。听筒那一半(phone-bridge/route_spec_test.py)读的是**同一个文件**,
 * 两边逐步比对的都是文件里写的期望值;一边的实现改了另一边没改,那一边红。
 * 比对用排好键的 JSON 文本,不用深比较:`1` 与 `true`、缺一格与 `null` 都要分得出来,两种语言才算「逐字相同」。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_SPEC,
  decideRoute,
  initialRouteState,
  type RouteEvent,
  type RouteFacts,
  type RouteState,
} from '../src/channel/routeSpec';

interface SpecStep {
  note?: string;
  event: RouteEvent;
  expect: unknown;
  expect_facts?: Record<string, unknown>;
}

interface SpecFile {
  constants: Record<string, number>;
  default_facts: RouteFacts;
  cases: { name: string; facts: Partial<RouteFacts>; steps: SpecStep[] }[];
}

// 用例环境是 jsdom,import.meta.url 不是 file:;按包根(vitest 从 butler-app 起)拼路径,与 remoteParityScan.ts 同一个写法。
const CASES_PATH = resolve(process.cwd(), 'src/channel/routeSpec.cases.json');
const spec = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as SpecFile;

/** 排好键的 JSON:与 Python 那边 `json.dumps(sort_keys=True, separators=(",", ":"))` 同一个写法。 */
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

describe('连接路线规格:读同一份用例', () => {
  it('常数与用例文件里写的一样', () => {
    expect(canonical(ROUTE_SPEC)).toBe(canonical(spec.constants));
  });

  it('至少十二条,名字不重', () => {
    const names = spec.cases.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const testCase of spec.cases) {
    it(testCase.name, () => {
      let state: RouteState = initialRouteState({ ...spec.default_facts, ...testCase.facts } as RouteFacts);
      testCase.steps.forEach((step, index) => {
        const where = `${testCase.name} · 第 ${index + 1} 步(${step.event.type})`;
        const before = canonical(state);
        const result = decideRoute(state, step.event);
        expect(canonical(state), `${where}:不许改传进来的状态`).toBe(before);
        expect(canonical(result.decision), where).toBe(canonical(step.expect));
        for (const [key, value] of Object.entries(step.expect_facts ?? {})) {
          expect(canonical((result.state.facts as unknown as Record<string, unknown>)[key]), `${where} · facts.${key}`).toBe(canonical(value));
        }
        state = result.state;
      });
    });
  }
});
