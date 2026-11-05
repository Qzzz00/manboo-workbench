import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadAuProfile,
  clearAuProfileCache,
  auProfileUrlFromModelJson,
  modelDirFromModelJson,
} from './loadAuProfile';
import type { AUProfile } from './types';

const validProfile: AUProfile = {
  version: 1,
  characterId: 'shuangsheng',
  semanticBindings: { 'eye.open': { paramId: 'ParamEyeLOpen', curve: 'linear' } },
  units: [{ type: 'native', id: 'native:wink', nativeRef: 'wink.exp3.json', regions: ['mouth'], emotions: { happy: 0.6 } }],
  rules: [],
};

function res(ok: boolean, body?: unknown): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => clearAuProfileCache());

describe('url helpers', () => {
  it('derives dir and profile url from model3.json url', () => {
    const url = '/live2D/shuangsheng/shuangsheng.model3.json';
    expect(modelDirFromModelJson(url)).toBe('/live2D/shuangsheng/');
    expect(auProfileUrlFromModelJson(url)).toBe('/live2D/shuangsheng/au-profile.json');
  });
});

describe('loadAuProfile', () => {
  it('loads and validates a profile', async () => {
    const p = await loadAuProfile('/live2D/shuangsheng/shuangsheng.model3.json', {
      fetcher: async () => res(true, validProfile),
    });
    expect(p?.characterId).toBe('shuangsheng');
  });

  it('returns null on 404 (graceful degrade)', async () => {
    const p = await loadAuProfile('/live2D/nope/nope.model3.json', {
      fetcher: async () => res(false),
    });
    expect(p).toBeNull();
  });

  it('returns null on invalid profile json', async () => {
    const p = await loadAuProfile('/live2D/bad/bad.model3.json', {
      fetcher: async () => res(true, { not: 'a profile' }),
    });
    expect(p).toBeNull();
  });

  it('returns null on fetch throw', async () => {
    const p = await loadAuProfile('/live2D/err/err.model3.json', {
      fetcher: async () => {
        throw new Error('network');
      },
    });
    expect(p).toBeNull();
  });

  it('caches result (fetcher called once across calls)', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return res(true, validProfile);
    };
    const url = '/live2D/shuangsheng/shuangsheng.model3.json';
    await loadAuProfile(url, { fetcher });
    await loadAuProfile(url, { fetcher });
    expect(calls).toBe(1);
  });

  it('caches null results too (no repeated 404)', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return res(false);
    };
    const url = '/live2D/nope/nope.model3.json';
    await loadAuProfile(url, { fetcher });
    await loadAuProfile(url, { fetcher });
    expect(calls).toBe(1);
  });

  it('force bypasses cache', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return res(true, validProfile);
    };
    const url = '/live2D/shuangsheng/shuangsheng.model3.json';
    await loadAuProfile(url, { fetcher });
    await loadAuProfile(url, { fetcher, force: true });
    expect(calls).toBe(2);
  });
});
