#!/usr/bin/env node
// 回归集 harness 的入口:先用 rolldown 把 run.mts 打成一个 .mjs(模型服务那一串有 Node 剥类型剥不了的写法),再原样带参数跑。
// 在 workbench-plugin/ 下执行:node dev/intent-regression/run.mjs [--entrance desktop] [--only 09:35] [--repeat 3] [--out <明细.json>]
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'intent-regression-'))
const file = join(dir, 'run.mjs')
try {
  const built = spawnSync('npx', ['rolldown', 'dev/intent-regression/run.mts', '--platform', 'node', '--format', 'esm', '--file', file, '--log-level', 'warn'], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (built.status !== 0) process.exit(built.status ?? 1)
  const ran = spawnSync(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exitCode = ran.status ?? 1
}
finally {
  rmSync(dir, { recursive: true, force: true })
}
