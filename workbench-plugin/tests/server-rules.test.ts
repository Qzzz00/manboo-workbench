// @vitest-environment node
/**
 * 他的规矩:一处存、处处读(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md)。
 *
 * 钉这几件:
 * 1. 从「观察」导入:统筹写的三条 → ①…⑪ 各一条 + 两条总纲,共 13 条;没加粗的观察不导;
 * 2. 归类:不要蓝 → 界面,电话每轮两句 → 说话,总纲 → 全局,怎么验收 → 验收;
 * 3. 明说才记:「以后都不要蓝」记,「以后再说」「我每次都得自己去找」「以后都要这样吗」不记;
 * 4. 四个时刻的那几段字:AGENTS.md 段有全文 + 怎么用;电话段说话几条全文、其余只列短名;
 *    派活段做界面的活带界面那几条、不带说话那几条;非界面的活不带界面那几条;
 * 5. 自查:带蓝的结果不过,打回原话说清在哪;不带蓝的过;「要蓝」的规矩不查蓝;
 * 6. 重复出现 → 试用 → 下一件通过保留 / 又打回同一处撤(同 evolve.ts 那一把尺);
 * 7. 服务:加、改、删、恢复、同一句不重复、删过的又说一遍重新生效、系统写的字不收;
 *    每次变了都同步 AGENTS.md 那一段,一条都没有时摘掉;自查没过的活 heldBack 回一句,重新派了清掉。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentsRulesBlock, callRulesBlock, createRulesService, dispatchRulesBlock, ECHO_RULE_TITLE, explicitRuleOf, findBlue, forbidsBlue,
  inferRules, limitsSentences, looksSystemWritten, plainForAgent, rejectText, reviewAgainstRules, ruleAreaOf, ruleHow, ruleId, ruleTitleOf,
  rulesFromObservations, sayLimitOf, verifyRule, withDispatchRules, type RuleEvent, type StoredRule,
} from '../src/server/rules.ts'
import { OBSERVATIONS } from './fixtures/rulesObservations.ts'

const NOW = Date.parse('2026-09-24T13:00:00Z')
const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function rule(text: string, extra: Partial<StoredRule> = {}): StoredRule {
  return {
    id: ruleId(text), text, title: ruleTitleOf(text), area: ruleAreaOf(text), status: 'active', origin: 'said',
    evidence: [], created_at: '2026-09-24T12:00:00.000Z', updated_at: '2026-09-24T12:00:00.000Z', ...extra,
  }
}

const SEED = rulesFromObservations(OBSERVATIONS).map(one => rule(one.text, { origin: 'observation' }))

describe('从「观察」导入', () => {
  it('三条观察 → 13 条规矩(①…⑪ 各一条 + 两条总纲);没加粗的不导;引导记录里的加粗不导', () => {
    const found = rulesFromObservations(OBSERVATIONS)
    expect(found).toHaveLength(13)
    expect(found[0]?.text.startsWith('他说过一次的规矩全局生效:不分模板')).toBe(true)
    expect(found[1]?.text.startsWith('怎么验收派出去的活(做界面')).toBe(true)
    expect(found.map(one => one.text)).toContain('不要蓝(球的「完成」色也不要)、不要卡片框、只做深色')
    expect(found.map(one => one.text)).toContain('窗口首次打开在横屏主显示器上')
    expect(found.some(one => one.text.includes('播客'))).toBe(false)
    expect(found.some(one => one.text.includes('称呼'))).toBe(false)
    expect(found[2]?.why).toContain('逐条的意见')
    expect(found[2]?.at).toBe('2026-09-24T12:00:00.000Z')
  })

  it('没有「观察」一节 → 一条都没有', () => {
    expect(rulesFromObservations('# 用户:X\n\n## 自述\n- **别的**:a')).toEqual([])
  })
})

describe('归类与短名', () => {
  it('他那 13 条归到该去的块', () => {
    const byTitle = new Map(SEED.map(one => [one.title, one.area]))
    expect(byTitle.get('他说过一次的规矩全局生效')).toBe('all')
    expect(byTitle.get('怎么验收派出去的活')).toBe('review')
    expect(byTitle.get('不要蓝')).toBe('ui')
    expect(byTitle.get('粒子球是主角')).toBe('ui')
    expect(byTitle.get('电话每轮不超过两句')).toBe('say')
    expect(byTitle.get('窗口首次打开在横屏主显示器上')).toBe('ui')
    expect(SEED.find(one => one.text.startsWith('电话不能被'))?.area).toBe('all')
    expect(SEED.find(one => one.text.startsWith('各家 Agent'))?.area).toBe('review')
  })

  it('短名取第一个停顿之前;太短就退回整句头上那一截', () => {
    expect(ruleTitleOf('不要蓝(球的「完成」色也不要)')).toBe('不要蓝')
    expect(ruleTitleOf('光效(卡片、输入框、拖窗进窗口槽)在真 App 里看得见')).toBe('光效(卡片、输入框、拖窗进窗口槽…')
  })
})

describe('明说才记', () => {
  it.each([
    ['以后界面都不要蓝', '以后界面都不要蓝'],
    ['好的。以后派活先截图给我看', '以后派活先截图给我看'],
    ['别再念文件路径了', '别再念文件路径了'],
    ['记住,名字没听清就让我打字', '记住,名字没听清就让我打字'],
    ['今后不用问我,直接做', '今后不用问我,直接做'],
  ])('「%s」→ 记', (said, expected) => {
    expect(explicitRuleOf(said)).toBe(expected)
  })

  it.each([
    '以后再说吧', '以后有空看看', '我每次都得自己去找', '我以后要去北京', '以后都要这样吗', '以后都这样', '帮我看看首页为什么是蓝的',
  ])('「%s」→ 不记', (said) => {
    expect(explicitRuleOf(said)).toBeUndefined()
  })

  it('系统写的字认得出来', () => {
    expect(looksSystemWritten('时长:4 秒。这通电话没有留下转写')).toBe(true)
    expect(looksSystemWritten('引导 ②′ 排的方案「desktop-workbench」。交接里排的第三件')).toBe(true)
    expect(looksSystemWritten('不要蓝')).toBe(false)
  })
})

describe('四个时刻的那几段字', () => {
  it('AGENTS.md 段:13 条全文 + 怎么用(派活、收回结果、记新规矩的接口都写死)', () => {
    const block = agentsRulesBlock(SEED) as string
    expect(block).toContain('## 他的规矩(处处照做)')
    expect(block).toContain('〔界面〕不要蓝(球的「完成」色也不要)、不要卡片框、只做深色')
    expect(block).toContain('〔说话〕电话每轮不超过两句')
    expect(block).toContain('/butler/rules/brief?for=dispatch&item=<事项 id>')
    expect(block).toContain('review.reject_text')
    expect(block).toContain('/butler/rules/feedback')
    // 全局那几条排最前。
    expect(block.indexOf('他说过一次的规矩全局生效')).toBeLessThan(block.indexOf('不要蓝'))
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThan(8_000)
  })

  it('一条都不算数 → 没有这一段(调用方据此摘掉)', () => {
    expect(agentsRulesBlock([])).toBeUndefined()
    expect(agentsRulesBlock([rule('不要蓝', { status: 'removed' })])).toBeUndefined()
  })

  it('电话段:说话 + 全局全文,其余只列短名(里面有「不要蓝」)', () => {
    const block = callRulesBlock(SEED) as string
    expect(block).toContain('电话每轮不超过两句,不念总结、不念路径')
    expect(block).toContain('他说过一次的规矩全局生效')
    expect(block).toMatch(/办事、派活、验收时还要照做的:.*不要蓝/u)
    // 界面那几条不写全文(不稀释「每轮两句」)。
    expect(block).not.toContain('球的「完成」色也不要')
    expect(block.length).toBeLessThan(900)
  })

  it('派活段:做界面的活带界面那几条 + 全局,不带说话;非界面的活只带全局', () => {
    const ui = dispatchRulesBlock(SEED, '[派活测试] 做一个登录按钮的小网页') as { text: string, ids: string[] }
    expect(ui.text).toContain('不要蓝(球的「完成」色也不要)')
    expect(ui.text).toContain('他说过一次的规矩全局生效')
    expect(ui.text).not.toContain('电话每轮不超过两句')
    const plain = dispatchRulesBlock(SEED, '把 README 里的错别字改一下') as { text: string }
    expect(plain.text).not.toContain('不要蓝')
    expect(plain.text).toContain('他说过一次的规矩全局生效')
  })

  it('电话每轮几句:从规矩表认出来(机器执行那一半);删了那条就不掐', () => {
    expect(sayLimitOf(SEED)).toBe(2)
    expect(sayLimitOf(SEED.map(one => (one.title === '电话每轮不超过两句' ? { ...one, status: 'removed' as const } : one)))).toBeUndefined()
    expect(sayLimitOf([rule('打电话最多三句')])).toBe(3)
    expect(sayLimitOf([rule('界面最多两句说明', { area: 'ui' })])).toBeUndefined()
  })

  it('「电话不能被构建、测试挤卡」那条带上这台 Mac 的做法(taskpolicy -c utility,不用 nice)', () => {
    const ui = dispatchRulesBlock(SEED, '做一个登录页') as { text: string }
    expect(ui.text).toMatch(/电话不能被电脑上的构建、测试、派出去的活挤卡\(做法:.*taskpolicy -c utility/u)
    expect(agentsRulesBlock(SEED)).toContain('taskpolicy -c utility')
    expect(ruleHow('不要蓝')).toBeUndefined()
  })

  it('附规矩:贴在末尾;已经附过的不再附', () => {
    const block = dispatchRulesBlock(SEED, '做个页面')?.text
    const once = withDispatchRules('做个页面', block)
    expect(once.startsWith('做个页面\n\n【他的规矩')).toBe(true)
    expect(withDispatchRules(once, block)).toBe(once)
    expect(withDispatchRules('做个页面', undefined)).toBe('做个页面')
  })
})

describe('按规矩自查', () => {
  const blueHtml = { path: 'index.html', text: '<html>\n<style>\n  button { background: #1677ff; color: #fff }\n</style>\n</html>' }
  const greyHtml = { path: 'index.html', text: '<html>\n<style>\n  button { background: #f5f5f5; color: #111 }\n</style>\n</html>' }

  it('带蓝的结果不过:原因说清在哪一行,打回原话点名那家', () => {
    const result = reviewAgainstRules(SEED, { files: [blueHtml], taskText: '做一个登录按钮', family: 'Codex', at: '2026-09-24T13:00:00Z' })
    expect(result.pass).toBe(false)
    expect(result.violations[0]?.rule).toBe('不要蓝')
    expect(result.violations[0]?.why).toContain('index.html 第 3 行 #1677ff 是蓝色')
    expect(result.reject_text).toContain('Codex,这一版按他的规矩不能交')
    expect(result.by_eye).toContain('粒子球是主角')
  })

  it('不带蓝的过;没有打回原话', () => {
    const result = reviewAgainstRules(SEED, { files: [greyHtml], taskText: '做一个登录按钮', at: '2026-09-24T13:00:00Z' })
    expect(result.pass).toBe(true)
    expect(result.reject_text).toBeUndefined()
  })

  it('找蓝:rgb / hsl / Tailwind / 颜色名都认;灰、青、紫不算', () => {
    expect(findBlue([{ path: 'a.css', text: 'a { color: rgb(22, 119, 255) }' }])).toHaveLength(1)
    expect(findBlue([{ path: 'a.css', text: 'a { color: hsl(215, 90%, 50%) }' }])).toHaveLength(1)
    expect(findBlue([{ path: 'a.tsx', text: '<div className="bg-blue-500" />' }])).toHaveLength(1)
    expect(findBlue([{ path: 'a.css', text: 'a { border-color: dodgerblue }' }])).toHaveLength(1)
    expect(findBlue([{ path: 'a.css', text: 'a { color: #888; background: #0ff; fill: #a0f }' }])).toHaveLength(0)
    expect(findBlue([{ path: 'a.md', text: 'the blue sky' }])).toHaveLength(0)
  })

  it('「要蓝」的规矩不查蓝;念出来的话超两句、露路径才算', () => {
    expect(forbidsBlue('按钮用蓝色')).toBe(false)
    expect(forbidsBlue('不要蓝(球的「完成」色也不要)')).toBe(true)
    expect(limitsSentences('电话每轮不超过两句,不念总结')).toBe(true)
    const spoken = reviewAgainstRules(SEED, {
      text: '好的。我看了一下。**首页**有三处问题。路径在 /Users/example/x.md。', spoken: true, at: '2026-09-24T13:00:00Z',
    })
    expect(spoken.pass).toBe(false)
    expect(spoken.violations.map(one => one.why).join(';')).toContain('这一轮说了 4 句')
    expect(spoken.violations.map(one => one.why).join(';')).toContain('有 `**` 符号')
  })
})

describe('送给别家的字不带 markdown 记号,回答里抄着我们的指令算不合格(2026-09-25,fix/reply-anchor)', () => {
  it('★「`**` 这类符号」说成「星号这类符号」,行内代码去掉反引号;规矩表里他的原话不动', () => {
    expect(plainForAgent('不露内部的东西(`**` 这类符号、事项的出处说明、文件路径、英文键名)')).toBe('不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)')
    expect(plainForAgent('一律前缀 `taskpolicy -c utility`(别用 nice)')).toBe('一律前缀 taskpolicy -c utility(别用 nice)')
    expect(plainForAgent('回答里别带 ** 加粗')).toBe('回答里别带 星号 加粗')
    const block = dispatchRulesBlock(SEED, '做一个登录页') as { text: string }
    expect(block.text).not.toContain('`')
    expect(block.text).not.toContain('*')
    expect(block.text).toContain('星号这类符号')
    expect(block.text).toContain('一律前缀 taskpolicy -c utility(别用 nice)')
    expect(SEED.find(one => one.text.startsWith('不露内部的东西'))?.text).toContain('`**`')
    // AGENTS.md 那一段是给事务官看的 markdown,照旧。
    expect(agentsRulesBlock(SEED)).toContain('`taskpolicy -c utility`')
  })

  it('★交回来的话里抄着我们附的规矩 → 不合格,打回原话说清是哪一句、不带 markdown 记号', () => {
    const instruction = (dispatchRulesBlock(SEED, '[派活测试] 一天有几个小时?') as { text: string }).text
    const echoed = reviewAgainstRules(SEED, {
      text: '好的,会遵守:不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)。一天有24个小时。',
      taskText: '[派活测试] 一天有几个小时?', family: 'Codex', instruction, at: '2026-09-25T03:00:00Z',
    })
    expect(echoed.pass).toBe(false)
    expect(echoed.violations[0]?.rule).toBe(ECHO_RULE_TITLE)
    expect(echoed.violations[0]?.why).toContain('不露内部的东西(星号这类符号')
    expect(echoed.reject_text).toContain('Codex,这一版按他的规矩不能交')
    expect(echoed.reject_text).toContain('回答里夹着我们自己的指令')
    expect(echoed.reject_text).not.toContain('`')
    expect(echoed.reject_text).not.toContain('*')
    // 干净的回答过;没给 instruction 就不查这一条(电话、他自己问「我的规矩有哪些」时念规矩天经地义)。
    expect(reviewAgainstRules(SEED, { text: '一天有24个小时。', taskText: '一天有几个小时?', instruction, at: '2026-09-25T03:00:00Z' }).pass).toBe(true)
    expect(reviewAgainstRules(SEED, {
      text: '不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)', taskText: '我的规矩有哪些', at: '2026-09-25T03:00:00Z',
    }).pass).toBe(true)
  })

  it('打回原话里违规原因带的 `**` 也说成星号', () => {
    const text = rejectText('Kimi', [{ rule_id: 'x', rule: '不露内部的东西', why: '有 `**` 符号' }])
    expect(text).toBe('Kimi,这一版按他的规矩不能交,先改这几处再交回来(别的不用动):\n1. 不露内部的东西 —— 有 星号符号')
  })
})

describe('重复出现 → 试用 → 保留 / 撤', () => {
  const revise = (where: string, text: string, at: string): RuleEvent => ({ at, kind: 'revise', where, area: 'ui', text, channel: 'review' })

  it('一件活上打回两次同一处不算;两件不同的活上都打回过 → 一条试用', () => {
    const same = [revise('t-1', '按钮颜色太跳了,换成灰色', '2026-09-20T10:00:00Z'), revise('t-1', '按钮颜色还是太跳,换灰色', '2026-09-20T11:00:00Z')]
    expect(inferRules(same, [], NOW)).toEqual([])
    const two = [revise('t-1', '按钮颜色太跳了,换成灰色', '2026-09-20T10:00:00Z'), revise('t-2', '按钮颜色太跳,换灰色', '2026-09-22T10:00:00Z')]
    const found = inferRules(two, [], NOW)
    expect(found).toHaveLength(1)
    expect(found[0]?.status).toBe('trial')
    expect(found[0]?.origin).toBe('repeated')
  })

  it('已经明说过的同一处不再记成试用', () => {
    const two = [revise('t-1', '不要用蓝色', '2026-09-20T10:00:00Z'), revise('t-2', '不要用蓝色的按钮', '2026-09-22T10:00:00Z')]
    expect(inferRules(two, [rule('不要用蓝色')], NOW)).toEqual([])
  })

  it('下一件他通过 → 保留;又打回同一处 → 撤', () => {
    const trial = rule('按钮颜色太跳,换灰色', { status: 'trial', adopted_at: '2026-09-23T00:00:00.000Z' })
    const run: RuleEvent = { at: '2026-09-23T10:00:00Z', kind: 'run', where: 't-3', area: 'ui', channel: 'butler' }
    expect(verifyRule(trial, [run, { at: '2026-09-23T11:00:00Z', kind: 'pass', where: 't-3', area: 'ui', channel: 'review' }]).status).toBe('kept')
    expect(verifyRule(trial, [run, revise('t-3', '按钮颜色还是太跳', '2026-09-23T11:00:00Z')]).status).toBe('reverted')
    expect(verifyRule(trial, []).status).toBe('trial')
  })
})

describe('服务', () => {
  function service() {
    const home = mkdtempSync(join(tmpdir(), 'wb-rules-'))
    dirs.push(home)
    const agents: { body: string | undefined, reverted: number } = { body: undefined, reverted: 0 }
    let clock = NOW
    const svc = createRulesService({
      file: join(home, 'rules.json'),
      now: () => clock,
      agents: {
        apply: async (body) => { const changed = agents.body !== body; agents.body = body; return { ok: true, changed } },
        revert: async () => { agents.reverted += 1; agents.body = undefined; return { ok: true } },
      },
    })
    return { svc, agents, file: join(home, 'rules.json'), tick: (ms: number) => { clock += ms } }
  }

  it('导入「观察」→ 13 条生效、AGENTS.md 段写上;再导一次一条不多', async () => {
    const { svc, agents } = service()
    await svc.load()
    const first = await svc.importObservations(OBSERVATIONS)
    expect(first.added).toBe(13)
    expect(svc.view().rules).toHaveLength(13)
    expect(agents.body).toContain('不要蓝')
    const again = await svc.importObservations(OBSERVATIONS)
    expect(again.added).toBe(0)
    expect(svc.view().rules).toHaveLength(13)
  })

  it('加一条:当场生效、落盘、重读还在;同一句再来一次只多一条依据', async () => {
    const { svc, file, tick } = service()
    await svc.load()
    const added = await svc.add({ text: '以后派活先截图给我看', channel: 'phone', said: '以后派活先截图给我看' })
    expect(added.ok && added.added).toBe(true)
    tick(1000)
    const again = await svc.add({ text: '以后派活先截图给我看', channel: 'call' })
    expect(again.ok && !again.added).toBe(true)
    expect(svc.view().rules[0]?.evidence.map(one => one.channel)).toEqual(['phone', 'call'])
    const reread = createRulesService({ file })
    await reread.load()
    expect(reread.view().rules.map(one => one.text)).toEqual(['以后派活先截图给我看'])
  })

  it('系统写的字不收', async () => {
    const { svc } = service()
    await svc.load()
    const done = await svc.add({ text: '时长:4 秒。', channel: 'desk' })
    expect(done.ok).toBe(false)
    expect(svc.view().rules).toHaveLength(0)
  })

  it('改字、删、恢复;删光了 AGENTS.md 那一段摘掉;删过的他又明说一遍 → 重新生效', async () => {
    const { svc, agents } = service()
    await svc.load()
    const added = await svc.add({ text: '不要蓝', channel: 'settings' })
    if (!added.ok) throw new Error(added.error)
    const edited = await svc.update(added.rule.id, { text: '不要蓝,球的完成色也不要', area: 'ui' })
    expect(edited.ok && edited.rule.text).toBe('不要蓝,球的完成色也不要')
    expect(agents.body).toContain('不要蓝,球的完成色也不要')
    const removed = await svc.remove(added.rule.id)
    expect(removed.ok).toBe(true)
    expect(svc.view().rules).toHaveLength(0)
    expect(svc.view().retired).toHaveLength(1)
    expect(agents.reverted).toBe(1)
    const said = await svc.add({ text: '不要蓝,球的完成色也不要', channel: 'call' })
    expect(said.ok && said.rule.status).toBe('active')
    expect(svc.view().rules).toHaveLength(1)
    const bad = await svc.update(added.rule.id, { area: 'nope' })
    expect(bad.ok).toBe(false)
  })

  it('打回原因进反馈:两件不同的活上都打回同一处 → 试用;下一件派出去、他通过 → 留下', async () => {
    const { svc, tick } = service()
    await svc.load()
    await svc.feedback({ kind: 'revise', where: 't-1', area: 'ui', text: '按钮颜色太跳了,换成灰色', channel: 'review', at: '2026-09-20T10:00:00.000Z' })
    const second = await svc.feedback({ kind: 'revise', where: 't-2', area: 'ui', text: '按钮颜色太跳,换灰色', channel: 'review', at: '2026-09-22T10:00:00.000Z' })
    expect(second.adopted).toBe(1)
    expect(svc.view().rules[0]?.status).toBe('trial')
    tick(60_000)
    await svc.feedback({ kind: 'run', where: 't-3', area: 'ui', channel: 'butler', at: new Date(NOW + 61_000).toISOString() })
    const passed = await svc.feedback({ kind: 'pass', where: 't-3', area: 'ui', channel: 'review', at: new Date(NOW + 62_000).toISOString() })
    expect(passed.kept).toBe(1)
    expect(svc.view().rules[0]?.status).toBe('kept')
    // 打回不带原话不收。
    const empty = await svc.feedback({ kind: 'revise', where: 't-4', area: 'ui', channel: 'review' })
    expect(empty.note).toContain('没记')
  })

  it('自查没过 → heldBack 回一句;重新派了 → 清掉', async () => {
    const { svc } = service()
    await svc.load()
    await svc.importObservations(OBSERVATIONS)
    const review = await svc.review({
      itemId: 't-9', family: 'Codex', taskText: '做一个登录按钮',
      files: [{ path: 'index.html', text: 'button { background: #1677ff }' }],
    })
    expect(review.pass).toBe(false)
    expect(svc.heldBack('t-9')).toContain('已打回给 Codex 改')
    await svc.clearReview('t-9')
    expect(svc.heldBack('t-9')).toBeUndefined()
    const ok = await svc.review({ itemId: 't-9', taskText: '做一个登录按钮', files: [{ path: 'index.html', text: 'button { background: #eee }' }] })
    expect(ok.pass).toBe(true)
    expect(svc.heldBack('t-9')).toBeUndefined()
  })

  it('坏文件 = 一条都没有,不抛', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-rules-bad-'))
    dirs.push(home)
    const file = join(home, 'rules.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ not json')
    const svc = createRulesService({ file })
    await svc.load()
    expect(svc.view().rules).toEqual([])
    await svc.add({ text: '不要蓝', channel: 'settings' })
    expect(JSON.parse(readFileSync(file, 'utf8')).rules).toHaveLength(1)
  })

  it('选题卡偏好那几条投影进表(只读,不能改字)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-rules-topic-'))
    dirs.push(home)
    const svc = createRulesService({
      file: join(home, 'rules.json'),
      topicPreferences: () => [{ id: 'pref:开头别太长', text: '开头别太长', status: 'trial', adopted_at: '2026-09-23T00:00:00.000Z' }],
    })
    await svc.load()
    const view = svc.view()
    expect(view.rules[0]).toMatchObject({ id: 'pref:开头别太长', area: 'content', origin: 'topic', editable: false })
    expect(svc.brief('dispatch', '写一条小红书文案').text).toContain('开头别太长')
    const edit = await svc.update('pref:开头别太长', { text: 'x' })
    expect(edit.ok).toBe(false)
  })
})

/**
 * 「先问我」下纯问答不列确认点(2026-09-25,卡 fix/evening-gaps 第 5 条)。统筹在真壳里用「先问我」问
 * 「我的规矩有哪些」,她答对了却又列了三条确认点。确认点只在要派活 / 动他的文件时才走 —— 规矩段、
 * 输入框「先问我」那一句、技能《需求确认点》三处同一个口径。
 */
describe('★ 纯问答直接答,不列确认点', () => {
  it('AGENTS.md 规矩段:他问「我的规矩有哪些」→ 照这里直接答,不列确认点', () => {
    const block = agentsRulesBlock(SEED) as string
    expect(block).toContain('他问「我的规矩有哪些」,照这里直接答')
    expect(block).toContain('也不列确认点(确认点只在要派活、动他的文件时才问)')
  })

  it('输入框「先问我」那一句:派活 / 动文件才问确认点,只是问一件事就直接答', async () => {
    const { MODE_LINES } = await import('../src/server/composer.ts')
    expect(MODE_LINES.ask).toContain('要派给别家、或者要动他的文件')
    expect(MODE_LINES.ask).toContain('他只是问一件事(问规矩、问进度、问在哪),就直接答')
    /*
     * ★ 2026-10-02(卡「电话里像个活人」):这一句删掉了「先把你的理解复述成 2–4 个确认点」。
     * 规矩还是那条(拿不准才问),话术没了 —— 每件事项的第一条消息里都带着那句模板,
     * 于是「查个天气」也被复述一遍再问三条。
     */
    expect(MODE_LINES.ask).toContain('拿不准的时候')
    expect(MODE_LINES.ask).toContain('一次只问最要紧的那一件')
    expect(MODE_LINES.ask).not.toContain('2–4 个确认点')
    expect(MODE_LINES.ask).not.toContain('复述成')
  })

  it('技能《需求确认点》(随版本打进插件的那一份):纯问答哪个模式都直接答,包括「先问我」', async () => {
    const { BUNDLED_SKILL_DOCS } = await import('../src/server/bundledSkills.generated.ts')
    const doc = BUNDLED_SKILL_DOCS['需求确认点.md'] ?? ''
    expect(doc).toContain('纯问答直接答,不列确认点 —— 哪个模式都一样,包括「先问我」')
    expect(doc).toContain('有没有东西会被派出去、会被改')
  })
})
