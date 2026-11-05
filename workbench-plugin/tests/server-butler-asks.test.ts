// @vitest-environment node
/**
 * 事务官要问的话、要批的事摆到外层(2026-09-25,卡 M)—— 纯函数与两个内存小仓。
 * 真 DSH 里那一遍(waterfall、网页那份面板收掉)由灰度实例跑,见交接。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalKind, askCallOutEvents, combineRequestSignal, createApprovalGrants, createQuestionBroker, describeApproval, findRepoRoot,
  grantTaskAlive, humanizeTech, normalizeQuestionAnswer, optionText, parseEscalation, pathsIn, plainSay, questionViews, toolCallArgsOf,
  voiceAnswerFor, voiceVerdict,
} from '../src/server/butlerAsks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })
function grantsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-grants-'))
  dirs.push(dir)
  return join(dir, 'approval-grants.json')
}

const HOME = '/Users/example'
const TEMP = ['/tmp', '/private/tmp', '/private/var/folders/w5/abc/T']
const REPO = '/Users/example/Documents/GitHub/desktop-workbench'
const repoRootOf = (path: string): string | undefined => (path === REPO || path.startsWith(`${REPO}/`) ? REPO : undefined)

/** 维护者那条真会话里她问的那一问(t-a8934b2a,原样)。 */
const REAL_QUESTION = {
  id: 'confirm_avatar_clip',
  header: '派活前对一遍',
  question: '行,这事我先不自己动手——你自己定的规矩,派活之前先跟你对一遍。\n\n我理解的是:那三张卡左上角的小头像……\n\n要确认的:\n① 就是它们吧\n② 修在哪一层\n③ 派给谁\n④ 怎么算做完\n\n哪条不对说一下,都对就开工。',
  options: [
    { label: '都对,开工', description: '我按上面的默认理解派 Codex 去修。' },
    { label: '都对,但你自己做', description: '不派别家,我自己动手改。' },
    { label: '有不对的,我来说', description: '你指出哪条不对,我改完再开工。' },
  ],
}

describe('不露底层的字', () => {
  it('去掉 ** 、反引号、行首 #、链接记号,字一个不改', () => {
    expect(plainSay('**先说结论**:改 `Composer.tsx` 里那一行\n## 小标题\n> 引一句\n[看这里](http://x.y)')).toBe('先说结论:改 Composer.tsx 里那一行\n小标题\n引一句\n看这里')
    expect(plainSay('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('选项上的 (Recommended) 换成 (推荐);交回去的 label 另存原样', () => {
    expect(optionText('都对,开工 (Recommended)')).toBe('都对,开工(推荐)')
    expect(optionText('**Yes**')).toBe('Yes')
  })

  it('理由里的底层词换成人话,换不动的原样留着', () => {
    expect(humanizeTech('headless Chrome 要写自己的用户目录与 crashpad 目录')).toBe('看不见的浏览器要写自己的用户目录与崩溃记录目录')
    expect(humanizeTech('复现页的 dev server 要在仓库里读源码')).toBe('复现页的预览服务要在仓库里读源码')
    expect(humanizeTech('派 Codex 去改 repo 里那一行')).toBe('派 Codex 去改仓库里那一行')
  })
})

describe('提问经纪人', () => {
  it('挂上 → 看得见 → 答了 → 交回 DSH 要的形状,这一问不在了', async () => {
    const broker = createQuestionBroker()
    let changes = 0
    broker.onChange(() => { changes += 1 })
    const asked = broker.ask({ sessionId: 's-1', questions: [REAL_QUESTION] })
    expect(broker.list()).toHaveLength(1)
    expect(changes).toBe(1)
    expect(broker.answer(asked.id, [{ id: 'confirm_avatar_clip', selected: ['都对,开工'] }])).toEqual({ ok: true })
    expect(await asked.answer).toEqual({ kind: 'answer', answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工'] }] })
    expect(broker.list()).toEqual([])
    expect(changes).toBe(2)
  })

  it('答第二次 409,答法不对 400 且那一问还挂着', () => {
    const broker = createQuestionBroker()
    const asked = broker.ask({ sessionId: 's-1', questions: [REAL_QUESTION] })
    expect(broker.answer(asked.id, [{ id: 'confirm_avatar_clip', selected: ['随便编一个'] }])).toMatchObject({ ok: false, status: 400 })
    expect(broker.list()).toHaveLength(1)
    expect(broker.answer(asked.id, [{ id: 'confirm_avatar_clip', custom: '你自己能修吗' }])).toEqual({ ok: true })
    expect(broker.answer(asked.id, [{ id: 'confirm_avatar_clip', custom: '再答一次' }])).toMatchObject({ ok: false, status: 409 })
  })

  it('这一轮被停了(signal)→ cancelled,那一行消失', async () => {
    const broker = createQuestionBroker()
    const controller = new AbortController()
    const asked = broker.ask({ sessionId: 's-1', questions: [REAL_QUESTION], signal: controller.signal })
    controller.abort()
    expect(await asked.answer).toEqual({ kind: 'cancelled' })
    expect(broker.list()).toEqual([])
  })

  it('已经停了的 signal:挂都不挂', async () => {
    const broker = createQuestionBroker()
    const controller = new AbortController()
    controller.abort()
    let changes = 0
    broker.onChange(() => { changes += 1 })
    const asked = broker.ask({ sessionId: 's-1', questions: [REAL_QUESTION], signal: controller.signal })
    expect(await asked.answer).toEqual({ kind: 'cancelled' })
    expect(broker.list()).toEqual([])
    expect(changes).toBe(0)
  })
})

describe('答案整理', () => {
  const two = [
    { id: 'a', question: '哪个?', options: [{ label: 'x' }, { label: 'y' }] },
    { id: 'b', question: '哪些?', options: [{ label: 'p' }, { label: 'q' }], multiSelect: true },
  ]

  it('单选时「我自己说」顶掉选项;没答的那一问交 selected:[](跳过)', () => {
    expect(normalizeQuestionAnswer(two, [{ id: 'a', selected: ['x'], custom: ' 都不是 ' }])).toEqual({
      ok: true,
      answers: [{ id: 'a', selected: [], custom: '都不是' }, { id: 'b', selected: [] }],
    })
  })

  it('多选可以既选又说', () => {
    expect(normalizeQuestionAnswer(two, [{ id: 'b', selected: ['p', 'q'], custom: '还有 r' }])).toEqual({
      ok: true,
      answers: [{ id: 'a', selected: [] }, { id: 'b', selected: ['p', 'q'], custom: '还有 r' }],
    })
  })

  it('一问都没答、单选选了俩、没问过的 id、不是数组 —— 都不收', () => {
    expect(normalizeQuestionAnswer(two, [])).toMatchObject({ ok: false })
    expect(normalizeQuestionAnswer(two, [{ id: 'a', selected: ['x', 'y'] }])).toMatchObject({ ok: false, error: '这一问只能选一个' })
    expect(normalizeQuestionAnswer(two, [{ id: 'zzz', selected: ['x'] }])).toMatchObject({ ok: false })
    expect(normalizeQuestionAnswer(two, { id: 'a' })).toMatchObject({ ok: false })
  })
})

describe('提问配上卡、文字收拾好', () => {
  it('会话 → 事项;header / question 去记号;选项原样 label + 摆出来的字', () => {
    const broker = createQuestionBroker(() => new Date('2026-09-25T05:49:11Z'))
    broker.ask({ sessionId: 'session-07ed', questions: [{ ...REAL_QUESTION, options: [{ label: '都对,开工 (Recommended)', description: '**派 Codex**' }, ...REAL_QUESTION.options.slice(1)] }] })
    const [view] = questionViews(broker.list(), [{ id: 't-a8934b2a', title: '这个有点问题', conversation: { agent: 'dsh', session_id: 'session-07ed' } }])
    expect(view).toMatchObject({ session_id: 'session-07ed', task_id: 't-a8934b2a', task_title: '这个有点问题', at: '2026-09-25T05:49:11.000Z' })
    expect(view?.questions[0]).toMatchObject({ id: 'confirm_avatar_clip', header: '派活前对一遍', multi: false })
    expect(view?.questions[0]?.options[0]).toEqual({ label: '都对,开工 (Recommended)', text: '都对,开工(推荐)', note: '派 Codex' })
  })

  it('没 id / 没正文的那一问不挂', () => {
    const broker = createQuestionBroker()
    broker.ask({ sessionId: 's', questions: [{ question: '没 id' }, { id: 'ok', question: '有' }, 'junk'] })
    expect(broker.list()[0]?.questions.map(q => q.id)).toEqual(['ok'])
  })
})

describe('审批说人话', () => {
  it('提到最高权限:说清要做什么、为什么、放开到多大;原话进「看原始」', () => {
    const detail = describeApproval({
      tool: 'bash',
      reason: 'escalate sandbox to danger-full-access: headless Chrome 要写自己的用户目录与 crashpad 目录(都在会话工作目录之外)才能把复现页面渲染出来。',
      args: { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=/tmp/wbcrop/before.png', sandbox_permissions: 'danger-full-access' },
      kind: { key: 'browser', title: '开看不见的浏览器截图' },
      workspaceName: '工作台',
    })
    expect(detail.say).toBe('要开一个看不见的浏览器,把页面截下来看')
    expect(detail.why).toBe('看不见的浏览器要写自己的用户目录与崩溃记录目录(都在会话工作目录之外)才能把复现页面渲染出来。')
    expect(detail.scope).toBe('这一条要能改这台电脑上的任何文件;平时只能改「工作台」文件夹和临时文件。')
    expect(detail.raw.reason).toContain('escalate sandbox to danger-full-access')
    expect(detail.raw.command).toContain('--headless=new')
    // 摆出来的那几行里一个英文键名都没有。
    for (const line of [detail.say, detail.why, detail.scope]) expect(line).not.toMatch(/danger-full-access|sandbox|escalate|bash/i)
  })

  it('仓库那一类:说「在「desktop-workbench」这个仓库里跑一条命令」', () => {
    const detail = describeApproval({ tool: 'bash', reason: 'escalate sandbox to danger-full-access: 工作台自己的仓库在会话工作目录之外', kind: { key: `repo:${REPO}`, title: '改「desktop-workbench」这个仓库' } })
    expect(detail.say).toBe('要在「desktop-workbench」这个仓库里跑一条命令')
  })

  it('钩子判的审批:中文理由摆出来,英文的只进「看原始」', () => {
    expect(describeApproval({ tool: 'write', reason: '要写 /etc/hosts' })).toMatchObject({ say: '要写一个文件', why: '要写 /etc/hosts', scope: '只这一次。' })
    const english = describeApproval({ tool: 'bash', reason: 'tool "bash" requires approval' })
    expect(english.why).toBeUndefined()
    expect(english.raw.reason).toBe('tool "bash" requires approval')
  })

  it('认得出上游那句提权原话', () => {
    expect(parseEscalation('escalate sandbox to danger-full-access: 为什么')).toEqual({ mode: 'danger-full-access', why: '为什么' })
    expect(parseEscalation('要写 /etc/hosts')).toBeUndefined()
  })
})

describe('同一件事里「同类的」', () => {
  const kind = (command: string, extra: Record<string, unknown> = {}) => approvalKind({
    tool: 'bash', args: { command, sandbox_permissions: 'danger-full-access', ...extra }, home: HOME, tempRoots: TEMP, repoRootOf,
  })

  it('维护者那条会话里的五次:四次认成同一个仓库,一次认成开浏览器截图', () => {
    expect(kind(`cd ${REPO} && git switch -c fix/avatar-headroom 2>&1 | tail -3 && git branch --show-current`)).toEqual({ key: `repo:${REPO}`, title: '改「desktop-workbench」这个仓库' })
    expect(kind(`mkdir -p ${REPO}/workbench-plugin/dev/avatar-clip && cd ${REPO}/workbench-plugin/dev/avatar-clip && cat > vite.config.mjs <<'EOF'\nimport x\nEOF`)?.key).toBe(`repo:${REPO}`)
    expect(kind(`cd ${REPO}/workbench-plugin/dev/avatar-clip && ../../node_modules/.bin/vite --config vite.config.mjs 2>&1`)?.key).toBe(`repo:${REPO}`)
    expect(kind('cd /tmp/wbcrop && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --user-data-dir=/tmp/chrome-avatar --screenshot=/tmp/wbcrop/before.png --dump-dom "http://127.0.0.1:4199/?run=6000" > /tmp/wbcrop/dom.html 2>/tmp/wbcrop/chrome.log')).toEqual({ key: 'browser', title: '开看不见的浏览器截图' })
  })

  it('不是提权、删东西、sudo、跨两个仓库、碰到家目录 —— 都不给合并', () => {
    expect(approvalKind({ tool: 'bash', args: { command: `cd ${REPO} && ls` }, home: HOME, tempRoots: TEMP, repoRootOf })).toBeUndefined()
    expect(kind(`cd ${REPO} && rm -rf dist`)).toBeUndefined()
    expect(kind(`sudo ls ${REPO}`)).toBeUndefined()
    expect(kind(`cp ${REPO}/a /Users/example/Documents/other/b`)).toBeUndefined()
    expect(kind('ls ~/Library')).toBeUndefined()
    expect(kind('echo hi')).toBeUndefined()
  })

  it('写文件工具看 file_path', () => {
    expect(approvalKind({ tool: 'write', args: { file_path: `${REPO}/docs/x.md`, sandbox_permissions: 'danger-full-access' }, home: HOME, tempRoots: TEMP, repoRootOf })?.key).toBe(`repo:${REPO}`)
  })

  it('浏览器命令里要是还写到仓库外别处,就不算「开浏览器截图」', () => {
    expect(kind('"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=/Users/example/Desktop/x.png about:blank')).toBeUndefined()
  })

  it('捡路径:引号里的、~ 开头的、= 后面的', () => {
    expect(pathsIn(`cd "/Applications/Google Chrome.app" && ls ~/x --out=/tmp/y`, HOME)).toEqual(['/Applications/Google', '/Users/example/x', '/tmp/y'])
  })

  it('找仓库根:往上找 .git;家目录与根目录不算', () => {
    const exists = (path: string) => path === `${REPO}/.git` || path === '/Users/example/.git'
    expect(findRepoRoot(`${REPO}/workbench-plugin/dev/avatar-clip`, HOME, exists)).toBe(REPO)
    expect(findRepoRoot('/Users/example/Documents/other', HOME, exists)).toBeUndefined()
  })
})

describe('「这件事里同类的都允许」', () => {
  const now = () => new Date('2026-09-25T06:00:00Z')
  const browser = { key: 'browser', title: '开看不见的浏览器截图' }

  it('没挂在事项上的:只认这条会话 → 数放行几次 → 收回', () => {
    const grants = createApprovalGrants({ now })
    grants.grant({ sessionId: 's-1' }, browser)
    expect(grants.granted({ sessionId: 's-1' }, 'browser')).toBe(true)
    expect(grants.granted({ sessionId: 's-2' }, 'browser')).toBe(false)
    grants.noteAllowed({ sessionId: 's-1' }, 'browser')
    expect(grants.list()).toEqual([{ session_id: 's-1', key: 'browser', title: '开看不见的浏览器截图', allowed: 1, at: '2026-09-25T06:00:00.000Z' }])
    expect(grants.revoke({ sessionId: 's-1' }, 'browser')).toBe(true)
    expect(grants.granted({ sessionId: 's-1' }, 'browser')).toBe(false)
    expect(grants.revoke({ sessionId: 's-1' }, 'browser')).toBe(false)
  })

  it('★记在这件事上:这件事换了一条会话接着办照样认;别的事不认', () => {
    const grants = createApprovalGrants({ now })
    grants.grant({ sessionId: 's-1', taskId: 't-1' }, browser)
    expect(grants.granted({ sessionId: 's-9', taskId: 't-1' }, 'browser')).toBe(true)
    expect(grants.granted({ sessionId: 's-1', taskId: 't-2' }, 'browser')).toBe(false)
    expect(grants.granted({ sessionId: 's-1' }, 'browser')).toBe(false)
  })

  it('★DSH 重启之后(新的一份从盘上读回来):同一件事的同一类不再问;没挂在事项上的不落盘', async () => {
    const file = grantsFile()
    const before = createApprovalGrants({ file, now })
    before.grant({ sessionId: 's-1', taskId: 't-1' }, browser)
    before.grant({ sessionId: 's-2' }, { key: 'repo:/r', title: '改「r」这个仓库' })
    before.noteAllowed({ sessionId: 's-1', taskId: 't-1' }, 'browser')
    await before.flush()
    const after = createApprovalGrants({ file, now })
    await after.load()
    expect(after.granted({ sessionId: 's-new', taskId: 't-1' }, 'browser')).toBe(true)
    expect(after.list()).toEqual([{ session_id: 's-1', task_id: 't-1', key: 'browser', title: '开看不见的浏览器截图', allowed: 1, at: '2026-09-25T06:00:00.000Z' }])
  })

  it('★那件事收了(完成 / 取消,验收通过就是完成)或者不在了:记在它上面的作废,盘上也没了', async () => {
    const file = grantsFile()
    const grants = createApprovalGrants({ file, now })
    grants.grant({ sessionId: 's-1', taskId: 't-done' }, browser)
    grants.grant({ sessionId: 's-2', taskId: 't-canceled' }, browser)
    grants.grant({ sessionId: 's-3', taskId: 't-gone' }, browser)
    grants.grant({ sessionId: 's-4', taskId: 't-doing' }, browser)
    grants.grant({ sessionId: 's-5', taskId: 't-confirm' }, browser)
    const alive = grantTaskAlive([
      { id: 't-done', status: 'done' }, { id: 't-canceled', status: 'canceled' }, { id: 't-doing', status: 'doing' }, { id: 't-confirm', status: 'confirm' },
    ])
    expect(grants.prune(alive)).toBe(3)
    expect(grants.list().map(one => one.task_id)).toEqual(['t-doing', 't-confirm'])
    await grants.flush()
    expect((JSON.parse(readFileSync(file, 'utf8')) as { grants: { task_id: string }[] }).grants.map(one => one.task_id)).toEqual(['t-doing', 't-confirm'])
  })

  it('盘上那份读坏了 / 形状不对:当一条都没有(宁可多问一次)', async () => {
    const file = grantsFile()
    writeFileSync(file, '{ 不是 json')
    const broken = createApprovalGrants({ file, now })
    await broken.load()
    expect(broken.list()).toEqual([])
    writeFileSync(file, JSON.stringify({ version: 1, grants: [{ session_id: 's', key: 'browser', title: 'x', allowed: 0, at: 'x' }] }))
    const noTask = createApprovalGrants({ file, now })
    await noTask.load()
    expect(noTask.list()).toEqual([])
  })
})

describe('读会话里那一次工具调用', () => {
  function session(events: unknown[]) {
    return { seq: events.length, eventAt: (seq: number) => events[seq] }
  }
  it('按 callId 往回找,解出 arguments', () => {
    const s = session([
      { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'assistant/message', data: {} },
      { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: '{"command":"pwd","sandbox_permissions":"danger-full-access"}' } },
    ])
    expect(toolCallArgsOf(s, 'c2')).toEqual({ command: 'pwd', sandbox_permissions: 'danger-full-access' })
    expect(toolCallArgsOf(s, 'c1')).toEqual({ command: 'ls' })
    expect(toolCallArgsOf(s, 'nope')).toBeUndefined()
    expect(toolCallArgsOf({}, 'c1')).toBeUndefined()
  })
})

describe('请求上的 signal 换成合成的那一个', () => {
  it('原来那个停了 → 合成的也停;我们这一半停了 → 合成的也停,原来那个不受影响', () => {
    const outer = new AbortController()
    const local = new AbortController()
    const request: { signal?: AbortSignal } = { signal: outer.signal }
    combineRequestSignal(request, local.signal)
    expect(request.signal).not.toBe(outer.signal)
    local.abort()
    expect(request.signal?.aborted).toBe(true)
    expect(outer.signal.aborted).toBe(false)
  })

  it('原来没有 signal:就用我们这一个', () => {
    const local = new AbortController()
    const request: { signal?: AbortSignal } = {}
    combineRequestSignal(request, local.signal)
    expect(request.signal).toBe(local.signal)
  })
})

describe('手机响铃那一类(ask)与电话里答(卡 M)', () => {
  const view = questionViews([{ id: 'q-1', session_id: 's', at: '2026-09-25T06:00:00.000Z', questions: [REAL_QUESTION] }], [{ id: 't-1', title: '这个有点问题,你看三张卡片的左上角', conversation: { agent: 'dsh', session_id: 's' } }])

  it('每一问 / 每一条一个 key、挂在那张卡上;没挂在卡上的不打', () => {
    const events = askCallOutEvents(view, [
      { id: 'a-1', task_id: 't-1', task_title: '修小头像', at: 'x', tool: 'bash', say: '要开一个看不见的浏览器,把页面截下来看', scope: '这一条要能改这台电脑上的任何文件;平时只能改「工作台」文件夹和临时文件。' },
      { id: 'a-2', at: 'x', tool: 'bash', say: '没挂在卡上的' },
    ])
    expect(events.map(one => one.key)).toEqual(['ask:question:q-1', 'ask:approval:a-1'])
    expect(events[0]).toMatchObject({ reason: 'ask', item_id: 't-1', title: '「这个有点问题,你看三张卡片的左上…」问你:派活前对一遍' })
    expect(events[0]?.note).toContain('选项:都对,开工 / 都对,但你自己做 / 有不对的,我来说')
    expect(events[1]).toMatchObject({ item_id: 't-1', title: '「修小头像」要你批:要开一个看不见的浏览器,把页面截下来看' })
    for (const one of events) expect(`${one.title}${one.note ?? ''}`).not.toMatch(/她|danger-full-access|escalate/)
  })

  it('电话里说中了某个选项就选它;认不准就把原话当「我自己说」,不替他挑', () => {
    const item = view[0]!.questions[0]!
    expect(voiceAnswerFor(item, '都对,开工吧')).toEqual({ answer: { id: 'confirm_avatar_clip', selected: ['都对,开工'] }, picked: '都对,开工' })
    expect(voiceAnswerFor(item, '你自己做')).toMatchObject({ picked: '都对,但你自己做' })
    expect(voiceAnswerFor(item, '都对')).toEqual({ answer: { id: 'confirm_avatar_clip', selected: [], custom: '都对' } })
    expect(voiceAnswerFor(item, '第二条不对,修在壳里')).toEqual({ answer: { id: 'confirm_avatar_clip', selected: [], custom: '第二条不对,修在壳里' } })
  })

  it('要批的:先认「不」(「不行」里也有「行」),听不出就不交', () => {
    expect(voiceVerdict('行,批吧')).toBe('allow')
    expect(voiceVerdict('不行')).toBe('deny')
    expect(voiceVerdict('先别动')).toBe('deny')
    expect(voiceVerdict('嗯……我想想')).toBeUndefined()
  })
})
