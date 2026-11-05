#!/usr/bin/env node
// 把 docs/brand/blackhole.js(+ .d.ts)逐字节拷到两端:
//   workbench-plugin/src/client/brand/   butler-app/src/brand/
// 两端各有一条用例比对「与源相同」,改了源忘了同步会红。
//   node docs/brand/sync-blackhole.mjs
import { copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../..')
for (const name of ['blackhole.js', 'blackhole.d.ts']) {
  for (const dir of ['workbench-plugin/src/client/brand', 'butler-app/src/brand']) {
    copyFileSync(resolve(here, name), resolve(repo, dir, name))
    console.log(`  ${dir}/${name}`)
  }
}
