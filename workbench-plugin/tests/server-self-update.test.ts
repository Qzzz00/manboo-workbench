// @vitest-environment node
/**
 * 「改工作台自己」的判据、硬边界与那几样纯算(2026-09-23,断点 C)。
 *
 * 这一份钉的性质:
 *
 * 1. **判据两条都要**:少一条就不是"我自己"(别人仓库里放一个同名脚本拿不到这条路);
 * 2. **硬边界是可执行的**(设计文档第三节):`deploy/`、`.claude/`、`docs/交接-*`、
 *    `~/.dsh`、仓库外面 —— 一条都别想混过去,而 `docs/发版记录.md` 必须放行;
 * 3. 分支名从中文需求名**原样**拼得出来,git 真的不认的那些字符被挑掉;
 * 4. 发版记录那一行插在**第 7 行**,表头对不上时**拒绝**而不是"尽量插"。
 */
import { describe, expect, it } from 'vitest'
import {
  PUBLISH_SCRIPT_REL, RELEASE_LOG_REL, RELEASE_ROW_LINE, SELF_PACKAGE_NAME, SELF_PACKAGE_REL,
  EVOLUTION_CONFIRMED, EVOLUTION_PENDING, confirmEvolutionSection, isEvolutionPending, parseLatestEvolution,
  branchOfFeature, bumpPatch, detectSelfProject, evolutionSection, featureSlug, guardBlockedNote,
  guardSelfPaths, insertReleaseRow, isUnderDshHome, notesFromRequirement, packagesOfPaths,
  releaseDay, releaseRow, shipCommitMessage, shipTrailer, versionOfPackageJson, withArgOf,
  worktreeOfFeature,
} from '../src/server/selfUpdate.ts'

const REPO = '/Users/example/Documents/GitHub/desktop-workbench'

/** 一份假仓库:给哪几个文件就有哪几个文件。 */
function fakeRead(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string | undefined> => files[path]
}

describe('判据:这是不是「我自己」', () => {
  it('两条都在 = 是', async () => {
    const verdict = await detectSelfProject(REPO, fakeRead({
      [`${REPO}/${PUBLISH_SCRIPT_REL}`]: '#!/usr/bin/env bash\n',
      [`${REPO}/${SELF_PACKAGE_REL}`]: JSON.stringify({ name: SELF_PACKAGE_NAME, version: '0.2.64' }),
    }))
    expect(verdict.self).toBe(true)
    expect(verdict.why).toContain(SELF_PACKAGE_NAME)
  })

  it('只有发版脚本、包名不对 = 不是(谁放一个同名脚本都拿不到这条路)', async () => {
    const verdict = await detectSelfProject(REPO, fakeRead({
      [`${REPO}/${PUBLISH_SCRIPT_REL}`]: '#!/usr/bin/env bash\n',
      [`${REPO}/${SELF_PACKAGE_REL}`]: JSON.stringify({ name: '@someone/else' }),
    }))
    expect(verdict.self).toBe(false)
    expect(verdict.why).toContain('@someone/else')
  })

  it('没有发版脚本 = 不是,而且说清是缺哪一份', async () => {
    const verdict = await detectSelfProject(REPO, fakeRead({
      [`${REPO}/${SELF_PACKAGE_REL}`]: JSON.stringify({ name: SELF_PACKAGE_NAME }),
    }))
    expect(verdict.self).toBe(false)
    expect(verdict.why).toContain(PUBLISH_SCRIPT_REL)
  })

  it('package.json 读坏了 = 按"不是我自己"办(不猜)', async () => {
    const verdict = await detectSelfProject(REPO, fakeRead({
      [`${REPO}/${PUBLISH_SCRIPT_REL}`]: '#!\n',
      [`${REPO}/${SELF_PACKAGE_REL}`]: '{ 这不是 JSON',
    }))
    expect(verdict.self).toBe(false)
  })
})

describe('分支名', () => {
  it('中文原样留着(她要在 git branch 里认得出自己那条需求)', () => {
    expect(branchOfFeature('把座机页的时钟字号调大一号')).toBe('feat/把座机页的时钟字号调大一号')
  })

  it('空白变 -,git 真的不认的那几个字符挑掉', () => {
    expect(featureSlug('加一个 导出 PDF')).toBe('加一个-导出-PDF')
    expect(featureSlug('a~b^c:d?e*f[g]')).toBe('abcdefg')
    expect(featureSlug('a/b/c')).toBe('a-b-c')
    expect(featureSlug('..隐藏..')).toBe('隐藏')
  })

  it('一个字都不剩 = undefined,**不编一个 feat/feature-1**', () => {
    expect(featureSlug('~^:?*')).toBeUndefined()
    expect(branchOfFeature('   ')).toBeUndefined()
    expect(worktreeOfFeature(REPO, '~~~')).toBeUndefined()
  })

  it('worktree 落 .claude/worktrees/<slug>(不在 main 那份 checkout 上改)', () => {
    expect(worktreeOfFeature(REPO, '导出 PDF')).toBe(`${REPO}/.claude/worktrees/导出-PDF`)
  })
})

describe('硬边界(设计文档第三节)', () => {
  it('能改的:四个包里的文件,以及 docs/发版记录.md', () => {
    const verdict = guardSelfPaths([
      'workbench-plugin/src/server/http.ts',
      'butler-app/src/App.tsx',
      'channel-worker/src/tools.ts',
      'butler-server/server/index.cjs',
      RELEASE_LOG_REL,
      'docs/设计-中秋目标.md',
    ], { projectPath: REPO, home: '/Users/example' })
    expect(verdict.ok).toBe(true)
    expect(verdict.blocked).toEqual([])
  })

  it('deploy/ 被拒 —— 改自己的那条路不能顺手改开门的那把锁', () => {
    const verdict = guardSelfPaths(['workbench-plugin/src/index.ts', 'deploy/publish-update.sh'], {
      projectPath: REPO,
      home: '/Users/example',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.blocked).toHaveLength(1)
    expect(verdict.blocked[0]?.path).toBe('deploy/publish-update.sh')
    expect(guardBlockedNote(verdict)).toContain('deploy/publish-update.sh')
    expect(guardBlockedNote(verdict)).toContain('发版链本身')
  })

  it('.claude/、docs/交接-*、~/.dsh、仓库外面 —— 一条都混不过去', () => {
    const verdict = guardSelfPaths([
      '.claude/settings.json',
      'docs/交接-0923-事务官改自己闭环.md',
      '/Users/example/.dsh/AGENTS.md',
      '~/.dsh/workbench/tasks.json',
      '/etc/hosts',
      'workbench-plugin/../../外面.txt',
    ], { projectPath: REPO, home: '/Users/example' })
    expect(verdict.ok).toBe(false)
    expect(verdict.blocked.map(one => one.path)).toEqual([
      '.claude/settings.json',
      'docs/交接-0923-事务官改自己闭环.md',
      '/Users/example/.dsh/AGENTS.md',
      '~/.dsh/workbench/tasks.json',
      '/etc/hosts',
      'workbench-plugin/../../外面.txt',
    ])
  })

  it('仓库里的绝对路径换算成相对之后照样过门', () => {
    expect(guardSelfPaths([`${REPO}/deploy/codesign-identity.sh`], { projectPath: REPO }).ok).toBe(false)
    expect(guardSelfPaths([`${REPO}/workbench-plugin/src/a.ts`], { projectPath: REPO }).ok).toBe(true)
  })

  it('~/.dsh 两种写法都认;没有 home 时只认 ~ 那一种', () => {
    expect(isUnderDshHome('~/.dsh/AGENTS.md')).toBe(true)
    expect(isUnderDshHome('/Users/example/.dsh/AGENTS.md', '/Users/example')).toBe(true)
    expect(isUnderDshHome('/Users/example/.dshx/AGENTS.md', '/Users/example')).toBe(false)
    expect(isUnderDshHome('/Users/example/Documents/a.ts', '/Users/example')).toBe(false)
  })
})

describe('改到了哪几个包', () => {
  it('插件永远在里面(全量测试跑的就是它,热更新的主体也是它)', () => {
    expect(packagesOfPaths(['docs/发版记录.md']).map(one => one.dir)).toEqual(['workbench-plugin'])
  })

  it('改到别的包就各跑各的,顺序是确定的', () => {
    const packages = packagesOfPaths(['channel-worker/src/a.ts', 'butler-app/src/b.tsx'])
    expect(packages.map(one => one.dir)).toEqual(['workbench-plugin', 'butler-app', 'channel-worker'])
    // 脚本自己会把 plugin 补在最前面,所以 --with 里不重复写它。
    expect(withArgOf(packages)).toBe('apk,worker')
    expect(withArgOf(packagesOfPaths(['workbench-plugin/src/a.ts']))).toBe('plugin')
  })

  it('butler-server 没有 typecheck 脚本 —— **不编一条跑不起来的命令**', () => {
    const one = packagesOfPaths(['butler-server/server/index.cjs']).find(pkg => pkg.dir === 'butler-server')
    expect(one?.tests).toEqual([['pnpm', 'vitest', 'run']])
  })
})

describe('版本号与发版记录', () => {
  it('补丁位加一;认不出的回 undefined(不编一个 0.0.1)', () => {
    expect(bumpPatch('0.2.64')).toBe('0.2.65')
    expect(bumpPatch('1.0.9')).toBe('1.0.10')
    expect(bumpPatch('0.2')).toBeUndefined()
    expect(bumpPatch('v0.2.64')).toBeUndefined()
  })

  it('从 package.json 里取版本号', () => {
    expect(versionOfPackageJson('{"version":"0.2.64"}')).toBe('0.2.64')
    expect(versionOfPackageJson('{}')).toBeUndefined()
    expect(versionOfPackageJson('坏的')).toBeUndefined()
  })

  it('那一行插在第 7 行,最新的在最上面', () => {
    const before = [
      '# 发版记录',
      '',
      '一版一行。',
      '',
      '| 版本 | 日期 | 你会看到什么 | 交接 |',
      '|---|---|---|---|',
      '| 0.2.64 | 09-23 | 老的那一版 | 交接-0922.md |',
      '',
    ].join('\n')
    const row = releaseRow({ version: '0.2.65', day: '09-23', notes: '时钟大了一号', handoff: '交接-0923.md' })
    const inserted = insertReleaseRow(before, row)
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    const lines = inserted.text.split('\n')
    expect(lines[RELEASE_ROW_LINE - 1]).toBe(row)
    expect(lines[RELEASE_ROW_LINE]).toContain('0.2.64')
  })

  it('表头对不上就**拒绝**,不"尽量插在看起来像表的地方"', () => {
    const broken = ['# 发版记录', '', '没有表。', '', '', '', ''].join('\n')
    const result = insertReleaseRow(broken, '| 0.2.65 | 09-23 | x | — |')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(RELEASE_LOG_REL)
  })

  it('那一行里的竖线换成全角,换行压成空格(否则表会散)', () => {
    const row = releaseRow({ version: '0.2.65', day: '09-23', notes: '改了 a | b\n还有 c' })
    expect(row).toBe('| 0.2.65 | 09-23 | 改了 a ｜ b 还有 c | — |')
  })

  it('日期是 MM-DD(与表里既有每一行同一个写法)', () => {
    expect(releaseDay(new Date(2026, 8, 23))).toBe('09-23')
  })
})

describe('署名与进化日志', () => {
  it('署名尾行**按事实写**:事务官 = 那条 DSH 会话', () => {
    expect(shipTrailer('sess-1')).toBe('Co-Authored-By: 事务官(DSH 会话 sess-1) <butler@dsh.local>')
    expect(shipTrailer(undefined)).toContain('会话不详')
    expect(shipCommitMessage({ version: '0.2.65', name: '导出 PDF', notes: '时钟大了一号', sessionId: 's1' }))
      .toContain('Co-Authored-By: 事务官(DSH 会话 s1)')
  })

  it('进化日志那一条有六样:哪天、什么、谁做的、版本号、状态、怎么撤', () => {
    const section = evolutionSection({
      day: '2026-09-23',
      what: '时钟大了一号',
      who: '事务官(DSH 会话 s1)',
      version: '0.2.65',
      previousVersion: '0.2.64',
      commit: 'abc1234',
    })
    for (const field of ['哪天', '什么', '谁做的', '版本号', '状态', '怎么撤']) expect(section).toContain(`- ${field}:`)
    expect(section).toContain('git revert abc1234')
    expect(section).toContain('0.2.64')
  })

  /**
   * ★ 状态那一行(2026-09-23 接线时加的)。
   *
   * 闭环落这一节的时候热更新还没重启完,**这一刻它到底生没生效是不知道的**。
   * 写「已生效」就是编一件没发生的事,所以缺省如实写「待重启确认」,
   * 由重启之后那一段收尾(`selfShipFollowUp.ts`)改成结论。
   */
  it('状态缺省是「待重启确认」——**不编一句「已生效」**', () => {
    const section = evolutionSection({ day: '2026-09-23', what: 'x', who: 'y', version: '0.2.65' })
    expect(section).toContain(`- 状态:${EVOLUTION_PENDING}`)
    expect(section).not.toContain(EVOLUTION_CONFIRMED)
  })

  it('最近那一节解得出版本号与状态(收尾要看的就是这两样)', () => {
    const text = [
      evolutionSection({ day: '2026-09-20', what: '老的', who: 'y', version: '0.2.63', status: EVOLUTION_CONFIRMED }),
      evolutionSection({ day: '2026-09-23', what: '时钟大了一号', who: 'y', version: '0.2.65' }),
    ].join('\n')
    const latest = parseLatestEvolution(text)
    // **最后**那一节才是刚发的那一版(这个文件是往后追加的)。
    expect(latest?.version).toBe('0.2.65')
    expect(latest?.what).toBe('时钟大了一号')
    expect(isEvolutionPending(latest)).toBe(true)
    expect(parseLatestEvolution('# 进化日志\n\n一条都还没有。\n')).toBeUndefined()
  })

  it('确认那一下**只改状态那一行**;不是待确认 / 没有那一行就拒绝,不替它下结论', () => {
    const text = evolutionSection({ day: '2026-09-23', what: 'x', who: 'y', version: '0.2.65' })
    const done = confirmEvolutionSection(text, { version: '0.2.65', at: '2026-09-23T12:00:00.000Z' })
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.text).toContain(`- 状态:${EVOLUTION_CONFIRMED}`)
      expect(done.text).toContain('2026-09-23T12:00:00.000Z')
      expect(done.text).not.toContain(EVOLUTION_PENDING)
      // 再确认一次会被拒(它已经不是「待重启确认」了)。
      expect(confirmEvolutionSection(done.text, { version: '0.2.65', at: 'x' }).ok).toBe(false)
    }
    // 这一版之前写的那些没有状态那一行 —— **不往里补**,拒绝。
    const older = '## 09-20 老的\n\n- 版本号:0.2.63\n'
    const refused = confirmEvolutionSection(older, { version: '0.2.63', at: 'x' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('状态')
  })
})

describe('人话从需求.md里取', () => {
  it('优先「目标」那一行', () => {
    expect(notesFromRequirement('# 需求\n\n- 目标:把座机页的时钟字号调大一号\n- 边界:只改样式\n'))
      .toBe('把座机页的时钟字号调大一号')
    expect(notesFromRequirement('**目标**:换个说法\n')).toBe('换个说法')
  })

  it('没有「目标」就退到第一段正文', () => {
    expect(notesFromRequirement('# 需求\n\n> 引用\n\n把导出做出来\n')).toBe('把导出做出来')
  })

  it('一个字都没有回 undefined ——**不编一句**', () => {
    expect(notesFromRequirement(undefined)).toBeUndefined()
    expect(notesFromRequirement('# 只有标题\n\n> 只有引用\n')).toBeUndefined()
  })
})
