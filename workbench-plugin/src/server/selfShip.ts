/**
 * 「改工作台自己」那条闭环(2026-09-23,断点 C)。
 *
 * 她在手机上点「通过」之后,**按顺序**做完这八步;**每一步失败就停**:
 *
 * ```
 * ① 边界   分支上改过的文件挨个过硬边界(deploy/、.claude/、docs/交接-*、~/.dsh)
 * ② 测试   workbench-plugin 的 pnpm typecheck && pnpm vitest run;改到别的包就各跑各的
 * ③ 合并   git merge --ff-only —— **不能 ff 就停下叫人**,一次 rebase 都不替她做
 * ④ 版本   npm version patch --no-git-tag-version + 发版记录第 7 行插一行(人话)
 * ⑤ 提交   git add 那两个文件 → commit(尾行按事实署名)→ push
 * ⑥ 发版   bash deploy/publish-update.sh --with <按改到的包> --notes "<人话>"
 * ⑦ 记录   决策记录追加一条、docs/进化日志.md 留一条,状态**如实写「待重启确认」**
 * ⑧ 更新   POST /update/apply,**按下就回**(不等版本号)
 * ```
 *
 * ## 为什么「记录」在「更新」之前,而且更新那一步不等
 *
 * 这是 2026-09-23 接线那张卡才定下来的一条(上一版 ⑦⑧ 是反的,于是这条路一直没敢接上):
 *
 * > `/update/apply` 会把**正在跑这条请求的这个进程**换掉并重启。
 *
 * 所以"等版本号真的变了"这一步不可能跑完 —— 它会被自己触发的那次重启打断,
 * 而那一刻记录那一步一个字都还没写,这一版就成了一次**没有任何记录的自我修改**。
 * 一件能自己改自己的东西,最不能少的就是那条记录。
 *
 * 于是顺序改成:**先落记录、再触发更新、立刻回包**。代价是回包那一刻还不知道这一版
 * 生没生效 —— 那就**如实写「待重启确认」**(`EVOLUTION_PENDING`),由重启之后那一段
 * 「收尾」(`selfShipFollowUp.ts`)去读**装到盘上那一份** package.json 对一次版本号,
 * 再把它改成「已生效」,或者在收件箱里说一句「更新没生效」。
 * **不写一个"已生效"了事** —— 那是编一件还没发生的事。
 *
 * ## 为什么"每一步失败就停",而不是重试
 *
 * 设计文档第三节:「失败就停:测试红、合并冲突、发版失败都进收件箱叫人,
 * **不自动重试三次以上**。」卡里收得更紧:「不自动重试超过一次」。
 *
 * 这里取的是**一次都不自动重试**(0 ≤ 1,两边都满足)。理由不是保守:
 * 这八步里没有一步是"抖一下就好"的 —— 测试红重跑还是红,ff 不动重来还是不动,
 * 发版脚本失败往往是网或者 ssh。**重试唯一的作用是让她晚几分钟才知道出事了。**
 * 要再来一次,由她在卡上再点一次 —— 那一次有人看着。
 *
 * ## 用例里**没有一次真的发版**
 *
 * `publish` 与 `applyUpdate` 都是注进来的。跑发版脚本那一下会往公网 rsync 产物,
 * `/update/apply` 那一下会把这台机器上跑着的工作台换掉 —— 两样都**只由生产接线传真的**,
 * 用例里全是假的(`tests/server-self-ship.test.ts` 里连一条真命令都没有,
 * git 是在 `mkdtemp` 出来的临时仓库里真跑的,那是这个文件唯一真碰的东西)。
 *
 * ## 这一层不碰卡、不碰收件箱、不打电话
 *
 * 它只回一份"跑到哪一步、为什么停"的结果。把结果落到卡上(`self_ship`)、
 * 停下来时排一通电话、往收件箱里放一条 —— 那是 `http.ts` 与既有那几条路的事
 * (与 `featureRun.ts`「这一层不起任何活」同一条分寸)。
 */
import { DECISION_RECORD_REL } from '../protocol.ts'
import type { DecisionEntry } from './featureRun.ts'
import {
  FEATURE_DOC_FILES, appendDecisionRecord, parseDecisionEntry, recordDay,
} from './featureRun.ts'
import type { RunCommand } from './featureResult.ts'
import { tailLines } from './featureResult.ts'
import {
  EVOLUTION_LOG_REL, EVOLUTION_PENDING, PUBLISH_SCRIPT_REL, RELEASE_LOG_REL, SELF_PACKAGE_REL,
  bumpPatch, evolutionSection, guardBlockedNote, guardSelfPaths, insertReleaseRow,
  joinRel, packagesOfPaths, releaseDay, releaseRow, shipCommitMessage, versionOfPackageJson, withArgOf,
} from './selfUpdate.ts'

/* ──────────────────────── 八步 ──────────────────────── */

export type SelfShipStepId = 'guard' | 'test' | 'merge' | 'version' | 'commit' | 'publish' | 'apply' | 'record'

/**
 * 每一步在卡上叫什么(人话)。**一处定义**,界面与日志都念这一份;
 * **这个数组的顺序就是跑的顺序**(`runSelfShip` 按它一步一步往下走,有用例钉着)。
 *
 * ★ `record` 在 `apply` **前面**,见文件头「为什么「记录」在「更新」之前」那一段。
 */
export const SELF_SHIP_STEPS: readonly { id: SelfShipStepId, title: string }[] = [
  { id: 'guard', title: '过一遍不许改的东西' },
  { id: 'test', title: '全量测试' },
  { id: 'merge', title: '合并到 main(只许快进)' },
  { id: 'version', title: '版本号 +1、发版记录添一行' },
  { id: 'commit', title: '提交并推上去' },
  { id: 'publish', title: '跑发版脚本' },
  { id: 'record', title: '决策记录与进化日志' },
  { id: 'apply', title: '这台电脑热更新' },
]

/** 按下更新之后回给界面的那一句。**一处定义**,回包与卡上那一步念的是同一句。 */
export const APPLY_TRIGGERED_NOTE = '已触发热更新,重启后见'

/**
 * 自动重试几次。**0**。这个常量存在只是为了让"不重试"是一条写下来的规矩,
 * 而不是某个人忘了写重试(见文件头那一段)。
 */
export const SELF_SHIP_MAX_RETRY = 0

export type SelfShipStepStatus = 'ok' | 'failed' | 'skipped' | 'pending'

export interface SelfShipStepView {
  id: SelfShipStepId
  title: string
  status: SelfShipStepStatus
  /** 这一步的一句话(成了写做了什么,没成写**原话**)。 */
  note?: string
  at?: string
}

export interface SelfShipResult {
  ok: boolean
  /** 停在哪一步。成了就没有这个字段。 */
  stopped_at?: SelfShipStepId
  /**
   * 没成:停下来的**原话**(收件箱那一条与电话里念的就是它)。
   * 成了:{@link APPLY_TRIGGERED_NOTE} —— 「已触发热更新,重启后见」。
   */
  note?: string
  /** 发出去的那一版。走到第 ④ 步之后才有。 */
  version?: string
  /** 之前那一版(「怎么撤」里要写)。 */
  previous_version?: string
  steps: readonly SelfShipStepView[]
  started_at: string
  ended_at: string
}

/* ──────────────────────── 注进来的那几样 ──────────────────────── */

export interface SelfShipDeps {
  /** 跑一条命令(git / npm / pnpm)。用例里是假的。 */
  run: RunCommand
  readText: (path: string) => Promise<string | undefined>
  writeText: (path: string, text: string) => Promise<void>
  /**
   * **真的会往公网推东西的那一下**:`bash deploy/publish-update.sh`。
   * 单拎出来做一个注入点,就是为了让用例**没有任何办法**不小心跑到它。
   */
  publish: (input: { withArg: string, notes: string, cwd: string }) => Promise<{ code: number, out: string }>
  /**
   * `POST /update/apply`。同上:用例里是假的。
   *
   * ★ **它回的只是"这条更新作业起来了没有"**,不是"更新成了没有" —— 那一下会把
   * 这个进程换掉并重启,没有任何办法在这里等到结果(见文件头)。
   */
  applyUpdate: () => Promise<{ ok: boolean, note?: string }>
  now: () => Date
  /** `$HOME`,硬边界判 `~/.dsh` 要用。 */
  home?: string
}

export interface SelfShipInput {
  /** 项目根(= main 的那份 checkout)。合并、提交、发版都在这里。 */
  projectPath: string
  /** 分支上那份 checkout(worktree)。**测试跑在这里**——它就是合并之后的那棵树。 */
  worktree: string
  branch: string
  /** 需求名(= 卡的标题,也是需求目录名)。 */
  name: string
  /** 需求目录(`docs/需求/<名>/`)。第 ⑦ 步去那里读 `记录.md`。 */
  featureDir: string
  /** 人话:这一版她会看到什么。来自 `需求.md`,发版记录与 `--notes` 用的都是它。 */
  notes: string
  /** 发版记录最后一列写哪份交接。没有就写 `—`。 */
  handoff?: string
  /** 这一笔是哪条 DSH 会话做的(提交署名尾行按事实写)。 */
  sessionId?: string
}

/* ──────────────────────── 开分支(派活之前) ──────────────────────── */

export interface PrepareBranchResult {
  ok: boolean
  branch?: string
  worktree?: string
  /** 这一次是新开的还是本来就在。 */
  created?: boolean
  reason?: string
}

/**
 * 派活**之前**先把分支与 worktree 开出来(卡里第 1 条)。
 *
 * **不在 main 的 checkout 上改**:子事项都在 `.claude/worktrees/<slug>` 里做。
 * 理由是这个仓库自己的老教训(记忆「合并在主 checkout 做」):main 那份 checkout
 * 是发版与合并用的,在上面直接改,一次没收干净的改动就会跟着下一次发版走出去。
 *
 * 分支已经在、worktree 也已经在 —— **当成功回**(`created:false`)。
 * 一条需求推进两次不该在第二次炸掉;而"已经开好了"正是第二次该有的样子。
 */
export async function prepareSelfBranch(
  deps: Pick<SelfShipDeps, 'run'> & {
    /**
     * **新开** worktree 成功那一拍回调(2026-10-23,卡「派活给名片的四处」②):把主检出里已有的
     * `<子目录>/node_modules` 软链过去、写进 `info/exclude`(`worktreeDeps.ts`,生产接线在 http.ts)。
     * `created:false`(早就开着)不调 —— 那家自己装过的不动。链接不上不许把「开工作区」整件事拖失败:
     * 实现自己兜(缺 node_modules 那家照旧自己装)。
     */
    afterCreate?: (created: { projectPath: string, worktree: string }) => Promise<void>
  },
  input: { projectPath: string, branch: string, worktree: string },
): Promise<PrepareBranchResult> {
  const cwd = input.projectPath
  const listed = await deps.run({ cmd: 'git', args: ['worktree', 'list', '--porcelain'], cwd })
  if (listed.code !== 0) {
    return { ok: false, reason: `这个目录问不出 git worktree(退出码 ${listed.code}),它是一个 git 仓库吗` }
  }
  /**
   * 已经开过了吗。**按分支认,不只按路径认**:
   *
   * - 路径:macOS 上 `mkdtemp` 给的是 `/var/folders/…`,而 `/var` 是 `/private/var` 的软链,
   *   git 回的是解析过的那一份 —— 两边直接字符串比会漏(用例第一次就踩到了)。
   *   所以比之前先把 `/private` 这一截剥掉;
   * - 分支:同一条分支在别处已经 checkout 了的话,`git worktree add` 一定会失败。
   *   与其等它报一句英文错,不如**先认出来并把那个路径回给调用方** ——
   *   子事项该去的就是它,不是我们本来想开的那个。
   */
  const bare = (one: string): string => (one.startsWith('/private/') ? one.slice('/private'.length) : one)
  let current: string | undefined
  for (const raw of listed.out.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${input.branch}` && current !== undefined) {
      return { ok: true, branch: input.branch, worktree: current, created: false }
    }
    if (current !== undefined && bare(current) === bare(input.worktree)) {
      return { ok: true, branch: input.branch, worktree: current, created: false }
    }
  }

  const exists = await deps.run({ cmd: 'git', args: ['rev-parse', '--verify', '--quiet', input.branch], cwd })
  const args = exists.code === 0
    ? ['worktree', 'add', input.worktree, input.branch]
    : ['worktree', 'add', input.worktree, '-b', input.branch]
  const added = await deps.run({ cmd: 'git', args, cwd })
  if (added.code !== 0) {
    return { ok: false, reason: `开不出分支 ${input.branch}:${tailLines(added.out, 10).text}` }
  }
  if (deps.afterCreate !== undefined) {
    try { await deps.afterCreate({ projectPath: cwd, worktree: input.worktree }) }
    catch { /* 软链依赖是加分项:链不上那家照旧自己装,不许拖垮「开工作区」 */ }
  }
  return { ok: true, branch: input.branch, worktree: input.worktree, created: true }
}

/* ──────────────────────── 八步本体 ──────────────────────── */

/**
 * 跑完这条闭环。**顺序写死**,每一步失败当场返回(不往下走、不重试)。
 */
export async function runSelfShip(input: SelfShipInput, deps: SelfShipDeps): Promise<SelfShipResult> {
  const startedAt = deps.now().toISOString()
  const steps: SelfShipStepView[] = SELF_SHIP_STEPS.map(one => ({ ...one, status: 'pending' as SelfShipStepStatus }))
  let version: string | undefined
  let previousVersion: string | undefined
  let commitSha: string | undefined

  const mark = (id: SelfShipStepId, status: SelfShipStepStatus, note?: string): void => {
    const step = steps.find(one => one.id === id)
    if (step === undefined) return
    step.status = status
    step.at = deps.now().toISOString()
    if (note !== undefined) step.note = note
  }
  const stop = (id: SelfShipStepId, note: string): SelfShipResult => {
    mark(id, 'failed', note)
    return {
      ok: false,
      stopped_at: id,
      note,
      ...(version === undefined ? {} : { version }),
      ...(previousVersion === undefined ? {} : { previous_version: previousVersion }),
      steps,
      started_at: startedAt,
      ended_at: deps.now().toISOString(),
    }
  }

  /**
   * ① 边界 —— 合并之前过。合完再发现改了 `deploy/` 已经晚了。
   *
   * ★ `-c core.quotepath=false` **不是可有可无的**:git 默认会把非 ASCII 路径转义成
   * `"docs/\344\272\244\346\216\245-…"`,而这个仓库里一半的 docs 是中文名 ——
   * 不关掉它,`docs/交接-*` 那条边界会**静默失效**(用例第一次跑就是这么红的)。
   */
  const diff = await deps.run({
    cmd: 'git',
    args: ['-c', 'core.quotepath=false', 'diff', '--name-only', `main...${input.branch}`],
    cwd: input.projectPath,
  })
  if (diff.code !== 0) {
    return stop('guard', `问不出 ${input.branch} 上改了哪些文件(退出码 ${diff.code}):${tailLines(diff.out, 10).text}`)
  }
  const changed = diff.out.split('\n').map(one => one.trim()).filter(one => one !== '')
  if (changed.length === 0) {
    return stop('guard', `${input.branch} 相对 main 一个文件都没改 —— 没有可发的东西`)
  }
  const verdict = guardSelfPaths(changed, {
    projectPath: input.projectPath,
    ...(deps.home === undefined ? {} : { home: deps.home }),
  })
  if (!verdict.ok) return stop('guard', guardBlockedNote(verdict))
  const packages = packagesOfPaths(changed)
  mark('guard', 'ok', `改了 ${changed.length} 个文件,都在能改的范围里;要跑与要发的是:${packages.map(one => one.title).join(' / ')}`)

  /* ② 全量测试 —— 跑在 worktree 里,它就是合并之后的那棵树。 */
  const testNotes: string[] = []
  for (const pkg of packages) {
    for (const command of pkg.tests) {
      const [cmd, ...args] = command
      if (cmd === undefined) continue
      const cwd = joinRel(input.worktree, pkg.dir)
      const ran = await deps.run({ cmd, args, cwd })
      if (ran.code !== 0) {
        return stop('test', `${pkg.title} 的 \`${command.join(' ')}\` 没通过(退出码 ${ran.code}):\n${tailLines(ran.out, 40).text}`)
      }
      testNotes.push(`${pkg.title} ${command.join(' ')} 绿`)
    }
  }
  mark('test', 'ok', testNotes.join(';'))

  /* ③ 合并 —— **只许快进**。不能 ff 就停下叫人,一次 rebase 都不替她做。 */
  const merged = await deps.run({
    cmd: 'git',
    args: ['merge', '--ff-only', input.branch],
    cwd: input.projectPath,
  })
  if (merged.code !== 0) {
    return stop('merge', `${input.branch} 快进不到 main(main 上有它没有的提交,或者撞了文件)。`
      + `**没有替你 rebase,也没有合**,请人来看一眼:\n${tailLines(merged.out, 20).text}`)
  }
  mark('merge', 'ok', `${input.branch} 已经快进合进 main`)

  /* ④ 版本号 + 发版记录 */
  const pkgPath = joinRel(input.projectPath, SELF_PACKAGE_REL)
  const before = await deps.readText(pkgPath)
  previousVersion = before === undefined ? undefined : versionOfPackageJson(before)
  if (previousVersion === undefined) return stop('version', `${SELF_PACKAGE_REL} 里读不出版本号,没敢往下走`)
  const expected = bumpPatch(previousVersion)
  if (expected === undefined) return stop('version', `${previousVersion} 不是 x.y.z 的样子,补丁位加不了`)

  const bumped = await deps.run({
    cmd: 'npm',
    args: ['version', 'patch', '--no-git-tag-version'],
    cwd: joinRel(input.projectPath, 'workbench-plugin'),
  })
  if (bumped.code !== 0) {
    return stop('version', `npm version patch 没跑成(退出码 ${bumped.code}):${tailLines(bumped.out, 10).text}`)
  }
  const after = await deps.readText(pkgPath)
  version = after === undefined ? undefined : versionOfPackageJson(after)
  if (version === undefined || version === previousVersion) {
    return stop('version', `版本号没变(还是 ${previousVersion})—— npm version 说成了,但文件里不是那么写的`)
  }

  const logPath = joinRel(input.projectPath, RELEASE_LOG_REL)
  const logText = await deps.readText(logPath)
  if (logText === undefined) return stop('version', `${RELEASE_LOG_REL} 不在,发版记录那一行插不进去`)
  const inserted = insertReleaseRow(logText, releaseRow({
    version,
    day: releaseDay(deps.now()),
    notes: input.notes,
    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
  }))
  if (!inserted.ok) return stop('version', inserted.reason)
  try { await deps.writeText(logPath, inserted.text) }
  catch (error) { return stop('version', `写不进 ${RELEASE_LOG_REL}:${(error as Error).message}`) }
  mark('version', 'ok', `${previousVersion} → ${version},发版记录第 7 行添了一行`)

  /* ⑤ 提交并推上去 —— **只 add 这一步自己改的那两个文件**。 */
  const added = await deps.run({
    cmd: 'git',
    args: ['add', SELF_PACKAGE_REL, RELEASE_LOG_REL],
    cwd: input.projectPath,
  })
  if (added.code !== 0) return stop('commit', `git add 没跑成(退出码 ${added.code}):${tailLines(added.out, 10).text}`)
  const committed = await deps.run({
    cmd: 'git',
    args: ['commit', '-m', shipCommitMessage({
      version,
      name: input.name,
      notes: input.notes,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    })],
    cwd: input.projectPath,
  })
  if (committed.code !== 0) {
    return stop('commit', `提交没成(退出码 ${committed.code}):${tailLines(committed.out, 20).text}`)
  }
  const head = await deps.run({ cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: input.projectPath })
  commitSha = head.code === 0 ? head.out.trim() : undefined
  const pushed = await deps.run({ cmd: 'git', args: ['push'], cwd: input.projectPath })
  if (pushed.code !== 0) {
    return stop('commit', `推不上去(退出码 ${pushed.code})。**main 上已经有这一笔了**,`
      + `等网好了自己 git push 一次就行:\n${tailLines(pushed.out, 20).text}`)
  }
  mark('commit', 'ok', `提交了${commitSha === undefined ? '' : ` ${commitSha}`},也推上去了`)

  /* ⑥ 发版脚本 —— 真的会往公网推东西的那一下。 */
  const withArg = withArgOf(packages)
  const published = await deps.publish({ withArg, notes: input.notes, cwd: input.projectPath })
  if (published.code !== 0) {
    return stop('publish', `${PUBLISH_SCRIPT_REL} 没跑成(退出码 ${published.code}):\n${tailLines(published.out, 30).text}`)
  }
  mark('publish', 'ok', `发了 ${version}(--with ${withArg})`)

  /**
   * ⑦ 记录 —— 决策记录一条、进化日志一条。
   *
   * ★ **在热更新之前**。下一步会把这个进程换掉并重启,记录留到那之后就永远写不成了
   * (见文件头)。所以这一节此刻的状态如实是「待重启确认」,不是「已生效」。
   */
  const day = recordDay(deps.now())
  const who = `事务官(${input.sessionId === undefined || input.sessionId.trim() === '' ? 'DSH 会话' : `DSH 会话 ${input.sessionId.trim()}`})`
  const entry = await decisionEntryFor(input, deps, { version, who })
  const record = await appendDecisionRecord({
    projectPath: input.projectPath,
    day,
    name: input.name,
    entry,
  })
  if (!record.ok) {
    return stop('record', `写不进 ${DECISION_RECORD_REL}:${record.reason ?? '不知道为什么'}。`
      + `**这一版已经发出去了**(${version}),只差这一条记录 —— 这台电脑还没更新(记录写不成就不按更新)。`)
  }
  const evoPath = joinRel(input.projectPath, EVOLUTION_LOG_REL)
  const evoBefore = await deps.readText(evoPath)
  const section = evolutionSection({
    day,
    what: input.notes,
    who,
    version,
    previousVersion,
    ...(commitSha === undefined ? {} : { commit: commitSha }),
  })
  try {
    await deps.writeText(
      evoPath,
      evoBefore === undefined
        ? `# 进化日志\n\n每一次「改自己」在这里留一条:哪天、什么、谁做的、版本号、怎么撤。\n\n${section}`
        : `${evoBefore.endsWith('\n') ? evoBefore : `${evoBefore}\n`}\n${section}`,
    )
  }
  catch (error) {
    return stop('record', `写不进 ${EVOLUTION_LOG_REL}:${(error as Error).message}。**这一版已经发出去了**(${version}),`
      + '这台电脑还没更新(记录写不成就不按更新)')
  }
  mark('record', 'ok', `决策记录与进化日志各添了一条(${day});进化日志那一条现在标着「${EVOLUTION_PENDING}」`)

  /**
   * ⑧ 热更新 —— **按下就回**,一秒都不等。
   *
   * 这一下会把**正在跑这条请求的这个进程**换掉并重启,所以"等版本号变了才算过"
   * 在这里是做不到的事(见文件头)。`applyUpdate` 回的只是"这条更新作业起来了没有":
   * 起不来是真的失败(停在这一步,前面七步都在,重来一次只差这一下);
   * 起来了就**当这一步过了**,这一版到底生没生效由重启之后那一段「收尾」去对
   * (`selfShipFollowUp.ts` 读装到盘上那一份 package.json)。
   */
  const applied = await deps.applyUpdate()
  if (!applied.ok) {
    return stop('apply', `这台电脑没更新成:${applied.note ?? '更新那一下就没起来'}。`
      + `**${version} 已经发出去了**,也已经记进了进化日志(标着「${EVOLUTION_PENDING}」),`
      + '去设置里点一次「检查更新」就行。')
  }
  mark('apply', 'ok', `${APPLY_TRIGGERED_NOTE}(发的是 ${version})`)

  return {
    ok: true,
    note: APPLY_TRIGGERED_NOTE,
    version,
    previous_version: previousVersion,
    steps,
    started_at: startedAt,
    ended_at: deps.now().toISOString(),
  }
}

/**
 * 决策记录那四行怎么来。
 *
 * **先看 `记录.md`**:事务官写过就用它那一份(`/feature/record` 那条路读的也是它,
 * 同一份真相不做两套)。没写过或者缺行,就用**这条闭环自己手上的事实**兜底:
 * 需求名、这一版的人话、谁做的、版本号 —— 全是发生过的事,一个字都不是编的;
 * 「遗留」那一行写清**它是空的以及为什么**,不写一句「无」。
 *
 * 一条自己编出来的「遗留:无」会变成半年后没人敢信的历史(`featureRun.ts` 逐字同一条)。
 */
async function decisionEntryFor(
  input: SelfShipInput,
  deps: Pick<SelfShipDeps, 'readText'>,
  facts: { version: string, who: string },
): Promise<DecisionEntry> {
  const draft = await deps.readText(joinRel(input.featureDir, FEATURE_DOC_FILES.记录))
  if (draft !== undefined && draft.trim() !== '') {
    const parsed = parseDecisionEntry(draft)
    if (parsed.ok) return parsed.entry
  }
  return {
    need: input.name,
    did: `${input.notes}(发到 ${facts.version})`,
    who: facts.who,
    left: `事务官还没写 ${FEATURE_DOC_FILES.记录},遗留待补 —— 去需求卡「记录」页签补齐再点一次「写进决策记录」`,
  }
}
