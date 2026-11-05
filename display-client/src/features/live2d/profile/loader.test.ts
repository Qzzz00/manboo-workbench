import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfileFromJson } from './loader';

function loadProfile(role: string) {
  const json = readFileSync(resolve(import.meta.dirname, `../../../../model/profiles/${role}.v1.json`), 'utf-8');
  return loadProfileFromJson(json);
}

describe('loader', () => {
  it('加载 shuangsheng.v1.json 后 driver 为 "v2"', () => {
    const profile = loadProfile('shuangsheng');
    expect(profile.driver).toBe('v2');
  });

  it('加载 shuangsheng-dj.v1.json 后 driver 为 "v2"', () => {
    const profile = loadProfile('shuangsheng-dj');
    expect(profile.driver).toBe('v2');
  });

  it('加载 yumi.v1.json 后 driver 为 "v2"', () => {
    const profile = loadProfile('yumi');
    expect(profile.driver).toBe('v2');
  });

  it('非法 driver 值应抛错', () => {
    const raw = {
      role: 'test',
      schemaVersion: 'v1',
      driver: 'v3',
      motions: [],
      expressions: [],
      excluded: [],
    };
    expect(() => loadProfileFromJson(JSON.stringify(raw))).toThrow('driver');
  });
});
