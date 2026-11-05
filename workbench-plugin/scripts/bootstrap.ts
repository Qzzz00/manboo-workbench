/**
 * 裸机引导的命令行外壳(2026-09-17)。**逻辑一行都不在这儿** —— 全在
 * `src/server/setup/bootstrap.ts`(那里有用例,这里没有,所以这里越薄越好)。
 *
 * 这个文件由 `deploy/bootstrap.sh` 调用,不是给人直接敲的:
 *
 *     node workbench-plugin/scripts/bootstrap.ts --repo <仓库根> [--home <家>] [--dsh-home <DSH 家>]
 *                                               [--steps node,runtime,…] [--no-launch] [--print-url]
 *
 * node 24 起能自己剥 TypeScript,所以不需要 tsx(同 `scripts/channel-dev-server.ts` 的跑法)。
 *
 * 退出码:0 成功;1 参数/体检不过;2 某一步装失败;3 取不到那条带 token 的地址。
 */
import { randomUUID } from 'node:crypto'
import {
  bootstrapPreflight, bootstrapSetupUrl, bootstrapSkip, parseBootstrapArgs, runBootstrap, withSkippedCommands,
} from '../src/server/setup/bootstrap.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'

const parsed = parseBootstrapArgs(process.argv.slice(2), process.env)
if (!parsed.ok) {
  console.error(parsed.error)
  process.exit(1)
}
const args = parsed.args
const io = nodeSetupIo()
const paths = setupPaths({ home: args.home, dshHome: args.dshHome, repoRoot: args.repoRoot })

// --print-url:什么都不装,只把那条地址打到 stdout(shell 拿它去 open)。
if (args.printUrl) {
  const found = await bootstrapSetupUrl(io, paths)
  if (!found.ok) {
    console.error(found.error)
    process.exit(3)
  }
  console.log(found.url)
  process.exit(0)
}

const problems = await bootstrapPreflight({ io, paths, repoRoot: args.repoRoot })
if (problems.length > 0) {
  console.error('还不能开始装,先把这几件事办了:')
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}

const outcome = await runBootstrap({
  io: withSkippedCommands(io, bootstrapSkip({ noLaunch: args.noLaunch })),
  paths,
  repoRoot: args.repoRoot,
  steps: args.steps,
  now: () => Date.now(),
  newId: () => randomUUID(),
  report: line => console.log(line),
})

if (!outcome.ok) {
  console.error('')
  console.error(`这一步没过:${outcome.failed}`)
  console.error(`原因:${outcome.error ?? '(没说)'}`)
  if (outcome.tail !== undefined && outcome.tail.length > 0) {
    console.error('原始输出的最后几行:')
    for (const line of outcome.tail) console.error(`  | ${line}`)
  }
  console.error('')
  console.error('修完之后**照原样再跑一遍**就行 —— 每一步都是幂等的,装好的不会重装。')
  process.exit(2)
}
