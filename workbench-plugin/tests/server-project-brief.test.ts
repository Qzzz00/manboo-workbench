// @vitest-environment node
/**
 * 已有项目拉齐(2026-09-24,维护者 12:40:「我真的很需要她能扫仓库啊,不然我还得口述一遍吗」)——
 * 8791 读一个项目、拼一份有上限的摘要(server/projectBrief.ts)。设计 docs/设计-已有项目拉齐-2026-09-24.md 第四、五节。
 *
 * 钉住:路径白名单(扫描根外 / `..` / 符号链接跳出 / 不存在 一律拒,录过的与找到过的认)、上限与截断、
 * 抹密钥、中文文件名、「最近」按 git 历史不按修改时间、非 git 目录退化、git 超时退化、整份 5 秒、git 只跑三种命令。
 * **git 相关的一律在 mkdtemp 出来的临时仓库里跑**,不碰任何真仓库。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASK_TO_READ, BRIEF_LIMIT, BRIEF_NOTE, DESIGN_LIMIT, HANDOFF_LIMIT, README_LIMIT, READ_CONSENT_NOTE,
  ageText, cleanMarkdown, clip, createSurfacedPaths, docKindOf, handoffExcerpt, lastHeadings, nodeBriefIo, parseHistory,
  readProjectBrief, readableDoc, readmeCandidates, resolveBriefPath, scrubSecrets, type BriefExec, type BriefIo,
} from '../src/server/projectBrief.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** mkdtemp 出来的沙箱(真实路径,macOS 上 /var → /private/var 先解开)。 */
function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-brief-')))
  dirs.push(dir)
  return dir
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  return dir
}

/** 在沙箱仓库里提交一次,时刻可控(「最近」按提交时刻排)。 */
function commit(dir: string, files: Record<string, string>, message: string, at: string): void {
  write(dir, files)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  })
}

const NOW = Date.parse('2026-09-24T05:00:00Z')

/** 真 I/O,只把「现在」钉住。 */
function realIo(now = NOW): BriefIo {
  return { ...nodeBriefIo(), now: () => now }
}

/** 记下每一条 git 命令的真 I/O。 */
function recordingIo(calls: string[][]): BriefIo {
  const io = realIo()
  return { ...io, exec: async (args, cwd, ms) => { calls.push([...args]); return await io.exec(args, cwd, ms) } }
}

async function briefOf(root: string, io: BriefIo = realIo(), options = {}) {
  return await readProjectBrief({ root, path: root, name: root.split('/').at(-1) as string }, io, options)
}

/** 一个像样的仓库:说明 / 设计 / 交接 / 决策记录 / 若干提交。 */
function sampleRepo(): string {
  const dir = initRepo(join(sandbox(), 'desktop-workbench'))
  commit(dir, {
    'README.md': '# 工作台 · 事务官\n\n**一个记得你、替你组织工作、随叫随到的事务官。**\n\n给不会写代码的半专业个体 —— 做自媒体运营的、做产品的。\n',
    'docs/决策记录.md': '# 决策记录\n\n## 2026-09-20 · 老的一节\n正文\n\n## 2026-09-22 · 第二节\n正文\n',
    'src/index.ts': 'export const x = 1\n',
  }, 'init: 仓库起步', '2026-09-10T00:00:00Z')
  commit(dir, {
    'docs/设计-引导流程.md': '# 设计:引导流程\n\n先问称呼,再问分岔。\n',
    'docs/交接-0923-引导内容.md': '# 交接 0923\n\n## 一、现在到哪\n- 旧的进度\n',
  }, 'docs: 0923 设计与交接', '2026-09-23T00:00:00Z')
  commit(dir, {
    'docs/交接-0924-统筹会话交接.md': '# 统筹会话交接(0924)\n\n先读:本文。\n\n## 一、现在到哪\n- 0.2.80 已装在这台 Mac 与手机上\n- 停在 ②′ 项目\n\n## 二、下一步(顺序)\n0. **头号需求**:电话引导要能读仓库\n   细节很长很长,不该整段进摘要\n1. 读 8791 日志里的串联行\n2. 按三层清单自验 0.2.80\n',
    'docs/设计-已有项目拉齐-2026-09-24.md': '# 设计:已有项目拉齐\n\n电话引导能自己读仓库,两句话复述做什么、给谁、现在到哪。\n',
    'docs/决策记录.md': '# 决策记录\n\n## 2026-09-20 · 老的一节\n正文\n\n## 2026-09-22 · 第二节\n正文\n\n## 2026-09-23 · 第三节\n```\n## 这不是标题(在代码块里)\n```\n\n## 2026-09-24 · 第五轮引导对话与扫描(卡 `fix/r5`)\n正文\n',
  }, 'docs(交接): 0924 头号需求', '2026-09-24T03:00:00Z')
  write(dir, { 'scratch.txt': '没提交的改动\n' })
  return dir
}

describe('路径白名单(resolveBriefPath)', () => {
  it('扫描根之下的认;扫描根本身不认;根外拒;不存在 404;不是目录 404;相对路径 400', async () => {
    const box = sandbox()
    const root = join(box, 'GitHub')
    mkdirSync(join(root, 'desktop-workbench'), { recursive: true })
    mkdirSync(join(box, 'elsewhere'), { recursive: true })
    writeFileSync(join(root, 'a-file.md'), 'x')
    const scope = { home: box, roots: [root], known: [], surfaced: [] }
    const io = nodeBriefIo()
    expect(await resolveBriefPath(join(root, 'desktop-workbench'), scope, io)).toEqual({
      ok: true, path: join(root, 'desktop-workbench'), real: join(root, 'desktop-workbench'),
    })
    expect(await resolveBriefPath(`${join(root, 'desktop-workbench')}/`, scope, io)).toMatchObject({ ok: true })
    expect(await resolveBriefPath('~/GitHub/desktop-workbench', scope, io)).toMatchObject({ ok: true, path: join(root, 'desktop-workbench') })
    expect(await resolveBriefPath(root, scope, io)).toMatchObject({ ok: false, status: 403, reason: 'outside' })
    expect(await resolveBriefPath(join(box, 'elsewhere'), scope, io)).toMatchObject({ ok: false, status: 403, reason: 'outside' })
    expect(await resolveBriefPath(join(root, 'nope'), scope, io)).toMatchObject({ ok: false, status: 404, reason: 'missing' })
    expect(await resolveBriefPath(join(root, 'a-file.md'), scope, io)).toMatchObject({ ok: false, status: 404, reason: 'missing' })
    expect(await resolveBriefPath('GitHub/desktop-workbench', scope, io)).toMatchObject({ ok: false, status: 400, reason: 'invalid' })
    expect(await resolveBriefPath(42, scope, io)).toMatchObject({ ok: false, status: 400 })
  })

  it('`..` 一律拒(哪怕解出来还在扫描根下)', async () => {
    const box = sandbox()
    const root = join(box, 'GitHub')
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'b'), { recursive: true })
    const scope = { home: box, roots: [root], known: [], surfaced: [] }
    expect(await resolveBriefPath(`${root}/a/../b`, scope, nodeBriefIo())).toMatchObject({ ok: false, status: 400, reason: 'dotdot' })
    expect(await resolveBriefPath(`${root}/../elsewhere`, scope, nodeBriefIo())).toMatchObject({ ok: false, reason: 'dotdot' })
  })

  it('符号链接跳出扫描根:拒(按真实路径算,不按字面)', async () => {
    const box = sandbox()
    const root = join(box, 'GitHub')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(box, 'outside-repo'), { recursive: true })
    symlinkSync(join(box, 'outside-repo'), join(root, 'evil'))
    const scope = { home: box, roots: [root], known: [], surfaced: [] }
    expect(await resolveBriefPath(join(root, 'evil'), scope, nodeBriefIo())).toMatchObject({ ok: false, status: 403, reason: 'outside' })
  })

  it('项目区录过的、这次找到过的:不在扫描根下也认(等于或在它之下);过了 30 分钟就不认了', async () => {
    const box = sandbox()
    mkdirSync(join(box, 'Desktop', 'side-project', 'docs'), { recursive: true })
    mkdirSync(join(box, 'Desktop', 'other'), { recursive: true })
    const known = join(box, 'Desktop', 'side-project')
    const io = nodeBriefIo()
    expect(await resolveBriefPath(known, { home: box, roots: [], known: [known], surfaced: [] }, io)).toMatchObject({ ok: true })
    expect(await resolveBriefPath(join(known, 'docs'), { home: box, roots: [], known: [known], surfaced: [] }, io)).toMatchObject({ ok: true })
    expect(await resolveBriefPath(join(box, 'Desktop', 'other'), { home: box, roots: [], known: [known], surfaced: [] }, io)).toMatchObject({ ok: false, reason: 'outside' })

    let now = 0
    const surfaced = createSurfacedPaths({ now: () => now })
    surfaced.add([known, 'relative/ignored'])
    expect(surfaced.list()).toEqual([known])
    expect(await resolveBriefPath(known, { home: box, roots: [], known: [], surfaced: surfaced.list() }, io)).toMatchObject({ ok: true })
    now = 30 * 60 * 1000
    expect(surfaced.list()).toEqual([])
    expect(await resolveBriefPath(known, { home: box, roots: [], known: [], surfaced: surfaced.list() }, io)).toMatchObject({ ok: false, reason: 'outside' })
  })
})

describe('读什么、不读什么', () => {
  it('只读文档类;代码、.env、名字像密钥的、隐藏目录、node_modules 都不读', () => {
    expect(readableDoc('docs/交接-0924-统筹会话交接.md')).toBe(true)
    expect(readableDoc('CHANGELOG')).toBe(true)
    expect(readableDoc('src/design.ts')).toBe(false)
    expect(readableDoc('.env')).toBe(false)
    expect(readableDoc('config/env.md')).toBe(false)
    expect(readableDoc('docs/设计-密钥轮换.md')).toBe(false)
    expect(readableDoc('docs/api-key-design.md')).toBe(false)
    expect(readableDoc('docs/secrets.md')).toBe(false)
    expect(readableDoc('.claude/handoff.md')).toBe(false)
    expect(readableDoc('node_modules/x/README.md')).toBe(false)
    expect(readableDoc('docs/keyboard-design.md')).toBe(true)
  })

  it('按名字归类:交接 > 决策 > 设计 > 进度类弱词', () => {
    expect(docKindOf('docs/交接-0924-统筹会话交接.md')).toBe('handoff')
    expect(docKindOf('docs/决策记录.md')).toBe('decisions')
    expect(docKindOf('docs/adr/0003-use-sqlite.md')).toBe('decisions')
    expect(docKindOf('docs/address.md')).toBeUndefined()
    expect(docKindOf('docs/设计-已有项目拉齐-2026-09-24.md')).toBe('design')
    expect(docKindOf('docs/审视-用户到底得到什么-2026-09-22.md')).toBe('design')
    expect(docKindOf('docs/PRD-桌面工作台-v1.md')).toBe('design')
    expect(docKindOf('docs/inspect.md')).toBeUndefined()
    expect(docKindOf('docs/设计-扫描进度.md')).toBe('design')
    expect(docKindOf('docs/进度.md')).toBe('handoff')
    expect(docKindOf('TODO.md')).toBe('handoff')
    expect(docKindOf('src/handoff.ts')).toBeUndefined()
  })

  it('说明:中文版 README 优先,再 README.md,再 CLAUDE.md / AGENTS.md', () => {
    expect(readmeCandidates(['AGENTS.md', 'README.md', 'README.zh-CN.md', 'readme.txt'])).toEqual(['README.zh-CN.md', 'README.md', 'readme.txt', 'AGENTS.md'])
    expect(readmeCandidates(['CLAUDE.md', 'src'])).toEqual(['CLAUDE.md'])
  })

  it('git 历史:每个文件取最近一次;同一个提交里名字大的在前', () => {
    const out = parseHistory('\x1E300\n\na.md\ndocs/交接-0923.md\ndocs/交接-0924.md\n\x1E200\n\na.md\nb.md\n')
    expect(out).toEqual([
      { file: 'docs/交接-0924.md', at: 300 },
      { file: 'docs/交接-0923.md', at: 300 },
      { file: 'a.md', at: 300 },
      { file: 'b.md', at: 200 },
    ])
  })
})

describe('清洗', () => {
  it('像密钥的整行抹掉(私钥块整段);正常的行留着', () => {
    const text = [
      '# 说明',
      '填 DeepSeek 的钥匙:OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      'AWS AKIAABCDEFGHIJKLMNOP',
      'github: ghp_abcdefghijklmnopqrstuvwxyz0123',
      'password: hunter2',
      '密码:123456',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      '-----END OPENSSH PRIVATE KEY-----',
      '不展示或写入 API Key、密码、Cookie、Token 或其他凭据。',
      'max_tokens 调到 4096',
      // 讲做法的文档行不是钥匙(真仓库决策记录里的原句):留着。
      '1. **经代理的 GET 认 `?token=`**(只 `/butler/proxy/*` 这一段)',
      '3. **会话令牌 = `用户名.到期.sid.HMAC`**',
    ].join('\n')
    const out = scrubSecrets(text)
    expect(out.removed).toBe(8)
    expect(out.text).toBe([
      '# 说明',
      '不展示或写入 API Key、密码、Cookie、Token 或其他凭据。',
      'max_tokens 调到 4096',
      '1. **经代理的 GET 认 `?token=`**(只 `/butler/proxy/*` 这一段)',
      '3. **会话令牌 = `用户名.到期.sid.HMAC`**',
    ].join('\n'))
  })

  it('Markdown → 念得出来的字:图片 / 徽章 / HTML 去掉,代码块换「(代码略)」,链接只留字', () => {
    const text = [
      '<p align="center"><img src="logo.png" width="200"></p>',
      '# 工作台 · 事务官',
      '[![CI](https://x/badge.svg)](https://x/actions) ![截图](shot.png)',
      '看 [设计文档](docs/设计.md) 与 `docs/记忆/项目/<名>.md`,官网 https://example.com/a。',
      '```bash',
      'curl -X POST :8791/onboarding/scan',
      '```',
      '| 目录 | 内容 |',
      '|---|---|',
      '| butler-app | 手机端 |',
      '---',
      '> **一句话**:替你组织工作',
    ].join('\n')
    expect(cleanMarkdown(text)).toBe([
      '工作台 · 事务官',
      '',
      '看 设计文档 与 docs/记忆/项目/<名>.md,官网 (链接)。',
      '(代码略)',
      '目录 · 内容',
      'butler-app · 手机端',
      '一句话:替你组织工作',
    ].join('\n'))
  })

  it('截断按字、不劈字、以「…」结尾;几天前说人话', () => {
    expect(clip('一二三四五', 5)).toBe('一二三四五')
    expect(clip('一二三四五六', 5)).toBe('一二三四…')
    expect(ageText(NOW / 1000 - 60, NOW)).toBe('刚刚')
    expect(ageText(NOW / 1000 - 2 * 3600, NOW)).toBe('2 小时前')
    expect(ageText(NOW / 1000 - 86400 - 10, NOW)).toBe('昨天')
    expect(ageText(NOW / 1000 - 3 * 86400, NOW)).toBe('3 天前')
    expect(ageText(NOW / 1000 - 20 * 86400, NOW)).toBe('2 周前')
  })

  it('交接那一段:「现在到哪」与「下一步」优先,下一步只取每条第一行;没有这两节就取开头', () => {
    const text = '# 交接\n\n先读:很长的前言。\n\n## 一、现在到哪\n- 装好了\n\n## 二、下一步\n0. **头号需求**:读仓库\n   细节很长\n   - 子条目也不要\n1. 自验\n'
    const out = handoffExcerpt(text, 400)
    expect(out).not.toContain('子条目')
    expect(out).toContain('一、现在到哪:\n- 装好了')
    expect(out).toContain('二、下一步:\n0. 头号需求:读仓库\n1. 自验')
    expect(out).not.toContain('细节很长')
    expect(out).not.toContain('先读')
    expect(handoffExcerpt('# 进展\n\n只有一段正文。\n', 100)).toBe('进展\n\n只有一段正文。')
  })

  it('决策记录末尾三节的标题(代码块里的井号不算)', () => {
    const text = '## a\n\n## b\n```\n## 不算\n```\n## c\n### 小节\n## d(卡 `x`)\n'
    expect(lastHeadings(text)).toEqual(['b', 'c', 'd(卡 x)'])
  })
})

describe('readProjectBrief(mkdtemp 临时仓库)', () => {
  it('五段都在、按顺序、标出处;中文文件名照读;抹不到的不编', async () => {
    const dir = sampleRepo()
    const got = await briefOf(dir)
    expect(got.git).toBe(true)
    expect(got.sources.map(source => source.kind)).toEqual(['readme', 'design', 'handoff', 'decisions', 'commits'])
    expect(got.sources.find(source => source.kind === 'handoff')).toMatchObject({ label: '最近的交接', file: 'docs/交接-0924-统筹会话交接.md', age: '2 小时前' })
    expect(got.sources.find(source => source.kind === 'design')?.file).toBe('docs/设计-已有项目拉齐-2026-09-24.md')
    const text = got.brief
    const order = ['【说明】README.md', '【最近的设计】docs/设计-已有项目拉齐-2026-09-24.md', '【现在到哪 · 最近的交接】docs/交接-0924-统筹会话交接.md', '【决策记录末尾3节】docs/决策记录.md', '【最近的提交】']
    const at = order.map(mark => text.indexOf(mark))
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).toContain('一个记得你、替你组织工作、随叫随到的事务官。')
    expect(text).toContain('0. 头号需求:电话引导要能读仓库')
    expect(text).not.toContain('细节很长很长')
    expect(text).toContain('- 2026-09-24 · 第五轮引导对话与扫描(卡 fix/r5)')
    expect(text).not.toContain('这不是标题')
    expect(text).toContain('分支 main;还有 1 处没提交')
    expect(text).toContain('- 2 小时前 · docs(交接): 0924 头号需求')
    expect(text).toContain('读了:说明(README.md)、最近的设计(docs/设计-已有项目拉齐-2026-09-24.md,2 小时前动过)')
    expect(text).not.toContain('export const x')
    expect(got.missing).toEqual([])
  })

  it('「最近」按 git 历史,不按文件修改时间(克隆下来修改时间都一样)', async () => {
    const dir = sampleRepo()
    // 把老交接的修改时间拨到「现在」:按 mtime 排就会挑错。
    const now = new Date()
    utimesSync(join(dir, 'docs/交接-0923-引导内容.md'), now, now)
    const got = await briefOf(dir)
    expect(got.sources.find(source => source.kind === 'handoff')?.file).toBe('docs/交接-0924-统筹会话交接.md')
  })

  it('最近的交接:两天之内动过的几份里,有「现在到哪」一节的优先(一张卡一份交接时,最新那份常常不讲现状)', async () => {
    const dir = sampleRepo()
    // 统筹那份(讲现状)之后,又有一张卡交了一份只讲做法的交接。
    // 「屏上现在是什么样」讲的是界面,不算讲现状;只有「现在到哪」没有「下一步」也不算。
    commit(dir, { 'docs/交接-0924-某张卡.md': '# 某张卡的交接\n\n## 一、屏上现在是什么样\n- 两颗键\n\n## 二、进度条\n- 改了\n\n## 三、怎么验\n- 跑用例\n' }, 'docs(交接): 某张卡', '2026-09-24T04:00:00Z')
    const got = await briefOf(dir)
    expect(got.sources.find(source => source.kind === 'handoff')?.file).toBe('docs/交接-0924-统筹会话交接.md')
    expect(got.brief).toContain('0.2.80 已装在这台 Mac 与手机上')

    // 讲现状的那份在窗口外(三天前):不拿旧现状冒充现在,就用最新那份。
    const old = initRepo(join(sandbox(), 'old-status'))
    commit(old, { 'docs/交接-0920-统筹.md': '# 统筹\n\n## 一、现在到哪\n- 旧现状\n\n## 二、下一步\n- 旧的下一步\n' }, 'docs: 旧', '2026-09-20T00:00:00Z')
    commit(old, { 'docs/交接-0924-卡.md': '# 卡\n\n## 一、做了什么\n- 新做法\n' }, 'docs: 新', '2026-09-24T04:00:00Z')
    const olds = await briefOf(old)
    expect(olds.sources.find(source => source.kind === 'handoff')?.file).toBe('docs/交接-0924-卡.md')
  })

  it('上限与截断:说明 ≤ 1500、设计 ≤ 600、交接 ≤ 1200,整份 ≤ 3500,截了的以「…」结尾', async () => {
    const dir = initRepo(join(sandbox(), 'big'))
    const long = (mark: string, n: number) => Array.from({ length: n }, (_, i) => `${mark}第${i}行。${'字'.repeat(40)}`).join('\n')
    commit(dir, {
      'README.md': `# 大项目\n\n${long('说明', 200)}`,
      'docs/设计-大.md': `# 设计\n\n${long('设计', 200)}`,
      'docs/交接-大.md': `# 交接\n\n${long('交接', 200)}`,
      'docs/决策记录.md': '## 一\n## 二\n## 三\n## 四\n',
    }, 'feat: 大', '2026-09-24T04:00:00Z')
    const got = await briefOf(dir)
    expect(Array.from(got.brief).length).toBeLessThanOrEqual(BRIEF_LIMIT)
    const section = (title: string) => {
      const start = got.brief.indexOf(title)
      const end = got.brief.indexOf('\n\n【', start + 1)
      return got.brief.slice(start + title.length + 1, end < 0 ? undefined : end)
    }
    expect(Array.from(section('【说明】README.md')).length).toBeLessThanOrEqual(README_LIMIT)
    expect(Array.from(section('【最近的设计】docs/设计-大.md')).length).toBeLessThanOrEqual(DESIGN_LIMIT)
    expect(Array.from(section('【现在到哪 · 最近的交接】docs/交接-大.md')).length).toBeLessThanOrEqual(HANDOFF_LIMIT)
    expect(section('【说明】README.md').endsWith('…')).toBe(true)
    // 决策与提交照样在(上限是按比例一起收文档,不整段丢)。
    expect(got.brief).toContain('- 四')
    expect(got.brief).toContain('【最近的提交】')
  })

  it('抹密钥:读到的行里像密钥的整行不进摘要,并如实说抹了几行', async () => {
    const dir = initRepo(join(sandbox(), 'keys'))
    commit(dir, {
      'README.md': '# 有钥匙的项目\n\n做给自己用的小工具。\nDEEPSEEK_API_KEY=sk-0123456789abcdef0123456789abcdef\n用法见下。\n',
    }, 'feat: token=abcdefgh12345678 泄在标题里', '2026-09-24T04:00:00Z')
    const got = await briefOf(dir)
    expect(got.brief).not.toContain('sk-0123456789')
    expect(got.brief).not.toContain('abcdefgh12345678')
    expect(got.brief).toContain('做给自己用的小工具。')
    expect(got.redacted).toBe(2)
    // 抹了几行只在回包里记数,不写进摘要(免得她去跟他聊「你仓库里有钥匙」)。
    expect(got.brief).not.toContain('密钥')
  })

  it('不读代码与密钥名的文件;文件符号链接跳出仓库的不读', async () => {
    const box = sandbox()
    write(box, { 'secret-notes.md': '# 外面的秘密\n不该被读到\n' })
    const dir = initRepo(join(box, 'repo'))
    commit(dir, { 'AGENTS.md': '# 仓库规矩\n\n这是 AGENTS 的开头。\n' }, 'init', '2026-09-20T00:00:00Z')
    symlinkSync(join(box, 'secret-notes.md'), join(dir, 'README.md'))
    commit(dir, {
      'docs/设计-密钥轮换.md': '# 设计 密钥\n不该读\n',
      'src/design.ts': 'export const design = 1\n',
      '.env': 'X=1\n',
    }, 'feat: 密钥与代码', '2026-09-24T04:00:00Z')
    const got = await briefOf(dir)
    expect(got.brief).not.toContain('外面的秘密')
    expect(got.brief).toContain('【说明】AGENTS.md')
    expect(got.brief).toContain('这是 AGENTS 的开头。')
    expect(got.brief).not.toContain('不该读')
    expect(got.brief).not.toContain('export const design')
    expect(got.sources.some(source => source.kind === 'design')).toBe(false)
  })

  it('非 git 目录退化:只读说明,如实说没有提交记录', async () => {
    const dir = join(sandbox(), 'plain')
    write(dir, { 'README.md': '# 随手记\n\n一个放笔记的文件夹。\n' })
    const got = await briefOf(dir)
    expect(got.git).toBe(false)
    expect(got.brief).toContain('一个放笔记的文件夹。')
    expect(got.brief).toContain('这个目录不是 git 仓库:没有提交记录,最近的设计与交接也没法按提交挑,只读了说明。')
    expect(got.brief).not.toContain('【最近的提交】')
  })

  it('还没提交过的空仓库:不炸,如实说', async () => {
    const dir = initRepo(join(sandbox(), 'empty'))
    write(dir, { 'README.md': '# 新仓库\n' })
    const got = await briefOf(dir)
    expect(got.brief).toContain('新仓库')
    expect(got.brief).toContain('最近提交没读到')
  })

  it('git 只跑 log / status / rev-parse,每条都带 -c core.quotepath=false;一条会改东西的都没有', async () => {
    const dir = sampleRepo()
    const calls: string[][] = []
    await briefOf(dir, recordingIo(calls))
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['-c', 'core.quotepath=false'])
      const sub = args.slice(2).find(arg => !arg.startsWith('-'))
      expect(['log', 'status', 'rev-parse']).toContain(sub)
      if (sub === 'status') expect(args).toContain('--porcelain')
      if (sub === 'status') expect(args).toContain('--no-optional-locks')
    }
  })

  it('git 超时退化:最近提交写「没读到(git 超时)」,说明照读', async () => {
    const dir = sampleRepo()
    const io = realIo()
    const slowLog: BriefIo = {
      ...io,
      exec: async (args, cwd, ms): Promise<BriefExec> => args.includes('log') ? { ok: false, stdout: '', timedOut: true } : await io.exec(args, cwd, ms),
    }
    const got = await briefOf(dir, slowLog)
    expect(got.brief).toContain('最近提交没读到(git 超时)')
    expect(got.brief).toContain('一个记得你')
    expect(got.missing.join(';')).toContain('git 超时')
    expect(got.sources.some(source => source.kind === 'handoff')).toBe(false)
  })

  it('整份有上限:git 一直不回也按时交(每条 3 秒、整份 5 秒 —— 这里调小了量)', async () => {
    const dir = sampleRepo()
    const io = realIo()
    const hung: BriefIo = { ...io, exec: () => new Promise<BriefExec>(() => {}) }
    const started = Date.now()
    const got = await briefOf(dir, hung, { gitTimeoutMs: 150, deadlineMs: 300 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(got.git).toBe(false)
    expect(got.brief).toContain('git 超时了')
    expect(got.brief).toContain('一个记得你')
  })
})

describe('话术只写一处', () => {
  it('读目录那一问:问句里有「目录 / 读」、以问号结尾;两段 note 都带着它', () => {
    expect(ASK_TO_READ).toBe('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?')
    expect(ASK_TO_READ).not.toContain('只看名字')
    expect(READ_CONSENT_NOTE).toContain(ASK_TO_READ)
    expect(READ_CONSENT_NOTE).toContain('改口')
    expect(READ_CONSENT_NOTE).toContain('read_scan_roots')
    expect(BRIEF_NOTE).toContain('是这个吗')
    expect(BRIEF_NOTE).toContain('project.path')
    expect(BRIEF_NOTE).toContain('不念路径、文件名、提交号')
    expect(BRIEF_NOTE).toContain('交接里写着的下一步由你念出来')
    expect(BRIEF_NOTE).toContain('不问「你手上有哪些事」')
  })
})
