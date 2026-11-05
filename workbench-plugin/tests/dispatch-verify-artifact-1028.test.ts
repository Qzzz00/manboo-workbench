// @vitest-environment node
/**
 * 按产物核验收(2026-10-28,卡「按产物核交回」):回执把条件原句抄一遍过不了 ——
 * 条件分类型(文件 / diff / 测试输出),产物由**程序**在独立工作区里自己核,
 * 模型只负责指认产物凭据(哪个文件、什么内容、哪条命令),程序核不过 = 这条不过。
 * 核不了(没工作区 / git 跑不了 / 超时 / 命令不敢代跑)如实 unknown,不猜。
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  artifactKindOf,
  createArtifactCheckDeps,
  safeTestCommand,
  verifyAcceptance,
  type ArtifactCheckDeps,
} from '../src/server/dispatchVerify.ts'

const claimInput = { acceptance: ['面板有 Kimi 列'], receipt: '做完了:面板加了 Kimi 列。', title: '接用量' }
const claimOk = '{"items":[{"condition":"面板有 Kimi 列","met":true,"evidence":"面板加了 Kimi 列"}]}'

/** 全部产物核都照替身说的过的 deps;用例逐个覆盖。 */
const stubArtifacts = (over: Partial<ArtifactCheckDeps>): ArtifactCheckDeps => ({
  readFile: async () => undefined,
  differs: async () => undefined,
  runTest: async () => undefined,
  // 洞2 的路径两件:默认「路径直接用、不按文件名找」(老用例的行为一格不动)。
  knownPath: async () => true,
  matchByName: async () => undefined,
  // 任务书第 5 条(1029)的 diff 代跑兜底:默认「git 核不动」(老用例的行为一格不动)。
  changedTestFiles: async () => undefined,
  ...over,
})

describe('artifactKindOf:条件按类型分', () => {
  it('测试输出类', () => {
    expect(artifactKindOf('相关用例全部跑过')).toBe('test')
    expect(artifactKindOf('vitest 定向用例通过')).toBe('test')
    expect(artifactKindOf('类型检查无新增错误')).toBe('test')
  })
  it('diff 类:说改了 / 新增了,没点名具体内容', () => {
    expect(artifactKindOf('改了 README')).toBe('diff')
    expect(artifactKindOf('dispatchVerify.ts 里有改动')).toBe('diff')
    expect(artifactKindOf('新增一张交接文档')).toBe('diff')
  })
  it('文件类:点名的文件 + 内容要求', () => {
    expect(artifactKindOf('README 里写明验收人')).toBe('file')
    expect(artifactKindOf('docs/交接-x.md 里有「可合并」一行')).toBe('file')
  })
  it('纯陈述认不出 → undefined(走老的文本门)', () => {
    expect(artifactKindOf('面板有 Kimi 列')).toBeUndefined()
    expect(artifactKindOf('数字与后台一致')).toBeUndefined()
    expect(artifactKindOf('第一行是「工作台验收」')).toBeUndefined()
  })
})

describe('verifyAcceptance:文件类按产物核', () => {
  const input = { acceptance: ['README 里写明「验收人:验收员甲」'], receipt: '做完了:README 里写明「验收人:验收员甲」。', title: '改 README' }
  const item = '{"items":[{"condition":"README 里写明「验收人:验收员甲」","met":true,"evidence":"README 里写明「验收人:验收员甲」","artifact":{"kind":"file","path":"README.md","contains":"验收人:验收员甲"}}]}'

  it('★回执照抄条件原句、但文件里没有 → 不过(根治:文本门之外核产物)', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ readFile: async () => '# 别的\n' }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
    if (got.verdict === 'fail') expect(got.missing[0]).toContain('验收人:验收员甲')
  })

  it('★文件不存在 → 不过(回执说得再好听也不算)', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ readFile: async () => undefined }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
  })

  it('文件里真有那行 → 过', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ readFile: async () => '# 工作台验收\n验收人:验收员甲\n' }),
    })
    expect(got).toEqual({ verdict: 'pass' })
  })

  it('★混合(第 4 步③):一条明确不过 + 一条核不了 → 整条 fail,核不了那条另列在 missing 里', async () => {
    const two = { acceptance: ['README 里写明「验收人:验收员甲」', 'docs/交接.md 里有「可以合并」一行'], receipt: '做完了:README 里写明「验收人:验收员甲」;docs/交接.md 里有「可以合并」一行。', title: '改 README' }
    const judged = '{"items":[{"condition":"README 里写明「验收人:验收员甲」","met":true,"evidence":"README 里写明「验收人:验收员甲」","artifact":{"kind":"file","path":"README.md","contains":"验收人:验收员甲"}},{"condition":"docs/交接.md 里有「可以合并」一行","met":true,"evidence":"docs/交接.md 里有「可以合并」一行","artifact":{"kind":"file","path":"../交接.md","contains":"可以合并"}}]}'
    const got = await verifyAcceptance({ ...two, workspace: '/ws/x' }, {
      askModel: async () => judged,
      // README 里没有那行(明确不过);交接.md 的凭据路径爬出工作区(核不了,不敢核)。
      artifacts: stubArtifacts({ readFile: async (abs) => abs.endsWith('README.md') ? '# 别的\n' : undefined }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
    if (got.verdict === 'fail') {
      expect(got.missing.some(one => one.includes('验收人:验收员甲'))).toBe(true)
      expect(got.missing.some(one => one.includes('核不了'))).toBe(true)
    }
  })

  it('模型没给产物凭据 / 给错类型 → 核不了(unknown,不猜)', async () => {
    const noArtifact = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => '{"items":[{"condition":"README 里写明「验收人:验收员甲」","met":true,"evidence":"README 里写明「验收人:验收员甲」"}]}',
      artifacts: stubArtifacts({}),
    })
    expect(noArtifact).toMatchObject({ verdict: 'unknown' })
    const wrongKind = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => '{"items":[{"condition":"README 里写明「验收人:验收员甲」","met":true,"evidence":"README 里写明「验收人:验收员甲」","artifact":{"kind":"diff","path":"README.md"}}]}',
      artifacts: stubArtifacts({}),
    })
    expect(wrongKind).toMatchObject({ verdict: 'unknown' })
  })

  it('文件类条件而卡上没有独立工作区 → 核不了(unknown)', async () => {
    const got = await verifyAcceptance(input, { askModel: async () => item, artifacts: stubArtifacts({ readFile: async () => '验收人:验收员甲' }) })
    expect(got).toMatchObject({ verdict: 'unknown' })
  })

  it('产物路径跑出工作区 → 不敢核(unknown)', async () => {
    const escape = '{"items":[{"condition":"README 里写明「验收人:验收员甲」","met":true,"evidence":"README 里写明「验收人:验收员甲」","artifact":{"kind":"file","path":"../../.dsh/ secrets","contains":"验收人:验收员甲"}}]}'
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => escape,
      artifacts: stubArtifacts({ readFile: async () => '验收人:验收员甲' }),
    })
    expect(got).toMatchObject({ verdict: 'unknown' })
  })
})

describe('verifyAcceptance:diff 类按产物核', () => {
  const input = { acceptance: ['改了 README'], receipt: '做完了:改了 README。', title: '改 README' }
  const item = '{"items":[{"condition":"改了 README","met":true,"evidence":"改了 README","artifact":{"kind":"diff","path":"README.md"}}]}'

  it('★回执照抄、文件其实没动 → 不过', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ differs: async () => false }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
  })

  it('文件真有改动 → 过', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ differs: async () => true }),
    })
    expect(got).toEqual({ verdict: 'pass' })
  })

  it('git 核不动 → 核不了(unknown)', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ differs: async () => undefined }),
    })
    expect(got).toMatchObject({ verdict: 'unknown' })
  })
})

describe('verifyAcceptance:测试输出类按产物核', () => {
  const input = { acceptance: ['相关用例全部跑过'], receipt: '做完了:相关用例全部跑过。', title: '补用例' }
  const item = '{"items":[{"condition":"相关用例全部跑过","met":true,"evidence":"相关用例全部跑过","artifact":{"kind":"test","command":"npx vitest run foo.test.ts"}}]}'

  it('★回执照抄、代跑没通过 → 不过', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ runTest: async () => 'fail' }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
  })

  it('代跑通过 → 过', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ runTest: async () => 'pass' }),
    })
    expect(got).toEqual({ verdict: 'pass' })
  })

  it('超时 / 命令不敢代跑 → 核不了(unknown)', async () => {
    const timeout = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ runTest: async () => 'timeout' }),
    })
    expect(timeout).toMatchObject({ verdict: 'unknown' })
    const refused = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => '{"items":[{"condition":"相关用例全部跑过","met":true,"evidence":"相关用例全部跑过","artifact":{"kind":"test","command":"git push --force"}}]}',
      artifacts: stubArtifacts({ runTest: async () => undefined }),
    })
    expect(refused).toMatchObject({ verdict: 'unknown' })
  })
})

describe('任务书第 5 条(1029):描述式条件「用例全过」没带命令 → 按交回 diff 代跑', () => {
  const input = { acceptance: ['任务书里四条用例全过'], receipt: '做完了:四条用例全过。', title: '补用例' }
  const judgedNoCommand = '{"items":[{"condition":"任务书里四条用例全过","met":true,"evidence":"四条用例全过"}]}'

  it('判词没给命令 → 从交回 diff 找用例文件代跑;代跑通过 → 过(真机 10-29 09:50 红例)', async () => {
    const ran: { ws: string, cmd: string }[] = []
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({
        changedTestFiles: async () => [{ root: '', files: ['tests/foo.test.ts'] }],
        runTest: async (ws, cmd) => { ran.push({ ws, cmd }); return 'pass' },
      }),
    })
    expect(got).toEqual({ verdict: 'pass', notes: ['按交回 diff 代跑 tests/foo.test.ts'] })
    expect(ran).toEqual([{ ws: '/ws/x', cmd: 'npx vitest run tests/foo.test.ts --maxWorkers 1' }])
  })

  it('判词给了命令但不敢代跑 → 也回退 diff 代跑(结果当证据)', async () => {
    const judgedBad = '{"items":[{"condition":"任务书里四条用例全过","met":true,"evidence":"四条用例全过","artifact":{"kind":"test","command":"git push --force"}}]}'
    const ran: string[] = []
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedBad,
      artifacts: stubArtifacts({
        changedTestFiles: async () => [{ root: '', files: ['tests/foo.test.ts'] }],
        runTest: async (_ws, cmd) => { ran.push(cmd); return cmd.startsWith('npx') ? 'pass' : undefined },
      }),
    })
    expect(got).toEqual({ verdict: 'pass', notes: ['按交回 diff 代跑 tests/foo.test.ts'] })
    // 先试判词给的命令(不敢代跑),回退 diff 那条也通过 —— 两次代跑都留下了痕迹。
    expect(ran).toEqual(['git push --force', 'npx vitest run tests/foo.test.ts --maxWorkers 1'])
  })

  it('跨包的用例文件分组:各自包目录里代跑,一条命令一个包', async () => {
    const ran: { ws: string, cmd: string }[] = []
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({
        changedTestFiles: async () => [{ root: 'workbench-plugin', files: ['tests/a.test.ts'] }, { root: 'channel-worker', files: ['tests/b.test.ts'] }],
        runTest: async (ws, cmd) => { ran.push({ ws, cmd }); return 'pass' },
      }),
    })
    expect(got).toMatchObject({ verdict: 'pass' })
    expect(ran).toEqual([
      { ws: '/ws/x/workbench-plugin', cmd: 'npx vitest run tests/a.test.ts --maxWorkers 1' },
      { ws: '/ws/x/channel-worker', cmd: 'npx vitest run tests/b.test.ts --maxWorkers 1' },
    ])
  })

  it('交回 diff 里没有用例文件 → 核不了(unknown),说清「找不到用例文件」,卡不退修', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({ changedTestFiles: async () => [] }),
    })
    expect(got).toMatchObject({ verdict: 'unknown' })
    if (got.verdict === 'unknown') expect(got.why).toContain('找不到用例文件')
  })

  it('git 这一拍核不动 → 核不了(unknown),不猜', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({ changedTestFiles: async () => undefined }),
    })
    expect(got).toMatchObject({ verdict: 'unknown' })
  })

  it('回退代跑没通过 → 不过(代跑结果当证据,方向与带命令那条一致)', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({
        changedTestFiles: async () => [{ root: '', files: ['tests/foo.test.ts'] }],
        runTest: async () => 'fail',
      }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
  })

  it('回退代跑超时 / 起不来 → 核不了(unknown)', async () => {
    const timeout = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({ changedTestFiles: async () => [{ root: '', files: ['tests/foo.test.ts'] }], runTest: async () => 'timeout' }),
    })
    expect(timeout).toMatchObject({ verdict: 'unknown' })
    const refused = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judgedNoCommand,
      artifacts: stubArtifacts({ changedTestFiles: async () => [{ root: '', files: ['tests/foo.test.ts'] }], runTest: async () => undefined }),
    })
    expect(refused).toMatchObject({ verdict: 'unknown' })
  })
})

describe('verifyAcceptance:认不出的条件不吃产物门(老文本门照旧)', () => {
  it('claim 条件不给 workspace / artifacts 也照过', async () => {
    const got = await verifyAcceptance(claimInput, { askModel: async () => claimOk })
    expect(got).toEqual({ verdict: 'pass' })
  })
})

describe('safeTestCommand:代跑白名单', () => {
  it('认得的测试命令行拆成 argv', () => {
    expect(safeTestCommand('npx vitest run foo.test.ts')).toEqual(['npx', 'vitest', 'run', 'foo.test.ts'])
    expect(safeTestCommand('node scripts/check.mjs')).toEqual(['node', 'scripts/check.mjs'])
    expect(safeTestCommand('npm test')).toEqual(['npm', 'test'])
  })
  it('不认得 / 带壳字符 → undefined(不敢代跑)', () => {
    expect(safeTestCommand('git push --force')).toBeUndefined()
    expect(safeTestCommand('rm -rf node_modules')).toBeUndefined()
    expect(safeTestCommand('npx vitest run x; git push')).toBeUndefined()
    expect(safeTestCommand('')).toBeUndefined()
  })
})

describe('createArtifactCheckDeps:真 fs / git 兜底', () => {
  it('readFile 真读工作区文件;differs 真走 git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-artifact-'))
    try {
      await mkdir(join(dir, 'sub'), { recursive: true })
      await writeFile(join(dir, 'README.md'), '原样\n', 'utf8')
      await execFileAsync('git', ['init', '-q'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
      const deps = createArtifactCheckDeps()
      expect(await deps.readFile(join(dir, 'README.md'))).toBe('原样\n')
      expect(await deps.readFile(join(dir, 'NOPE.md'))).toBeUndefined()
      // 没改 → differs false;改了 → true;不认识的文件不炸(整个树没装 git 除外,这里已 init)。
      expect(await deps.differs(dir, 'README.md')).toBe(false)
      await writeFile(join(dir, 'README.md'), '改过\n', 'utf8')
      expect(await deps.differs(dir, 'README.md')).toBe(true)
      expect(await deps.differs(dir, 'NEW.md')).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('createArtifactCheckDeps:diff 对派发基线比(洞1,真 git)', () => {
  it('★改动已提交、树干净:对 dispatch.base_sha 判「动过」;没基线退回 merge-base HEAD main;算不出 → 核不了', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-base-'))
    try {
      await writeFile(join(dir, 'README.md'), '原样\n', 'utf8')
      await execFileAsync('git', ['init', '-q', '-b', 'main'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
      const base = await gitStdout(['rev-parse', 'HEAD'], dir)
      // 执行者在独立分支上干活、main 留在基线(真实工作区的形状)。
      await execFileAsync('git', ['checkout', '-q', '-b', 'kimi/test'], dir)
      // 执行者已改并已提交:树干净、HEAD 就是它自己的提交 —— 对 HEAD 比永远「没有改动」(假阴性红例)。
      await writeFile(join(dir, 'README.md'), '改过\n', 'utf8')
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', '改 README'], dir)
      const deps = createArtifactCheckDeps()
      // 基线 = 派发那一刻记下的提交:对基线比,动过。
      expect(await deps.differs(dir, 'README.md', base)).toBe(true)
      // 没记基线:退回 merge-base HEAD main(这里 = init 那次)—— 一样判动过。
      expect(await deps.differs(dir, 'README.md')).toBe(true)
      expect(await deps.differs(dir, 'NOPE.md', base)).toBe(false)
      // 没动过的文件对基线也没动。
      expect(await deps.differs(dir, 'README.md', await gitStdout(['rev-parse', 'HEAD'], dir))).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('★没有基线且算不出 merge-base(没有 main)→ 核不了(undefined → unknown,不放行)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-nobase-'))
    try {
      await writeFile(join(dir, 'README.md'), '原样\n', 'utf8')
      await execFileAsync('git', ['init', '-q', '-b', 'trunk'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
      await writeFile(join(dir, 'README.md'), '改过\n', 'utf8')
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', '改'], dir)
      const deps = createArtifactCheckDeps()
      // 没 base_sha、分支上又没有 main 可退 —— 不许瞎猜,核不了。
      expect(await deps.differs(dir, 'README.md')).toBeUndefined()
      // 给了基线照常核得出。
      const base = (await gitStdout(['rev-parse', 'HEAD~1'], dir))
      expect(await deps.differs(dir, 'README.md', base)).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('knownPath / matchByName 真走 git(洞2 的两件)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-match-'))
    try {
      await mkdir(join(dir, 'src', 'server'), { recursive: true })
      await writeFile(join(dir, 'src', 'server', 'dispatchRun.ts'), '真身\n', 'utf8')
      await writeFile(join(dir, 'src', 'server', 'x.ts'), '别的\n', 'utf8')
      await execFileAsync('git', ['init', '-q', '-b', 'main'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
      const deps = createArtifactCheckDeps()
      // 模型指认的路径:git 不认识(不存在也没跟踪)。
      expect(await deps.knownPath(dir, 'src/dispatchRun.ts')).toBe(false)
      // 真路径存在 → 认识。
      expect(await deps.knownPath(dir, 'src/server/dispatchRun.ts')).toBe(true)
      // 按文件名在 ls-files 里找:唯一一条 → 那条真路径。
      expect(await deps.matchByName(dir, 'dispatchRun.ts')).toBe('src/server/dispatchRun.ts')
      // 改名后没跟踪、但在本轮 diff 清单里也要找得到。
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'mv', 'src/server/x.ts', 'src/server/renamed.ts'], dir)
      expect(await deps.matchByName(dir, 'renamed.ts')).toBe('src/server/renamed.ts')
      // 两处同名 → 多条,不敢猜。
      await writeFile(join(dir, 'src', 'server', 'dispatchRun.ts'), '真身2\n', 'utf8')
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'lib', 'dispatchRun.ts'), '同名\n', 'utf8')
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      expect(await deps.matchByName(dir, 'dispatchRun.ts')).toBe('many')
      expect(await deps.matchByName(dir, 'nobody.ts')).toBe('none')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('changedTestFiles 真走 git(任务书第 5 条):交回 diff(含未提交新增)里的 tests/*.test.* 都找到、按包根分组,别的不进', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-testfiles-'))
    try {
      await mkdir(join(dir, 'tests'), { recursive: true })
      await mkdir(join(dir, 'src'), { recursive: true })
      await mkdir(join(dir, 'pkg', 'tests'), { recursive: true })
      await writeFile(join(dir, 'tests', 'old.test.ts'), '旧用例\n', 'utf8')
      await writeFile(join(dir, 'src', 'x.ts'), '别的\n', 'utf8')
      await writeFile(join(dir, 'pkg', 'package.json'), '{}\n', 'utf8')
      await writeFile(join(dir, 'pkg', 'tests', 'p.test.ts'), '包内用例\n', 'utf8')
      await execFileAsync('git', ['init', '-q', '-b', 'main'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
      const base = await gitStdout(['rev-parse', 'HEAD'], dir)
      // 执行者:改了旧用例、包内用例并已提交;新用例还没提交;另改了非用例文件 —— 都进 diff 候选。
      await execFileAsync('git', ['checkout', '-q', '-b', 'kimi/test'], dir)
      await writeFile(join(dir, 'tests', 'old.test.ts'), '旧用例改过\n', 'utf8')
      await writeFile(join(dir, 'pkg', 'tests', 'p.test.ts'), '包内用例改过\n', 'utf8')
      await writeFile(join(dir, 'README.md'), '交接\n', 'utf8')
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], dir)
      await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', '改'], dir)
      await writeFile(join(dir, 'tests', 'new.test.ts'), '新用例\n', 'utf8')
      await writeFile(join(dir, 'tests', 'notatest.txt'), '不算\n', 'utf8')
      await writeFile(join(dir, 'src', 'foo.test.ts'), 'src 里同名不算 tests 目录\n', 'utf8')
      const deps = createArtifactCheckDeps()
      const got = await deps.changedTestFiles(dir, base)
      // 没有 package.json 的那组以工作区根为包根;pkg 那组认到包根、文件相对包根。
      expect(got).toEqual([
        { root: '', files: ['tests/new.test.ts', 'tests/old.test.ts'] },
        { root: 'pkg', files: ['tests/p.test.ts'] },
      ])
      // 基线缺席、分支上没有 main 可退 → git 核不动(undefined → 核不了,不猜)。
      const lone = await mkdtemp(join(tmpdir(), 'verify-testfiles-nobase-'))
      try {
        await mkdir(join(lone, 'tests'), { recursive: true })
        await writeFile(join(lone, 'tests', 'a.test.ts'), 'x\n', 'utf8')
        await execFileAsync('git', ['init', '-q', '-b', 'trunk'], lone)
        await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], lone)
        await execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], lone)
        expect(await createArtifactCheckDeps().changedTestFiles(lone)).toBeUndefined()
      }
      finally {
        await rm(lone, { recursive: true, force: true })
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('verifyAcceptance:diff 类对派发基线(洞1)', () => {
  const input = { acceptance: ['改了 README'], receipt: '做完了:改了 README。', title: '改 README' }
  const item = '{"items":[{"condition":"改了 README","met":true,"evidence":"改了 README","artifact":{"kind":"diff","path":"README.md"}}]}'

  it('派发基线(baseSha)交给产物核对那一层', async () => {
    const seen: (string | undefined)[] = []
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x', baseSha: 'deadbeef' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ differs: async (_w, _p, base) => { seen.push(base); return true } }),
    })
    expect(got).toEqual({ verdict: 'pass' })
    expect(seen).toEqual(['deadbeef'])
  })

  it('基线这层核不出(算不出 merge-base)→ unknown 不放行', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => item,
      artifacts: stubArtifacts({ differs: async () => undefined }),
    })
    expect(got).toMatchObject({ verdict: 'unknown' })
  })
})

describe('verifyAcceptance:diff 类路径指认按文件名对(洞2)', () => {
  const input = { acceptance: ['改了 dispatchRun.ts'], receipt: '做完了:改了 dispatchRun.ts。', title: '改派发' }
  const itemWrong = '{"items":[{"condition":"改了 dispatchRun.ts","met":true,"evidence":"改了 dispatchRun.ts","artifact":{"kind":"diff","path":"src/dispatchRun.ts"}}]}'
  const stub = (over: Partial<ArtifactCheckDeps>): ArtifactCheckDeps => stubArtifacts({
    knownPath: async () => false,
    matchByName: async () => 'src/server/dispatchRun.ts',
    differs: async (_w, p) => p === 'src/server/dispatchRun.ts',
    ...over,
  })

  it('★指认的路径不存在、git 也不认识 → 按文件名对到唯一一条 → 动过,判词带「按文件名对到」', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, { askModel: async () => itemWrong, artifacts: stub({}) })
    expect(got).toMatchObject({ verdict: 'pass' })
    if (got.verdict === 'pass') expect((got.notes ?? []).join()).toContain('按文件名对到 src/server/dispatchRun.ts')
  })

  it('★两处同名 → unknown「路径对不上」,不放行、不退修', async () => {
    const got = await awaitVerify({ matchByName: async () => 'many' })
    expect(got).toMatchObject({ verdict: 'unknown' })
    if (got.verdict === 'unknown') expect(got.why).toContain('路径对不上')
  })

  it('★零条 → unknown「路径对不上」', async () => {
    const got = await awaitVerify({ matchByName: async () => 'none' })
    expect(got).toMatchObject({ verdict: 'unknown' })
    if (got.verdict === 'unknown') expect(got.why).toContain('路径对不上')
  })

  it('git 这一拍核不动(读不出清单)→ unknown,不猜', async () => {
    const got = await awaitVerify({ matchByName: async () => undefined })
    expect(got).toMatchObject({ verdict: 'unknown' })
  })

  it('模型路径 git 认识但没动 → 条件点名的文件在 diff 清单里唯一 → 动过(优先信清单,不信模型路径)', async () => {
    const itemModel = '{"items":[{"condition":"改了 src/server/dispatchRun.ts","met":true,"evidence":"改了 src/server/dispatchRun.ts","artifact":{"kind":"diff","path":"src/README.md"}}]}'
    const got = await verifyAcceptance({
      acceptance: ['改了 src/server/dispatchRun.ts'],
      receipt: '做完了:改了 src/server/dispatchRun.ts。',
      title: '改派发',
      workspace: '/ws/x',
    }, {
      askModel: async () => itemModel,
      artifacts: stubArtifacts({
        knownPath: async (_w, p) => p === 'src/README.md',
        matchByName: async (_w, name) => (name === 'dispatchRun.ts' ? 'src/server/dispatchRun.ts' : 'none'),
        differs: async (_w, p) => p === 'src/server/dispatchRun.ts',
      }),
    })
    expect(got).toMatchObject({ verdict: 'pass' })
    if (got.verdict === 'pass') expect((got.notes ?? []).join()).toContain('按文件名对到')
  })

  async function awaitVerify(over: Partial<ArtifactCheckDeps>) {
    return verifyAcceptance({ ...input, workspace: '/ws/x' }, { askModel: async () => itemWrong, artifacts: stub(over) })
  }
})

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd }, err => (err === null ? resolvePromise() : rejectPromise(err)))
  })
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd }, (err, stdout) => (err === null ? resolvePromise(stdout.trim()) : rejectPromise(err)))
  })
}
