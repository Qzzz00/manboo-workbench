// @vitest-environment node
/**
 * 页面连自己的服务端口 —— 宿主那一半 + 守门(2026-09-26,卡 GP)。页面那一半在
 * `client-service-origin.test.ts`。
 *
 * 两件事:
 * 1. 宿主半区真往 DSH 的 index 注入表里放了「我的服务地址」那一行,而且值跟着 env 走;
 * 2. **守门**:`src/client/` 下写死的 8791 只允许剩 `useWorkbenchState.ts` 那一处兜底。
 *    这一条是这张卡的本体 —— 机制修好了,下一个人也不能再把端口写回页面里。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { announceServiceOrigin } from '../src/index.ts'
import { resolveWorkbenchHost, resolveWorkbenchPort } from '../src/server/http.ts'
import { BUNDLED_BUTLER_SKILLS, BUNDLED_SKILL_DOCS } from '../src/server/bundledSkills.generated.ts'
import { SERVICE_URL_PLACEHOLDER, pointServiceAt } from '../src/server/bundledSkills.ts'
import { SERVICE_CONFIG_GLOBAL, serviceBaseUrl, serviceInjectRow } from '../src/serviceOrigin.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
/** 页面里唯一允许写死的那个地址(`src/client/useWorkbenchState.ts` 的 `DEFAULT_BASE_URL`)。 */
const ALLOWED_FALLBACK = 'http://127.0.0.1:8791'

describe('宿主半区:把服务地址放进 DSH 的 index 注入表', () => {
  /** 只认 `on`,像 DSH 那样把注入表递给监听者。 */
  function fakeCtx() {
    const listeners = new Map<string, (table: never) => void>()
    return {
      on: (event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener as (table: never) => void)
        return () => {}
      },
      render: (event = 'webserver/index-inject'): unknown[] => {
        const table: unknown[] = []
        listeners.get(event)?.(table as never)
        return table
      },
      events: () => [...listeners.keys()],
    }
  }

  it('灰度的 env(WORKBENCH_PORT=8890)→ 表里那一行就是 8890', () => {
    const ctx = fakeCtx()
    announceServiceOrigin(ctx, { WORKBENCH_PORT: '8890', WORKBENCH_HOST: '127.0.0.1' })
    expect(ctx.events()).toEqual(['webserver/index-inject'])
    expect(ctx.render()).toEqual([
      { kind: 'global', name: SERVICE_CONFIG_GLOBAL, value: { baseUrl: 'http://127.0.0.1:8890' } },
    ])
  })

  it('生产的 env(WORKBENCH_HOST=0.0.0.0、没配端口)→ 回环 + 默认 8791,行为一点不变', () => {
    const ctx = fakeCtx()
    announceServiceOrigin(ctx, { WORKBENCH_HOST: '0.0.0.0' })
    expect(ctx.render()).toEqual([serviceInjectRow('0.0.0.0', 8791)])
    expect(ctx.render()[0]).toMatchObject({ value: { baseUrl: ALLOWED_FALLBACK } })
  })

  it('不往表里加别的:那一行只有地址(它会渲进谁都看得见的 HTML,凭据一个字都不许上去)', () => {
    expect(Object.keys(serviceInjectRow('0.0.0.0', 8890).value as object)).toEqual(['baseUrl'])
  })

  it('端口写坏了当场抛(同 resolveWorkbenchPort 的老规矩,不静默退回默认值)', () => {
    expect(() => { announceServiceOrigin(fakeCtx(), { WORKBENCH_PORT: '不是端口' }) })
      .toThrow(/WORKBENCH_PORT/)
  })

  it('DSH 那半没接上(ctx 缺席)不抛 —— 页面退回兜底,服务照常起', () => {
    expect(() => { announceServiceOrigin(undefined, { WORKBENCH_PORT: '8890' }) }).not.toThrow()
  })
})

describe('守门:页面源码里不许再出现写死的 8791', () => {
  /** git 跟踪着的、`src/client/` 下的每一份源码(.ts / .tsx / 随包走的 .js)。 */
  function clientSources(): string[] {
    return execFileSync('git', ['ls-files', 'src/client'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim())
      .filter(line => /\.(ts|tsx|js)$/.test(line))
  }

  /**
   * 一份源码里所有字符串与数字字面量(模板字符串拆成各段)。**注释不算** —— 注释里说
   * 「服务在 8791」是在讲道理,不是在发请求;这也是不能拿 `grep` 直接数的原因
   * (`src/client/` 下光注释就有七八处提到 8791)。
   */
  function literalsIn(file: string): string[] {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const kind = file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
    const out: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) {
        out.push(node.text)
      }
      else if (ts.isTemplateExpression(node)) {
        out.push(node.head.text)
        for (const span of node.templateSpans) out.push(span.literal.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return out
  }

  it('只剩 useWorkbenchState 那一处兜底', () => {
    const hits = clientSources().filter(file => literalsIn(file).some(text => text.includes('8791')))
    // 兜底那一处必须还在(它是这条守门被许可的那一项,不是"恰好没命中")。
    expect(hits).toEqual(['src/client/useWorkbenchState.ts'])
    expect(literalsIn('src/client/useWorkbenchState.ts').filter(text => text.includes('8791')))
      .toEqual([ALLOWED_FALLBACK])
  })

  it('同一条的另一半:页面源码里写死的 DSH 页面地址(127.0.0.1:3080)也不许有', () => {
    // 灰度的 DSH 在 3090。两处例外都不是请求地址,是给人看的字:
    // accountApi 那句「请用 http://127.0.0.1:3080 打开工作台」、sentinel 的输入格式示例。
    const hits = clientSources()
      .filter(file => file !== 'src/client/account/accountApi.ts' && file !== 'src/client/sentinel.ts')
      .filter(file => literalsIn(file).some(text => text.includes('127.0.0.1:3080')))
    expect(hits).toEqual([])
  })
})

/**
 * ★ 卡 SP(2026-09-26):**守门扩到技能正文**。
 *
 * 卡 GP 修的是页面,它的语法树守门只扫 `src/client` —— Markdown 正文不在扫描范围里。于是
 * `docs/技能/` 下三份技能里的 `http://127.0.0.1:8791/...` 一直活着,灰度实例(`WORKBENCH_PORT=8890`)
 * 里的事务官照它去派活,**派的是生产**(卡 ZM 撞出)。技能正文由 `gen-bundled-skills.mjs` 原样
 * 打进 `bundledSkills.generated.ts`,再写进用户机器的 `~/.dsh/AGENTS.md` —— 所以两头都得盯:
 * 仓库里那几份 `.md`(改技能的人动的是它)、和包内那一份(发版带走的是它)。
 */
describe('守门:技能正文里不许写死工作台地址', () => {
  /**
   * 例外清单。**只能变短,不能变长**:下面几条用例按 `toEqual` 钉住它,想加一条就得动这里,
   * 而动这里的人会先读到上面那段"为什么"。今天一条都没有 —— 给人看的说明一律用
   * `{{工作台地址}}`(占位)或者干脆不提端口(`.dsh/skills/引导/SKILL.md` 那一处就是这么改的:
   * 「只认那条消息里的地址」)。
   */
  const ALLOWED: readonly string[] = []

  /** git 跟踪着的 `docs/技能/*.md`。 */
  function skillDocs(): string[] {
    return execFileSync('git', ['ls-files', 'docs/技能'], { cwd: join(ROOT, '..'), encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.endsWith('.md'))
  }

  it('★仓库里的 docs/技能/*.md:一处写死的 8791 都没有', () => {
    const hits = skillDocs().filter((file) => {
      const text = readFileSync(join(ROOT, '..', file), 'utf8')
      return text.includes('127.0.0.1:8791') || text.includes(':8791/') || /(^|[^\d])8791([^\d]|$)/.test(text)
    })
    expect(hits).toEqual(ALLOWED)
  })

  it('★包内那一份(bundledSkills.generated.ts)也一处都没有 —— 发版带走的是它', () => {
    // 逐条看,而不是扫整个生成文件的文本:红的时候要说得出是哪一份技能。
    const hits = [
      ...Object.entries(BUNDLED_SKILL_DOCS).map(([name, text]) => [`docs/技能/${name}`, text] as const),
      ...Object.entries(BUNDLED_BUTLER_SKILLS).map(([name, text]) => [`.dsh/skills/${name}/SKILL.md`, text] as const),
    ].filter(([, text]) => text.includes('8791')).map(([name]) => name)
    expect(hits).toEqual(ALLOWED)
  })

  it('那四条接口真的还在正文里(别把地址删干净了连路径一起删掉)', () => {
    const dispatch = BUNDLED_SKILL_DOCS['派活给别家Agent.md'] ?? ''
    for (const path of ['/dispatch/run', '/dispatch/choices', '/progress/ask', '/agents/quota']) {
      expect(dispatch, path).toContain(`${SERVICE_URL_PLACEHOLDER}${path}`)
    }
    expect(BUNDLED_SKILL_DOCS['运营-给AI分发任务.md'] ?? '').toContain(`${SERVICE_URL_PLACEHOLDER}/dispatch/api`)
    const confirm = BUNDLED_SKILL_DOCS['需求确认点.md'] ?? ''
    for (const path of ['/confirm/points', '/feature/confirm', '/topic/confirm']) {
      expect(confirm, path).toContain(`${SERVICE_URL_PLACEHOLDER}${path}`)
    }
  })
})

describe('技能正文里的 {{工作台地址}} 渲成谁', () => {
  /** 带占位的那几份(守门那几条保证这就是全部;2026-09-26 卡 BR 起多了「捎话给正在跑的会话」)。 */
  const withPlaceholder = Object.entries(BUNDLED_SKILL_DOCS)
    .filter(([, text]) => text.includes(SERVICE_URL_PLACEHOLDER))

  it('★灰度的 env(WORKBENCH_PORT=8890)→ 正文里全是 8890,一个 8791 都没有', () => {
    const env = { WORKBENCH_PORT: '8890' }
    const baseUrl = serviceBaseUrl(resolveWorkbenchHost(env), resolveWorkbenchPort(env))
    expect(baseUrl).toBe('http://127.0.0.1:8890')
    expect(withPlaceholder.map(([name]) => name).sort())
      .toEqual(['发文件到手机.md', '派活给别家Agent.md', '捎话给正在跑的会话.md', '需求确认点.md', '运营-给AI分发任务.md'].sort())
    for (const [name, text] of withPlaceholder) {
      const rendered = pointServiceAt(text, baseUrl)
      expect(rendered, name).not.toContain('8791')
      expect(rendered, name).not.toContain(SERVICE_URL_PLACEHOLDER)
      expect(rendered, name).toContain('http://127.0.0.1:8890/')
    }
  })

  it('★缺省的 env(没配端口)→ 还是 http://127.0.0.1:8791,生产一个字没变', () => {
    const baseUrl = serviceBaseUrl(resolveWorkbenchHost({}), resolveWorkbenchPort({}))
    expect(baseUrl).toBe(ALLOWED_FALLBACK)
    // 改之前正文里逐字写着的就是这几句 —— 渲出来一字不差。
    const dispatch = pointServiceAt(BUNDLED_SKILL_DOCS['派活给别家Agent.md'] ?? '', baseUrl)
    expect(dispatch).toContain('GET http://127.0.0.1:8791/dispatch/choices?item=<事项 id>')
    expect(dispatch).toContain('POST http://127.0.0.1:8791/dispatch/run')
    expect(dispatch).toContain('`GET http://127.0.0.1:8791/agents/quota`')
    expect(dispatch).toContain('`POST http://127.0.0.1:8791/progress/ask {"text":"<他问的原话>"}`')
    expect(pointServiceAt(BUNDLED_SKILL_DOCS['运营-给AI分发任务.md'] ?? '', baseUrl))
      .toContain('`POST http://127.0.0.1:8791/dispatch/api`')
    expect(pointServiceAt(BUNDLED_SKILL_DOCS['需求确认点.md'] ?? '', baseUrl))
      .toContain('POST http://127.0.0.1:8791/confirm/points {')
  })

  it('通配地址 / localhost 都收成回环(跟页面那一半同一个算法,不然是两个端口)', () => {
    expect(serviceBaseUrl('0.0.0.0', 8890)).toBe('http://127.0.0.1:8890')
    expect(serviceBaseUrl('localhost', 8890)).toBe('http://127.0.0.1:8890')
    // 显式绑了局域网 IP 的旧用法:回环上根本没人听,原样用它。
    expect(serviceBaseUrl('192.168.1.7', 8890)).toBe('http://192.168.1.7:8890')
  })

  it('没有占位的正文一个字不动', () => {
    const plain = '# 技能:随便\n\n正文若干。\n'
    expect(pointServiceAt(plain, 'http://127.0.0.1:8890')).toBe(plain)
  })
})
