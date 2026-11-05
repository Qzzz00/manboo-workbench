// @vitest-environment node
/**
 * 守门:**运行时代码要从插件包里读的文件,必须都进包**(2026-09-25,卡 R)。
 *
 * 起因:`package.json` 的 `files` 只有 `lib/…` 三项,`bin/agent-hook.sh` 等钩子脚本一个都没进包;
 * 装好的机器上没有 `bin/`,「全部接上」永远接不上,界面还叫一个不懂代码的人去改开发目录。
 * 以后谁再漏,这里当场红 —— 不等下一个用户撞上。
 *
 * 三道:
 * 1. 运行时要读的包内文件那张表(`PACKAGE_RUNTIME_FILES`)逐项对 `npm pack` 的**真实清单**;
 * 2. `package.json` 的入口(`main` / `exports`)都被 `files` 盖住;
 * 3. 扫运行时源码里的每一个字符串(TypeScript 语法树,注释不算):提到包里 `bin/`、`scripts/` 下
 *    某个文件的(或 `docs/`、`dev/` 下某个文件的完整相对路径),那个文件就必须进包 ——
 *    除非在下面的豁免表里写明「运行时不从包里读它」的理由。
 *
 * 另外钉一条同类的:进包的脚本里不许出现任何一台具体机器的家目录(`claude-statusline.sh` 曾把
 * 调用痕迹写死在维护者那台的 `/Users/example/…`)。
 *
 * 文件末尾还有一组(2026-09-25 统筹拍板):**插件包、热更新、安装包发出去的每一份脚本里,
 * 不许有维护者本机专属的地址或设置**(本机上别的服务的端口、代理、别家客户端的环境变量、某台机器的家目录)。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PACKAGE_RUNTIME_FILES } from '../src/server/hookScripts.ts'
import { renderDshStart, renderPlist } from '../src/server/setup/install.ts'
import { REPO_ROOT, installerScriptFiles, updateScriptFiles } from './helpers/shippedScripts.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

/**
 * 运行时源码里提到了、但**不从插件包里读**的文件。每一条都要写清为什么 —— 写不出理由的,就该进包。
 */
const NOT_READ_FROM_PACKAGE: Readonly<Record<string, string>> = {
  'bin/dsh-start': '启动脚本由安装包 / 热更新从 payload(摆成仓库样子的目录)装到 ~/.dsh/bin/,launchd 跑的是那一份;插件运行时不读包里这一份',
  'bin/butler-start': '同上:装到 ~/.dsh/bin/,事务官后端的 launchd 跑的是那一份',
}

let packed: readonly { path: string, mode: number }[] | undefined
/** `npm pack --dry-run` 的真实清单(不看我们以为 `files` 会带什么,看 npm 真的带了什么)。 */
function packedFiles(): readonly { path: string, mode: number }[] {
  if (packed !== undefined) return packed
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, npm_config_loglevel: 'silent', npm_config_update_notifier: 'false' },
  })
  const parsed = JSON.parse(out) as { files: { path: string, mode: number }[] }[]
  packed = parsed[0]?.files ?? []
  return packed
}

function packageJson(): { main?: string, exports?: Record<string, string>, files?: string[] } {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { main?: string, exports?: Record<string, string>, files?: string[] }
}

/** `files` 里的一项盖不盖得住这个路径:一模一样、是它的上级目录、或者 glob 对得上。 */
function covered(path: string, patterns: readonly string[]): boolean {
  const clean = path.replace(/^\.\//, '')
  return patterns.some((raw) => {
    const pattern = raw.replace(/^\.\//, '').replace(/\/$/, '')
    if (clean === pattern || clean.startsWith(`${pattern}/`)) return true
    if (!pattern.includes('*')) return false
    const regex = new RegExp(`^${pattern.split('**').map(part => part.split('*').map(bit => bit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`)
    return regex.test(clean)
  })
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** 插件包目录里、`git` 跟踪着的、不在 src/ tests/ 里的那些文件(可能被运行时"顺手"读的候选)。 */
function assetFiles(): string[] {
  return execFileSync('git', ['ls-files', 'bin', 'scripts', 'dev', 'docs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().replace(/^"|"$/g, ''))
    .filter(line => line !== '')
}

/** 一份源码里所有字符串字面量的文字(模板字符串拆成各段;注释不算)。 */
function stringsIn(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text)
      for (const span of node.templateSpans) out.push(span.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/**
 * 这个字符串提没提到这个包内文件。`bin/`、`scripts/` 下的按**文件名**也算(代码常写成
 * `${dir}/agent-hook.sh`);`docs/`、`dev/` 下的只认完整相对路径(`index.html`、`README.md` 这种名字太常见)。
 */
function mentions(literal: string, rel: string): boolean {
  if (literal.includes(rel)) return true
  if (!rel.startsWith('bin/') && !rel.startsWith('scripts/')) return false
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  return literal === base || literal.endsWith(`/${base}`) || literal.includes(`/${base} `)
}

describe('守门:运行时要读的包内文件都进包', () => {
  it('★运行时要读的那张表,逐项都在 npm pack 的真实清单里', () => {
    const paths = packedFiles().map(file => file.path)
    expect(PACKAGE_RUNTIME_FILES.length).toBeGreaterThan(0)
    for (const rel of PACKAGE_RUNTIME_FILES) {
      expect(paths, `${rel} 运行时要读,却没进包(package.json 的 files 漏了它)`).toContain(rel)
    }
  }, 60_000)

  it('package.json 的入口(main / exports)都被 files 盖住', () => {
    const pkg = packageJson()
    const files = pkg.files ?? []
    const entries = [pkg.main, ...Object.values(pkg.exports ?? {})].filter((entry): entry is string => entry !== undefined)
    for (const entry of entries) {
      if (entry.replace(/^\.\//, '') === 'package.json') continue
      expect(covered(entry, files), `${entry} 是包的入口,却不在 files 里`).toBe(true)
    }
  })

  it('★运行时源码里提到的包内文件,要么进包,要么写明为什么不从包里读', () => {
    const paths = new Set(packedFiles().map(file => file.path))
    const sources = walk(join(ROOT, 'src')).filter(file => /\.tsx?$/.test(file))
    const assets = assetFiles()
    const missing: string[] = []
    for (const file of sources) {
      const literals = stringsIn(file)
      for (const rel of assets) {
        if (paths.has(rel) || Object.hasOwn(NOT_READ_FROM_PACKAGE, rel)) continue
        const hit = literals.find(literal => mentions(literal, rel))
        if (hit !== undefined) missing.push(`${relative(ROOT, file)} 提到了 ${rel}(${JSON.stringify(hit).slice(0, 80)}),它没进包`)
      }
    }
    expect(missing, '运行时代码提到了没进包的文件:要么加进 package.json 的 files,要么在豁免表里写明理由').toEqual([])
  }, 60_000)

  it('豁免表里的每一条都还在被提到(不再提到的就删掉,别让表一直长)', () => {
    const sources = walk(join(ROOT, 'src')).filter(file => /\.tsx?$/.test(file))
    const all = sources.flatMap(file => stringsIn(file))
    for (const rel of Object.keys(NOT_READ_FROM_PACKAGE)) {
      expect(all.some(literal => mentions(literal, rel)), `${rel} 已经没人提了,把它从豁免表里删掉`).toBe(true)
    }
  })

  it('★进包的脚本里没有任何一台具体机器的家目录(换一台机器就失效的那种路径)', () => {
    const scripts = packedFiles().map(file => file.path).filter(path => path.startsWith('bin/'))
    expect(scripts.length).toBeGreaterThan(0)
    for (const rel of scripts) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      expect(text, `${rel} 里写死了某台机器的家目录`).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//)
    }
  }, 60_000)

  it('一次性手工工具不进包(probe 那个会读 token;模板只是给人看的)', () => {
    const paths = packedFiles().map(file => file.path)
    expect(paths).not.toContain('bin/probe-ratelimit-headers.sh')
    expect(paths).not.toContain('bin/claude-settings.hooks.json')
    expect(paths).not.toContain('bin/codex-hooks.json')
  }, 60_000)
})

// ————————————— 发出去的脚本里没有维护者本机专属的地址或设置(2026-09-25,卡 R 补,统筹拍板) —————————————

/**
 * 工作台自己的端口:DSH 网页 3080、工作台服务 8791、事务官本机后端 8792。
 * 发出去的脚本里,本机回环地址只许指这几个。要加一个,先想清楚它是不是**每一台机器上都有**的工作台服务。
 */
const WORKBENCH_OWN_PORTS: ReadonlySet<number> = new Set([3080, 8791, 8792])

/**
 * 豁免:发出去的脚本里确实要有、但会被下面的规矩判成「本机专属」的那几处。**每一条写清为什么**;
 * 已经没人命中的条目会让用例红(别让这张表只增不减)。键是仓库相对路径,值是「命中的那一段 → 理由」。
 */
const MACHINE_SPECIFIC_ALLOWED: Readonly<Record<string, Readonly<Record<string, string>>>> = {}

/**
 * 一份发出去的脚本里,维护者本机专属的地址或设置(回一条一条的说明;空数组 = 干净)。
 *
 * 三类(起因:`dsh-start` 里那行 `export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"` —— 维护者本机的
 * 一个代理,随安装包与热更新发给了所有人,DSH 起的 `claude` 命令行全都连不上):
 * 1. 本机回环地址带着**不是工作台自己的**端口(`127.0.0.1:8787`、`localhost:7890`、`--port 8787`);
 * 2. 代理与转发设置(`*_PROXY`、`*_BASE_URL`、`*_API_BASE`、`*_ENDPOINT`……),以及别家客户端自己的
 *    环境变量(`ANTHROPIC_*`、`OPENAI_*`……)—— 那是他本人的环境,不该由我们发的脚本替他定;
 *    名字以 `WORKBENCH_` 开头的是工作台自己的,不算;
 * 3. 某一台机器的家目录(`/Users/<名字>/`)。
 */
export function machineSpecific(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g)) {
    if (!WORKBENCH_OWN_PORTS.has(Number(match[1]))) found.push(`本机地址 ${match[0]}(不是工作台自己的端口)`)
  }
  for (const match of text.matchAll(/--port[=\s]+(\d{2,5})\b/g)) {
    if (!WORKBENCH_OWN_PORTS.has(Number(match[1]))) found.push(`端口 ${match[0]}(不是工作台自己的端口)`)
  }
  const names = [
    // shell:`export NAME=…` / `NAME=…`(注释行不算)
    ...text.split('\n').filter(line => !/^\s*#/.test(line)).flatMap(line => {
      const hit = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
      return hit?.[1] === undefined ? [] : [hit[1]]
    }),
    // plist:EnvironmentVariables 里的 `<key>NAME</key>`(全大写的那种才是环境变量)
    ...[...text.matchAll(/<key>([A-Z][A-Z0-9_]*)<\/key>/g)].map(match => match[1] ?? ''),
  ]
  for (const name of names) {
    if (name.startsWith('WORKBENCH_')) continue
    if (/(^|_)(PROXY|BASE_URL|API_BASE|API_URL|ENDPOINT)$/i.test(name)) found.push(`代理/转发设置 ${name}`)
    else if (/^(ANTHROPIC|OPENAI|CLAUDE|CODEX|KIMI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|AZURE)_/.test(name)) found.push(`别家客户端的环境变量 ${name}`)
  }
  for (const match of text.matchAll(/\/Users\/(?!Shared\/)[A-Za-z0-9._-]+\//g)) {
    found.push(`某台机器的家目录 ${match[0]}`)
  }
  return found
}

/**
 * 装到用户机器上时它**真正长什么样**:plist 由安装那一步把家目录渲染进去,dsh-start 渲染两行(setup/install.ts
 * 同一对函数)。拿渲染之后的去查 —— butler 那份 plist 模板里带着 `/Users/<某人>/`,渲染会把它换掉,不算违规;
 * 换不掉的才算。渲染用的家目录故意不在 `/Users/` 下,剩下的 `/Users/…` 一定是模板自己带出去的。
 */
function asInstalled(rel: string, text: string): string {
  const home = '/家/某人'
  if (rel.endsWith('.plist')) return renderPlist(text, home)
  if (rel.endsWith('/dsh-start')) return renderDshStart(text, `${home}/Documents/工作台`)
  return text
}

/** 发到用户机器上的全部脚本:插件包里的、热更新 scripts.tgz 里的、安装包 payload 里的。 */
function shippedScripts(): { rel: string, via: string[] }[] {
  const all = new Map<string, string[]>()
  const add = (rel: string, via: string): void => { all.set(rel, [...(all.get(rel) ?? []), via]) }
  for (const file of packedFiles()) {
    if (file.path.startsWith('bin/')) add(`workbench-plugin/${file.path}`, '插件包')
  }
  for (const rel of updateScriptFiles()) add(rel, '热更新 scripts.tgz')
  for (const rel of installerScriptFiles()) add(rel, '安装包')
  return [...all.entries()].map(([rel, via]) => ({ rel, via }))
}

describe('守门:发出去的脚本里没有维护者本机专属的地址或设置', () => {
  it('规矩本身:那行代理算违规;工作台自己的端口、WORKBENCH_ 开头的设置不算', () => {
    expect(machineSpecific('export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"\n')).toEqual([
      '本机地址 127.0.0.1:8787(不是工作台自己的端口)',
      '代理/转发设置 ANTHROPIC_BASE_URL',
    ])
    expect(machineSpecific('export HTTPS_PROXY=http://proxy.lan:7890\n')).toEqual(['代理/转发设置 HTTPS_PROXY'])
    expect(machineSpecific('export OPENAI_API_KEY=sk-x\n')).toEqual(['别家客户端的环境变量 OPENAI_API_KEY'])
    expect(machineSpecific('node bin.js web --host 127.0.0.1 --port 3081\n')).toEqual(['端口 --port 3081(不是工作台自己的端口)'])
    expect(machineSpecific('TRACE=/Users/example/.dsh/workbench/statusline.log\n')).toEqual(['某台机器的家目录 /Users/example/'])
    expect(machineSpecific('<key>HTTP_PROXY</key><string>http://127.0.0.1:1087</string>')).toEqual([
      '本机地址 127.0.0.1:1087(不是工作台自己的端口)',
      '代理/转发设置 HTTP_PROXY',
    ])
    // 干净的:工作台自己的端口与设置、注释里的说明、$HOME 起头的路径。
    expect(machineSpecific([
      'export WORKBENCH_CHANNEL_WORKBENCH_URL="${WORKBENCH_CHANNEL_WORKBENCH_URL:-http://127.0.0.1:8791}"',
      'export WORKBENCH_CHANNEL_BUTLER_URL="${WORKBENCH_CHANNEL_BUTLER_URL:-http://127.0.0.1:8792}"',
      'exec node bin.js web --host 127.0.0.1 --port 3080 --no-open',
      '# 不设 ANTHROPIC_BASE_URL 这一类(注释里提一句不算)',
      'export DSH_HOME="$HOME/.dsh"',
      'export WORKBENCH_HOST=0.0.0.0',
    ].join('\n'))).toEqual([])
  })

  it('★要查的脚本读得全:插件包、热更新、安装包三处都读到了,dsh-start 两条发版路上都在', () => {
    const scripts = shippedScripts()
    const dshStart = scripts.find(one => one.rel === 'workbench-plugin/bin/dsh-start')
    expect(dshStart?.via).toEqual(expect.arrayContaining(['热更新 scripts.tgz', '安装包']))
    expect(scripts.some(one => one.via.includes('插件包'))).toBe(true)
    // 发版脚本改了写法、这里一份都没读出来 —— 那是守门失效,不是"干净"。
    expect(updateScriptFiles().length).toBeGreaterThanOrEqual(5)
    expect(installerScriptFiles().length).toBeGreaterThanOrEqual(5)
  }, 60_000)

  it('★插件包、热更新、安装包发出去的每一份脚本(按装到用户机器上的样子)都干净', () => {
    const problems: string[] = []
    for (const { rel, via } of shippedScripts()) {
      const allowed = MACHINE_SPECIFIC_ALLOWED[rel] ?? {}
      const hits = machineSpecific(asInstalled(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')))
        .filter(hit => !Object.keys(allowed).some(key => hit.includes(key)))
      for (const hit of hits) problems.push(`${rel}(${via.join('、')}):${hit}`)
    }
    expect(problems, '发出去的脚本里有维护者本机专属的东西:删掉它,或者在 MACHINE_SPECIFIC_ALLOWED 里写明为什么每台机器都该有').toEqual([])
  }, 60_000)

  it('豁免表里的每一条都还在命中(不再命中的就删掉)', () => {
    for (const [rel, entries] of Object.entries(MACHINE_SPECIFIC_ALLOWED)) {
      const hits = machineSpecific(asInstalled(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')))
      for (const key of Object.keys(entries)) {
        expect(hits.some(hit => hit.includes(key)), `${rel} 里的「${key}」已经没有了,把它从豁免表里删掉`).toBe(true)
      }
    }
  })
})
