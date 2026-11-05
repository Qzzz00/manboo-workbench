/**
 * 交回核验(2026-10-27,卡 t-bd1c04ed「交回之后的闭环归事务官」):CLI 手交回、卡进
 * 「等你确认」时,由**产品**按卡上验收条件核 —— 不依赖事务官 DSH 会话活着(c0253b
 * 那条「confirm 先核验」靠会话,真机 `/state.agents.dsh` connected=false 时整条链停摆,
 * 卡停在「等你」直接推给人)。有条件核条件;核不动如实说;不达标退修给同一执行者同一会话;
 * 只有四类拍板请求(花钱/对外/账号设备/范围取舍)才留给人。
 *
 * ★ 按产物核(2026-10-28,卡「dispatchVerify 按产物核」;统筹交接-1027「22:2x 机制边界另记」):
 * 文本门只核执行者自述 —— 回执把条件原句抄一遍就能过。根治:条件分类型,产物由**程序**在
 * 独立工作区(dispatch.cwd)里自己核 —— 文件类核文件在不在、内容有没有;diff 类核那个文件
 * 相对 HEAD 真改没改;测试输出类把工作区里那条命令**代跑一遍**看通没通。模型只负责从回执里
 * 指认产物凭据(哪个文件 / 什么内容 / 哪条命令),核不过 = 这条不过,照抄原句没有产物就过不了。
 * 认不出类型的条件退回老文本门;产物核不了(没工作区 / git 跑不了 / 超时 / 命令不敢代跑)如实 unknown。
 *
 * 核验判词由理解中枢出**一次**结构化调用(注入,用例给替身);确定性兜底:模型不在场 =
 * 核不了(不猜、不冒充通过)。事实、推断分开:pass 必须逐条对得上,任何一条无据 = 不过。
 */
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
export type DispatchVerdict =
  | { verdict: 'pass', notes?: readonly string[] }
  | { verdict: 'fail', missing: readonly string[] }
  | { verdict: 'unknown', why: string }

export const VERIFY_SYSTEM = [
  '你是工作台的「交回核验」:按卡上的验收条件逐条核对执行者的交回汇报,只回 JSON。',
  'JSON 形状:{"items":[{"condition":"照抄条件原文","met":bool,"evidence":"执行者回执里支持本条的那一句原话"}]}',
  '纪律(硬):',
  '· 每条条件一条 item,顺序与条件一致,一条不许漏;',
  '· met=true 时 evidence **必须逐字摘自回执**(程序会核对原文里有没有这句),回执里找不到证据就 met=false;',
  '· 不许因为「看起来差不多了」放过一条;也不许把条件之外的要求加进去;',
  '· 汇报没提、或只对上一半,都算不过;',
  '· ★执行者自称「全部完成 / 两项均满足」**不算数** —— 那只是一种说法,只认逐条对得上的事实;',
  '· 排版差异不算不符:Markdown 标题记号(# 号)、全半角、空白,认**内容**不认排版(「# 工作台验收」=「工作台验收」);',
  '· 证据里必须出现该条条件要求的**具体对象**本身(条件要「验收人:验收员甲」,证据里就得有「验收人:验收员甲」这几个字;拿「验收日期:…」来抵 = 偷换,met=false)。',
  '· 程序会按条件类型自己核产物(文件 / diff / 测试输出),你只负责给**产物凭据**:',
  '  - 文件类条件(点名的文件 + 内容要求):artifact = {"kind":"file","path":"<工作区里的相对路径>","contains":"<文件里要有的原话,条件里点了才给>"};',
  '  - diff 类条件(说改了 / 新增了某文件,没点名内容):artifact = {"kind":"diff","path":"<相对路径>"};',
  '  - 测试输出类条件(用例 / 测试 / 类型检查要过):artifact = {"kind":"test","command":"<回执里说的那条测试命令,原样>"};',
  '  - 条件只说「用例全过」这类、回执里也没说哪条命令时,command 可以不给 —— 程序会从这次交回的 diff 里找改到的用例文件代跑(找不到才核不了);',
  '· 认不出类型的条件不用给 artifact;给得出类型的必须给,程序会照你给的凭据自己去核 —— 回执里抄条件原句变不出产物,产物核不过这条就不算数。',
].join('\n')

/** 条件的产物类型(程序判,不认模型说的):认不出 = undefined,退回文本门。 */
export type ArtifactKind = 'file' | 'diff' | 'test'

/** 条件 → 产物类型。顺序有意义:测试 > diff(改动) > file(点名文件)。「改了 README」是 diff 不是 file —— file 只核在不在 / 有没有,核不出「动过」。 */
export function artifactKindOf(condition: string): ArtifactKind | undefined {
  const c = condition
  /*
   * 「→」也算测试类:用例描述式条件(「第一次取代码超时 → 状态是『重试中』文案…」)写的是行为与
   * 期望,产物是测试输出而不是某个文件(2026-10-28 第二批洞 6,真机 t-b82dadb0 三条这类条件
   * 被逐字门全判「缺」)。分到 test 类且代跑通过的条件以代跑结果为准,不吃引号 UI 字的逐字门。
   */
  if (/测试|用例|vitest|tsc|类型检查|全部通过|跑过|→/u.test(c)) return 'test'
  if (/\bdiff\b|改动|修改|改|新增|加上|删除/u.test(c)) return 'diff'
  if (/[A-Za-z0-9_.一-鿿-]+\.[a-z0-9]{1,8}\b|docs\/|src\/|README|\.md\b|\.tsx?\b|\.json\b/u.test(c)) return 'file'
  return undefined
}

/** 模型指认的产物凭据(从核验回执的 item.artifact 解析)。 */
export interface ArtifactRef {
  kind: ArtifactKind
  path?: string
  contains?: string
  command?: string
}

/** 程序侧的产物核对(注入,用例给替身;生产 {@link createArtifactCheckDeps})。 */
export interface ArtifactCheckDeps {
  /** 读工作区里的文件;不在 / 读不了回 undefined。入参是绝对路径(调用方已守在工作区内)。 */
  readFile: (absPath: string) => Promise<string | undefined>
  /**
   * 这个相对路径相对**派发基线**有没有改动(含未提交;洞1):基线 = baseSha(派发那一刻记到卡上的
   * `dispatch.base_sha`);缺席退回 `git merge-base HEAD main`,再算不出回 undefined(核不了,不放行)。
   */
  differs: (workspace: string, relPath: string, baseSha?: string) => Promise<boolean | undefined>
  /** 把工作区里那条命令代跑一遍:pass / fail / timeout;命令不敢代跑(不在白名单)或起不来回 undefined。 */
  runTest: (workspace: string, command: string) => Promise<'pass' | 'fail' | 'timeout' | undefined>
  /** 洞2:这个相对路径在工作区里**存在、或 git 认识**(已跟踪 / 在本轮 diff 清单里);git 核不动回 undefined。 */
  knownPath: (workspace: string, relPath: string, baseSha?: string) => Promise<boolean | undefined>
  /**
   * 洞2:按 basename 在 `git ls-files` + `git diff --name-only <基线>` 里找:唯一一条回那条相对路径,
   * 多条回 'many'、零条回 'none',git 核不动回 undefined(调用方如实「核不了」,不猜)。
   */
  matchByName: (workspace: string, basename: string, baseSha?: string) => Promise<string | 'many' | 'none' | undefined>
  /**
   * 任务书第 5 条(1029,真机 10-29 09:50):描述式测试条件(只说「用例全过」没带命令)的代跑兜底 ——
   * 从这次交回的 diff(对派发基线,含未提交 / 新增,与 {@link differs} 同源)里找改到 / 新增的
   * `tests/*.test.*` 文件,按**包根**分组(包根 = 第一个有 package.json 的祖先目录,root 相对工作区、
   * 空串 = 工作区根本身;files 相对包根);空数组 = diff 里没有用例文件;git 核不动回 undefined。
   */
  changedTestFiles: (workspace: string, baseSha?: string) => Promise<readonly { root: string, files: readonly string[] }[] | undefined>
}

/** 代跑白名单:命令第一个词(去路径)必须在这里面 —— 模型给的命令原样进 spawn,只代跑测试那一类。 */
const TEST_COMMAND_BINS = new Set(['npx', 'npm', 'node', 'pnpm', 'yarn', 'bun', 'tsc', 'vitest', 'mocha', 'jest', 'make'])

/** 洞5:剥前缀时认的 taskpolicy class,只认这两个(都是「不许挤卡这台机器上别的活」的那一档)。 */
const TASKPOLICY_CLASSES = new Set(['utility', 'background'])

/**
 * 把测试命令拆成 argv;不认得 / 带壳字符 / 超长 → undefined(不敢代跑)。shell:false 起,无 shell 注入面。
 * 洞5(2026-10-28 第二批,真机 t-a5cea106):执行者的规矩是给构建 / 测试加 `taskpolicy -c <class>`
 * 前缀 → 这一种前缀**剥掉**再按白名单核(class 只认 utility / background,别的写法一概不认);
 * 返回的是**原样 argv(含前缀)** —— 代跑时原样带前缀跑,见 {@link testSpawnArgv}。
 */
export function safeTestCommand(command: string): string[] | undefined {
  const trimmed = command.trim()
  if (trimmed === '' || trimmed.length > 300) return undefined
  if (/[;|&$`()<>\\]/u.test(trimmed)) return undefined
  const original = trimmed.split(/\s+/u)
  let argv = original
  if (argv[0] === 'taskpolicy' && argv[1] === '-c' && argv.length > 3 && TASKPOLICY_CLASSES.has(argv[2] ?? '')) {
    argv = argv.slice(3)
  }
  const bin = (argv[0] ?? '').split('/').pop() ?? ''
  if (!TEST_COMMAND_BINS.has(bin)) return undefined
  return original
}

/**
 * 洞5:代跑真正起的那一格 argv。回执命令自己带了规矩前缀(`taskpolicy -c <utility|background>`,
 * {@link safeTestCommand} 已核过)就**原样带前缀**跑;没带 → 有 taskpolicy 的机器按他的规矩补上
 * `-c utility`,没有的机器退回直跑。argv 空 / 前缀后没命令回 undefined(不起)。
 */
export function testSpawnArgv(argv: readonly string[], hasTaskpolicy: boolean): { bin: string, args: string[] } | undefined {
  const first = argv[0]
  if (first === undefined) return undefined
  if (first === 'taskpolicy') {
    const rest = argv.slice(3)
    const bin = rest[0]
    if (bin === undefined) return undefined
    return hasTaskpolicy
      ? { bin: first, args: [...argv.slice(1)] }
      : { bin, args: [...rest.slice(1)] }
  }
  return hasTaskpolicy
    ? { bin: 'taskpolicy', args: ['-c', 'utility', ...argv] }
    : { bin: first, args: [...argv.slice(1)] }
}

/** 产物路径必须在 workspace 里面:相对路径才接,.. 爬出去的不核。 */
function workspacePathOf(workspace: string, relPath: string): string | undefined {
  if (relPath.trim() === '' || isAbsolute(relPath)) return undefined
  const abs = resolve(workspace, relPath)
  const root = resolve(workspace)
  return abs === root || !abs.startsWith(root + sep) ? undefined : abs
}

  /** git 路径的最后一段(洞2 按文件名对:git 的输出永远 / 分隔)。 */
function fileBaseOf(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

/** 任务书第 5 条:diff 里找用例文件认这个 —— `tests/` 目录下、basename 是 `*.test.*`。 */
function isChangedTestFile(relPath: string): boolean {
  return /(^|\/)tests\//u.test(relPath) && /\.test\.[a-z0-9]+$/iu.test(relPath)
}

/** 从条件原文里抠它点名的那个文件(洞2 下半:条件点名的文件直接对 diff 清单,不信模型的路径)。 */
function fileNameIn(text: string): string | undefined {
  const m = /([A-Za-z0-9_.一-鿿-]+(?:\/[A-Za-z0-9_.一-鿿-]+)*\.[a-z0-9]{1,8})\b/u.exec(text)
  return m?.[1]
}

/** 判词 item.artifact → 产物凭据;形状不对回 undefined(那一条按「没给凭据」核不了)。 */
function parseArtifactRef(raw: unknown): ArtifactRef | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const one = raw as { kind?: unknown, path?: unknown, contains?: unknown, command?: unknown }
  if (one.kind !== 'file' && one.kind !== 'diff' && one.kind !== 'test') return undefined
  return {
    kind: one.kind,
    ...(typeof one.path === 'string' ? { path: one.path } : {}),
    ...(typeof one.contains === 'string' ? { contains: one.contains } : {}),
    ...(typeof one.command === 'string' ? { command: one.command } : {}),
  }
}

/** 生产用的产物核对:真 fs / git / spawn(代跑前缀 taskpolicy -c utility,不让核验卡住这台机器上别的活)。 */
export function createArtifactCheckDeps(options: { runTestTimeoutMs?: number } = {}): ArtifactCheckDeps {
  const runTestTimeoutMs = options.runTestTimeoutMs ?? 120_000
  const gitRun = (workspace: string) => (args: string[]): Promise<{ code: number | undefined, stdout: string }> => new Promise((resolvePromise) => {
    execFile('git', ['-C', workspace, ...args], { timeout: 15_000 }, (err, stdout) => {
      resolvePromise({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : undefined, stdout })
    })
  })
  /*
   * 洞1:派发基线的解析在一处 —— 调用方给了(dispatch.base_sha)就用;没给退回 merge-base HEAD main;
   * 算不出回 undefined(diff 类据此「核不了」,不放行,不瞎猜)。
   */
  const resolveBase = async (workspace: string, baseSha?: string): Promise<string | undefined> => {
    const given = (baseSha ?? '').trim()
    if (given !== '') return given
    const mb = await gitRun(workspace)(['merge-base', 'HEAD', 'main'])
    if (mb.code !== 0) return undefined
    const sha = mb.stdout.trim()
    return sha === '' ? undefined : sha
  }
  return {
    readFile: async (absPath) => {
      try {
        return await readFile(absPath, 'utf8')
      }
      catch {
        return undefined
      }
    },
    differs: async (workspace, relPath, baseSha) => {
      if (workspacePathOf(workspace, relPath) === undefined) return undefined
      const run = gitRun(workspace)
      const base = await resolveBase(workspace, baseSha)
      if (base === undefined) return undefined
      // 工作区里这一拍有它、没提交(未跟踪 / 已跟踪有改动)也算「动过」。
      const status = await run(['status', '--porcelain', '--', relPath])
      if (status.code === undefined) return undefined
      if (status.stdout.trim() !== '') return true
      // 对派发基线比:退出 1 = 有改动,0 = 没改动,其它(含基线这个提交不认得)= 核不动。
      const diff = await run(['diff', '--quiet', base, '--', relPath])
      return diff.code === undefined ? undefined : diff.code === 1 ? true : diff.code === 0 ? false : undefined
    },
    knownPath: async (workspace, relPath, baseSha) => {
      if (workspacePathOf(workspace, relPath) === undefined) return undefined
      try {
        await access(join(workspace, relPath))
        return true
      }
      catch { /* 磁盘上没有 → 再看 git 认不认识 */ }
      const run = gitRun(workspace)
      const tracked = await run(['ls-files', '--error-unmatch', '--', relPath])
      if (tracked.code === undefined) return undefined
      if (tracked.code === 0) return true
      const base = await resolveBase(workspace, baseSha)
      if (base === undefined) return undefined
      const names = await run(['diff', '--name-only', base])
      if (names.code !== 0) return undefined
      return names.stdout.split('\n').some(one => one.trim() === relPath)
    },
    matchByName: async (workspace, basename, baseSha) => {
      const run = gitRun(workspace)
      const [ls, base] = await Promise.all([run(['ls-files']), resolveBase(workspace, baseSha)])
      if (ls.code === undefined || base === undefined) return undefined
      const names = await run(['diff', '--name-only', base])
      if (names.code !== 0) return undefined
      const hits = [...new Set([...ls.stdout.split('\n'), ...names.stdout.split('\n')])]
        .map(one => one.trim())
        .filter(one => one !== '' && fileBaseOf(one) === basename)
      if (hits.length === 1) return hits[0] as string
      return hits.length === 0 ? 'none' : 'many'
    },
    /*
     * 任务书第 5 条(1029):未提交(含新增)+ 对派发基线已提交,两路并集里挑 `tests/*.test.*`。
     * status 的 porcelain 行是 `XY path`(改名行带 ` -> `,取新路径);基线算不出 = 核不了,不猜。
     */
    changedTestFiles: async (workspace, baseSha) => {
      const run = gitRun(workspace)
      const names = new Set<string>()
      const status = await run(['status', '--porcelain'])
      if (status.code === undefined) return undefined
      for (const line of status.stdout.split('\n')) {
        let p = line.slice(3).trim()
        const arrow = p.indexOf(' -> ')
        if (arrow !== -1) p = p.slice(arrow + 4).trim()
        if (p !== '') names.add(p)
      }
      const base = await resolveBase(workspace, baseSha)
      if (base === undefined) return undefined
      const diff = await run(['diff', '--name-only', base])
      if (diff.code !== 0) return undefined
      for (const line of diff.stdout.split('\n')) {
        const p = line.trim()
        if (p !== '') names.add(p)
      }
      // 按包根分组:从文件所在目录往工作区根上数,第一个有 package.json 的目录 = 包根(vitest 在
      // 包根里起,根上没有 vitest 的仓库一条跨包命令必然起不来);数到根都没有 = 工作区根本身。
      const groups = new Map<string, string[]>()
      for (const file of [...names].filter(isChangedTestFile)) {
        let dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
        let root: string | undefined
        for (;;) {
          try {
            await access(join(workspace, dir, 'package.json'))
            root = dir
            break
          }
          catch { /* 这一层没有 package.json,往上数 */ }
          if (dir === '') break
          dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
        }
        const at = root ?? ''
        const rel = at === '' ? file : file.slice(at.length + 1)
        const list = groups.get(at) ?? []
        list.push(rel)
        groups.set(at, list)
      }
      return [...groups].map(([root, files]) => ({ root, files }))
    },
    runTest: async (workspace, command) => {
      const argv = safeTestCommand(command)
      if (argv === undefined) return undefined
      // macOS 上 prefix taskpolicy -c utility(他的规矩:构建测试不许挤卡这台机器的电话);
      // 回执命令自己带了规矩前缀(洞5)就原样带前缀跑,没带才由这台机器补上;没有 taskpolicy
      // 的机器(非 macOS)退回直跑。ENOENT = 没有 taskpolicy。
      const explicitPrefix = argv[0] === 'taskpolicy'
      const hasTaskpolicy = explicitPrefix || await new Promise<boolean>((resolvePromise) => {
        execFile('taskpolicy', [], { timeout: 5_000 }, err => resolvePromise(err === null || (err as NodeJS.ErrnoException).code !== 'ENOENT'))
      })
      const spawn = testSpawnArgv(argv, hasTaskpolicy)
      if (spawn === undefined) return undefined
      const code = await new Promise<number | 'timeout' | undefined>((resolvePromise) => {
        execFile(spawn.bin, spawn.args, { cwd: workspace, timeout: runTestTimeoutMs }, (err) => {
          if (err === null) return resolvePromise(0)
          if (err.killed === true || err.signal === 'SIGTERM') return resolvePromise('timeout')
          resolvePromise(typeof err.code === 'number' ? err.code : undefined)
        })
      })
      return code === undefined ? undefined : code === 'timeout' ? 'timeout' : code === 0 ? 'pass' : 'fail'
    },
  }
}

/** 逐条比对用的纯兜底:汇报逐字包含条件(归一后)才算过 —— 模型缺席时的保守档,不冒充智能。 */
export function literalPassOf(acceptance: readonly string[], receipt: string): { pass: boolean, missing: string[] } {
  const hay = receipt.replace(/\s+/gu, '')
  const missing = acceptance.filter(one => !hay.includes(one.replace(/\s+/gu, '')))
  return { pass: missing.length === 0, missing }
}

/**
 * ★ **缺验收时提取默认条件**(2026-10-29 第 4 步,任务书②):卡上没写「做到什么算完」不推人 —
 * 从委托原话 / 交回里提取可验证的默认条件(写明「由委托提取」)再核;真有目标歧义才问一句。
 * 模型缺席 / 拿不准 → undefined(执行层如实说核不了、记待核稍后再核),不编造。
 */
export const DEFAULT_ACCEPTANCE_EXTRACT_SYSTEM = [
  '你是工作台的「验收条件提取」:委托原话里没写「做到什么算完」时,从委托原话与执行者交回里提取可验证的默认验收条件,只回 JSON。',
  'JSON 形状:{"acceptance":["条件一","条件二"]} —— 每条一句拿产物 / 行为能对上的短句;只提原话里真要求了的,不编用户没要求的功能;',
  '原话里真看不出要做到什么(目标歧义)→ 回 {"question":"要问她的那一句"};',
  '拿不准 / 没有可验证的点 → 回 {"acceptance":[]}(执行层如实说核不了、记待核稍后再核),不许编造、不许放宽。',
].join('\n')

/** 提取回执的解析结果:条件 / 要问的一句 / 没接成(undefined)。 */
export type ExtractedAcceptance =
  | { acceptance: readonly string[] }
  | { question: string }

export function parseExtractedAcceptance(raw: string | undefined): ExtractedAcceptance | undefined {
  if (raw === undefined) return undefined
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const question = (parsed as { question?: unknown }).question
  if (typeof question === 'string' && question.trim() !== '') return { question: question.trim().slice(0, 300) }
  const acceptance = (parsed as { acceptance?: unknown }).acceptance
  if (!Array.isArray(acceptance)) return undefined
  const lines = acceptance.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => one.trim().slice(0, 120))
  return { acceptance: lines }
}

/**
 * ★ **用户层修复的默认验收条件**(第 4 步②):委托没写「做到什么算完」时按这三条核
 * (写到卡上时写明「由委托提取」)。热装 / 原件那两条由**程序**验(scan + 越界守门),
 * 不交给模型逐字门。
 */
export const USER_LAYER_DEFAULT_ACCEPTANCE: readonly string[] = [
  '交回里点名的用户层目标文件确实改了',
  '目标那一格热装 ok(设置里这一格不红)',
  '她的原件与本体一份没动(越界守门干净)',
]

export interface VerifyDeps {
  /** 调一次模型(注入;真实现走 modelService 端点)。入参是 user 正文,回 JSON 文本或 undefined(没接成)。 */
  askModel: (userText: string) => Promise<string | undefined>
  /** 产物核对(注入;生产 {@link createArtifactCheckDeps})。缺了而条件认得出类型 → 那些条件核不了。 */
  artifacts?: ArtifactCheckDeps
}

/** 核验一条交回。acceptance 空 = 没给验收条件(调用方如实说,不进这里)。 */
export async function verifyAcceptance(input: {
  acceptance: readonly string[]
  receipt: string
  title: string
  attempts?: number
  /** 独立工作区(dispatch.cwd):按产物核的根。缺了而条件认得出类型 → 核不了。 */
  workspace?: string | undefined
  /** ★ 派发基线(dispatch.base_sha,洞1):diff 类与它比,不跟 HEAD 比。缺席由产物核对层退回 merge-base HEAD main。 */
  baseSha?: string | undefined
}, deps: VerifyDeps): Promise<DispatchVerdict> {
  const user = [
    `事项:「${input.title}」`,
    `验收条件(逐条核):${input.acceptance.map((one, i) => `${i + 1}. ${one}`).join('\n')}`,
    ...(input.workspace === undefined || input.workspace.trim() === '' ? [] : [`独立工作区(产物核在这里面做):${input.workspace}`]),
    `执行者交回汇报:${input.receipt.slice(0, 3000)}`,
  ].join('\n')
  const raw = await deps.askModel(user).catch(() => undefined)
  if (raw === undefined) return { verdict: 'unknown', why: '理解服务没接成' }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) }
  catch { return { verdict: 'unknown', why: '核验回执不是合法 JSON' } }
  if (typeof parsed !== 'object' || parsed === null) return { verdict: 'unknown', why: '核验回执形状不对' }
  /*
   * 判词形状:逐条 evidence(2026-10-27 真机红例后的加固)——met=true 的证据**必须逐字出自
   * 回执**(程序核对,引用不在回执里 = 这条不算数)。旧形状 {"pass":bool} 一律 unknown,
   * 不拿没有证据的判词当真。
   */
  const norm = (text: string): string => text.replace(/\s+/gu, '')
  const hay = norm(receiptRaw(input.receipt))
  const items = Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : undefined
  if (items === undefined) return { verdict: 'unknown', why: '核验回执不是逐条形状(要 items[])' }
  // 证据除「逐字在回执里」外,还得与**条件本身**有字面重叠(≥4 字)——真机红例的根治:
  // 执行者拿「验收日期:…」偷换「验收人:验收员甲」,证据在回执里、但与条件对不上。
  const shingles = (text: string): Set<string> => {
    const flat = norm(text)
    const out = new Set<string>()
    for (let i = 0; i + 4 <= flat.length; i += 1) out.add(flat.slice(i, i + 4))
    return out
  }
  const results = items.flatMap((entry): { condition: string, met: boolean, evidenced: boolean, artifact?: ArtifactRef }[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const one = entry as { condition?: unknown, met?: unknown, evidence?: unknown, artifact?: unknown }
    if (typeof one.condition !== 'string') return []
    const condition = one.condition.trim().slice(0, 120)
    const artifact = parseArtifactRef(one.artifact)
    const evidence = typeof one.evidence === 'string' ? one.evidence.trim() : ''
    if (evidence === '' || !hay.includes(norm(evidence))) return [{ condition, met: one.met === true, evidenced: false, ...(artifact === undefined ? {} : { artifact }) }]
    // 与**条件引号里的对象**核对(条件没引号才退回整句):每个「…」span 都要在证据里有
    // ≥4 字重叠 —— 「文末有「」一行」这种公共前缀骗不过对象比对(真机红例根治)。
    // 洞6 同类豁免(第 4 步,1029):test 类条件(用例描述式)引号里写的是 UI 上的字,证据引的
    // 是「做了什么」(「两条用例都补了」),本来就不会与引号对象重叠 —— 这道只留给 file / diff /
    // 自述类;test 类以代跑为凭,逐字在回执里这一道仍然照吃。
    const spans = [...condition.matchAll(/「([^」]{2,})」/gu)].map(m => m[1] as string)
    const cores = spans.length > 0 ? spans : [condition]
    const evShingles = shingles(evidence)
    const overlap = artifactKindOf(condition) === 'test' || cores.every(core => [...shingles(core)].some(shard => evShingles.has(shard)))
    return [{ condition, met: one.met === true, evidenced: overlap, ...(artifact === undefined ? {} : { artifact }) }]
  })
  if (results.length !== input.acceptance.length) return { verdict: 'unknown', why: `核验回执 ${results.length} 条,条件 ${input.acceptance.length} 条,对不上` }
  /*
   * ── 按产物核(2026-10-28):认得出类型的条件,产物由**程序**在独立工作区里核 —— 回执照抄
   * 条件原句变不出文件 / diff / 测试通过,产物核不过 = 这条不过。核不了(没工作区 / 判词没给
   * 凭据 / git 跑不了 / 超时 / 命令不敢代跑)如实 unknown,不猜、不放行。
   */
  const artifactFails: { condition: string, why: string }[] = []
  const artifactNotes: string[] = []
  /** 洞6:分到 test 类、代跑已通过的条件 —— 以代跑结果为准,不吃引号 UI 字的逐字门。 */
  const testPassed = new Set<string>()
  const baseSha = input.baseSha?.trim()
  const workspace = input.workspace?.trim()
  for (const one of results) {
    const kind = artifactKindOf(one.condition)
    if (kind === undefined) continue
    const cannot = (why: string): void => { artifactFails.push({ condition: one.condition, why: `(核不了:${why})` }) }
    if (workspace === undefined || workspace === '' || deps.artifacts === undefined) { cannot('没有独立工作区或核产物的工具'); continue }
    const ref = one.artifact
    if (kind === 'test') {
      /*
       * 任务书第 5 条(1029,真机 10-29 09:50 红例):条件只说「用例全过」、判词没给可代跑的命令
       * (或给了但不敢代跑 / 起不来)—— 不就此「核不了」推给人;回退从这次交回的 diff(对派发基线,
       * 含未提交新增)里找改到 / 新增的 `tests/*.test.*` 文件代跑,结果当证据。找不到用例文件才核不了。
       */
      const given = ref !== undefined && ref.kind === 'test' ? (ref.command ?? '').trim() : ''
      let outcome = given === '' ? undefined : await deps.artifacts.runTest(workspace, given)
      if (outcome === undefined) {
        const groups = await deps.artifacts.changedTestFiles(workspace, baseSha)
        if (groups === undefined) { cannot('git 核不动,找不到这次交回改了哪些文件'); continue }
        if (groups.length === 0) { cannot(given === '' ? '判词没给测试命令,交回 diff 里也找不到用例文件' : '命令不敢代跑,交回 diff 里也找不到用例文件'); continue }
        // 各包在自家目录里起 vitest(仓库根上没有 vitest,一条命令跨包跑必然起不来);
        // 组与组互不拖累:任何一组起不来 / 超时 = 这条核不了,有一组没通过 = 这条不过。
        let blocked: string | undefined
        let failed = false
        for (const group of groups) {
          const at = group.root === '' ? workspace : `${workspace}/${group.root}`
          const ran = await deps.artifacts.runTest(at, `npx vitest run ${group.files.join(' ')} --maxWorkers 1`)
          if (ran === undefined) { blocked = '这条命令不敢代跑或起不来'; break }
          if (ran === 'timeout') { blocked = '代跑超时,没核完'; break }
          if (ran === 'fail') failed = true
        }
        if (blocked !== undefined) { cannot(blocked); continue }
        outcome = failed ? 'fail' : 'pass'
        if (!failed) {
          artifactNotes.push(`按交回 diff 代跑 ${groups.flatMap(group => group.files.map(file => group.root === '' ? file : `${group.root}/${file}`)).join('、')}`)
        }
      }
      if (outcome === 'timeout') { cannot('代跑超时,没核完'); continue }
      if (outcome !== 'pass') artifactFails.push({ condition: one.condition, why: '(代跑没通过)' })
      else testPassed.add(one.condition)
      continue
    }
    const refOk = ref !== undefined && ref.kind === kind && typeof ref.path === 'string' && ref.path.trim() !== ''
    if (!refOk) { cannot('判词没按产物形状给凭据'); continue }
    if (kind === 'file') {
      const relFile = (ref.path as string).trim()
      if (workspacePathOf(workspace, relFile) === undefined) { cannot('产物路径跑出工作区,不敢核'); continue }
      const text = await deps.artifacts.readFile(join(workspace, relFile))
      if (text === undefined) { artifactFails.push({ condition: one.condition, why: `(文件 ${relFile} 没找到)` }); continue }
      const contains = ref.contains?.trim() ?? ''
      if (contains !== '' && !norm(text).includes(norm(contains))) {
        artifactFails.push({ condition: one.condition, why: `(文件 ${relFile} 里没有要求的内容)` })
      }
      continue
    }
    /*
     * ── diff 类(洞1 + 洞2):先认路径、再对基线。
     * 洞2:模型指认的路径在工作区里不存在、git 也不认识时,按文件名在 git ls-files + 本轮 diff 清单里
     * 找唯一匹配(找到 = 「按文件名对到 …」,判词里明说);多条或零条 = 「路径对不上」→ 核不了(unknown,
     * 不退修)。模型路径 git 认识但没动 → 条件点名的文件直接在 diff 清单里对(优先信清单,不信模型路径)。
     */
    let rel = (ref.path as string).trim()
    let byName: string | undefined
    if (workspacePathOf(workspace, rel) === undefined) { cannot('产物路径跑出工作区,不敢核'); continue }
    const known = await deps.artifacts.knownPath(workspace, rel, baseSha)
    if (known === undefined) { cannot('git 核不动'); continue }
    if (!known) {
      const hit = await deps.artifacts.matchByName(workspace, fileBaseOf(rel), baseSha)
      if (hit === undefined) { cannot('git 核不动'); continue }
      if (hit === 'many' || hit === 'none') { cannot('路径对不上'); continue }
      byName = rel
      rel = hit
    }
    let changed = await deps.artifacts.differs(workspace, rel, baseSha)
    if (changed === undefined) { cannot('git 核不动'); continue }
    if (!changed && byName === undefined) {
      const condName = fileNameIn(one.condition)
      if (condName !== undefined && fileBaseOf(condName) !== fileBaseOf(rel)) {
        const hit = await deps.artifacts.matchByName(workspace, fileBaseOf(condName), baseSha)
        if (typeof hit === 'string') {
          const again = await deps.artifacts.differs(workspace, hit, baseSha)
          if (again === true) {
            byName = condName
            rel = hit
            changed = true
          }
        }
      }
    }
    if (!changed) artifactFails.push({ condition: one.condition, why: `(文件 ${rel} 没有改动)` })
    else if (byName !== undefined) artifactNotes.push(`按文件名对到 ${rel}`)
  }
  // 决定性门:条件引号里的对象在**回执里一个都没有**(≥4 字重叠为零)= 这条无可举证,
  // 不管模型怎么判都不许过(真机红例根治:回执只字未提「验收员甲」,任何通过都是假过)。
  // 洞6(2026-10-28 第二批,真机 t-b82dadb0):这一门只留给文件 / diff / 自述类条件 —— 用例描述式
  // 条件(分到 test 类)引号里写的是 UI 上的字(「重试中」),交回回执里本来就不会有。第 4 步(1029)
  // 把豁免扩到**整个 test 类**:这类条件的证据是代跑,不是回执引文 —— 代跑通过即以代跑为准
  // (testPassed 豁免),代跑给不出 / 不敢跑时由产物层的「核不了」如实兜住,不吃这一门的「缺」
  // (不然「没给命令」这种该留人再核的,会被 UI 字缺席顶成退修)。
  const receiptShingles = shingles(receiptRaw(input.receipt))
  const spanAbsent = (condition: string): boolean => {
    if (artifactKindOf(condition) === 'test') return false
    const spans = [...condition.matchAll(/「([^」]{2,})」/gu)].map(m => m[1] as string)
    if (spans.length === 0) return false
    return spans.some(span => ![...shingles(span)].some(shard => receiptShingles.has(shard)))
  }
  const missing = results.flatMap((one): string[] => {
    if (testPassed.has(one.condition)) return []
    if (!one.met) return [one.condition]
    if (spanAbsent(one.condition)) return [`${one.condition}(回执里找不到这条要求做的事)`]
    return one.evidenced ? [] : [`${one.condition}(判词说过了,但引的证据不在回执里)`]
  })
  /*
   * 判词收口(第 4 步③):**明确不过的先退修,核不了的那条另列** —— 有一条 definitive fail 就
   * 是 fail(missing 里带上「(核不了:…)」标注的条目,退修时一并不明说);全是「核不了」没有一条
   * 能明确判的,才是 unknown(他的规矩:判断不出来的一律按需要再核,不许自动放行)。
   */
  const unknownFails = artifactFails.filter(one => one.why.startsWith('(核不了:'))
  const definitiveFails = artifactFails.filter(one => !one.why.startsWith('(核不了:'))
  const textMissingCount = missing.length
  for (const one of artifactFails) {
    if (!missing.some(exist => exist === one.condition || exist.startsWith(`${one.condition}(`))) missing.push(`${one.condition}${one.why}`)
  }
  if (textMissingCount > 0 || definitiveFails.length > 0) return { verdict: 'fail', missing }
  if (unknownFails.length > 0) return { verdict: 'unknown', why: unknownFails.map(one => `${one.condition}${one.why}`).join(';') }
  return artifactNotes.length > 0 ? { verdict: 'pass', notes: artifactNotes } : { verdict: 'pass' }
}

/** 回执原文(去首尾空白;evidence 核对的输入)。 */
function receiptRaw(receipt: string): string {
  return receipt.trim()
}

/** 退修捎给同一执行者的那句话(把没做到的条明说,不绕)。 */
export function reworkTextOf(missing: readonly string[], acceptance: readonly string[]): string {
  return `验收未过:缺 ${missing.join(';')}。\n按卡上的验收条件补:${acceptance.join(';')}。改完直接交回。`
}

/**
 * 洞7(2026-10-28 第二批,真机 t-b82dadb0):退修重派被挡之后、换手也试过之后,落卡的那一句。
 * 换手候选**按家去重、去掉与原手同一家**(候选表里同一家可能重复列几行 —— 真机那张表第一家
 * 还是原手,两次都没派出去);一家都换不了 → 一句「没有别家可换」说清,不把「没派给 X」写两遍。
 */
export async function reworkResendNote(input: {
  /** 原手显示名(「退修没派给 ${who}」)。 */
  who: string
  /** 退修重派那一下回的原话(已含「没派给 X:…」)。 */
  resendNote: string
  /** 原手家 id。 */
  family: string
  /** 换手的候选表(可能含与原手同一家、也可能重复)。 */
  alternatives: readonly { family: string, title: string }[]
  /** 真去派那一下;ok = 派成了。 */
  tryAlt: (family: string) => Promise<{ ok: boolean, note?: string }>
}): Promise<string> {
  const byFamily = new Map<string, string>()
  for (const one of input.alternatives) {
    if (one.family === input.family) continue
    if (!byFamily.has(one.family)) byFamily.set(one.family, one.title)
  }
  let switched: string | undefined
  let altTriedWhy: string | undefined
  for (const [altFamily, title] of byFamily) {
    const again = await input.tryAlt(altFamily)
    if (again.ok) { switched = title; break }
    altTriedWhy = again.note
  }
  return switched !== undefined
    ? `退修没派给 ${input.who},换 ${switched} 去改了(${input.resendNote})`
    : byFamily.size === 0
      ? `退修没派出去:${input.resendNote}——没有别家可换`
      : `退修没派出去:${input.resendNote}${altTriedWhy === undefined ? '' : `;换一家也没派出去:${altTriedWhy}`}`
}

export const VERIFY_PASS_NOTE = '验收通过(事务官按卡上条件核过)。'
export const VERIFY_NO_ACCEPTANCE = '事务官核验:没给验收条件,核不了 —— 凭执行者回执等你验收。'
export function verifyUnknownNote(why: string): string {
  return `事务官核验:核不了(${why})—— 凭执行者回执等你验收。`
}
export const VERIFY_GIVE_UP = '两次退修仍未达标,交回给你定夺。'
