/**
 * 展示台那份粒子核心与手机端、Mac 端**逐字同源**(2026-09-22)。
 *
 * 真相源是 `docs/prototypes/swarm-v4/`,生成器是 `workbench-plugin/scripts/sync-swarm-core.mjs`。
 * 那个脚本眼下有两个目标(Mac `workbench-plugin/src/client/swarm/` + 手机 `butler-app/src/swarm/`);
 * **展示台这一份是第三份,而本卡只许改 display-client/ 与 butler-app/,所以没动那个脚本。**
 * → 交接里留了一条给统筹会话的一行改动(`mirrors` 里加上 `display-client/src/swarm`)。
 * 在那一行落地之前,这一份测试就是防漂移的那道门:核心一旦被重新生成而这里没跟上,它当场红。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest 在 display-client 里跑,仓库根在上一级。
const root = resolve(process.cwd());
const names = ['core.js', 'core.d.ts', 'source-manifest.json', 'THIRD_PARTY_LICENSES.txt'];
const mine = (name: string) => resolve(root, 'src/swarm', name);
const phone = (name: string) => resolve(root, '../butler-app/src/swarm', name);
const mac = (name: string) => resolve(root, '../workbench-plugin/src/client/swarm', name);
const prototypeFile = (name: string) => resolve(root, '../docs/prototypes/swarm-v4', name);

describe('src/swarm 与手机端 / Mac 端是同一份核心', () => {
  it('★四个文件与手机端(butler-app)逐字相同', () => {
    for (const name of names) {
      expect(readFileSync(mine(name), 'utf8'), name).toBe(readFileSync(phone(name), 'utf8'));
    }
  });
  it('★也与 Mac 事务官档(workbench-plugin)逐字相同', () => {
    for (const name of names) {
      expect(readFileSync(mine(name), 'utf8'), name).toBe(readFileSync(mac(name), 'utf8'));
    }
  });
  it('manifest 里每个 SHA 与原型源文件对得上', () => {
    const manifest = JSON.parse(readFileSync(mine('source-manifest.json'), 'utf8')) as { source: string; files: Record<string, string> };
    expect(manifest.source).toBe('docs/prototypes/swarm-v4');
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(prototypeFile(name))).digest('hex'), name).toBe(hash);
    }
  });
  it('许可证在,且没有把原型里的调试台/演示代码带进来', () => {
    const core = readFileSync(mine('core.js'), 'utf8');
    expect(core).toContain('Permission is hereby granted, free of charge');
    expect(core).not.toMatch(/\beval\s*\(|new\s+Function\b|class IconPicker|class TaskScene|4177/);
  });
  it('「旋转」这件事有出处:核心里 spinSpeed 只在 idle 态生效', () => {
    const core = readFileSync(mine('core.js'), 'utf8');
    expect(core).toContain("this.mode==='idle'?settings.spinSpeed:0");
  });
});
