/**
 * 把仓库根上的起步层 `user-layer/起步/` 拷进 `lib/starter-layer/`(2026-10-21,卡「分层第一刀」)。
 *
 * 起步层是新机器第一次启动时放进用户层目录的那一份(现在是运营同学那六格),源码**不在本体里**;
 * 本体只是把它当一份数据随安装包与热更新包带过去,`server/userLayer.ts` 的 ensure 只在第一次建目录时拷一次,
 * 之后那个目录归她。`pnpm build` 最后一步跑这个;`npm pack` 按 package.json 的 files 带上它。
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', '..', 'user-layer', '起步')
const to = join(here, '..', 'lib', 'starter-layer')
rmSync(to, { recursive: true, force: true })
if (existsSync(from)) cpSync(from, to, { recursive: true, filter: src => !src.split('/').pop().startsWith('.') })
console.log(existsSync(from) ? `起步层 → ${to}` : `没有 ${from},lib/starter-layer 留空`)
