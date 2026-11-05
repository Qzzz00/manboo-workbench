import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { require, tempHome, cleanupHome } from './_setup.mjs';

const home = tempHome('cfg');
const { loadConfig, resetConfigCache, DEFAULT_PORT } = require('../server/config.cjs');

afterAll(() => cleanupHome(home));

describe('butler.json 首次启动生成', () => {
  it('缺文件时生成:默认端口 8792,token 为 64 位 hex,权限 0600', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.port).toBe(8792);
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(process.env.BUTLER_CONFIG_FILE)).toBe(true);
    expect(statSync(process.env.BUTLER_CONFIG_FILE).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(process.env.BUTLER_CONFIG_FILE, 'utf8'));
    expect(onDisk).toEqual({ version: 1, port: 8792, token: cfg.token });
  });

  it('再次加载读回同一个 token,不重新生成', () => {
    const first = loadConfig().token;
    resetConfigCache();
    expect(loadConfig().token).toBe(first);
  });

  it('端口写坏了退回默认值,token 保留', () => {
    const first = loadConfig().token;
    const { writeFileSync } = require('node:fs');
    writeFileSync(process.env.BUTLER_CONFIG_FILE, JSON.stringify({ version: 1, port: 'abc', token: first }));
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.port).toBe(8792);
    expect(cfg.token).toBe(first);
  });
});
