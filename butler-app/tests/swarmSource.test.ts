/** 手机端那份粒子核心与电脑端逐字同源:同一个 sync 脚本生成,manifest 的 SHA 对得上原型源文件。 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom 环境里 import.meta.url 不是 file:,用 cwd(vitest 在 butler-app 里跑)拼路径。
const root = resolve(process.cwd());
const source = (name: string) => resolve(root, '../docs/prototypes/swarm-v4', name);
const mine = (name: string) => resolve(root, 'src/swarm', name);
const plugin = (name: string) => resolve(root, '../workbench-plugin/src/client/swarm', name);

describe('src/swarm 是 scripts/sync-swarm-core.mjs 的第二个目标', () => {
  it('manifest 的每个 SHA 与原型源文件一致', () => {
    const manifest = JSON.parse(readFileSync(mine('source-manifest.json'), 'utf8')) as { source: string; files: Record<string, string> };
    expect(manifest.source).toBe('docs/prototypes/swarm-v4');
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(source(name))).digest('hex')).toBe(hash);
    }
  });
  it('core.js / core.d.ts / 许可证与电脑端那份逐字相同', () => {
    for (const name of ['core.js', 'core.d.ts', 'source-manifest.json', 'THIRD_PARTY_LICENSES.txt']) {
      expect(readFileSync(mine(name), 'utf8')).toBe(readFileSync(plugin(name), 'utf8'));
    }
    const core = readFileSync(mine('core.js'), 'utf8');
    expect(core).toContain('Permission is hereby granted, free of charge');
    expect(core).not.toMatch(/\beval\s*\(|new\s+Function\b|class IconPicker|class TaskScene|4177/);
  });
});
