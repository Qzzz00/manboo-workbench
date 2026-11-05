// @vitest-environment node
/**
 * 「电话里派活犯傻」那一卡的电脑那半边(2026-09-27,卡 MS)。四件:
 *
 * 1. **人设里要有捎话那件工具**(它 09-26 就在工人手里,单子上一直没写它 —— 于是
 *    「给 minus 发个信息」只能去调「交给事务官办」:建卡、开会话、grep 名字、列四条确认点,一个字没发出去);
 * 2. **话术**:不许甩锅(21:17 她说的是「要是到时候打不通,我可不管」);
 * 3. **附规矩只附与这件活相关的**(21:23 发给豆包的正文里附了一整段派活分工与构建规矩);
 * 4. **没配的接口兜底不去试**(服务器没配豆包那把 Key),失败原因要说人话。
 */
import { describe, expect, it } from 'vitest'
import { CHANNEL_TOOL_RELAY, buildChannelSystemMessage } from '../src/server/channel.ts'
import { classifyFailure, humanizeFailure } from '../src/server/dispatchClient.ts'
import { handsOf, targetFromEntry } from '../src/server/dispatchTargets.ts'
import { buildConfirmPoints, formatConfirmBlock } from '../src/server/confirmPoints.ts'
import { dispatchRulesBlock } from '../src/server/rules.ts'
import type { StoredRule } from '../src/server/rules.ts'
import type { AgentEntryView } from '../src/protocol.ts'

function persona(): string {
  return buildChannelSystemMessage({ rememberTool: 'wb_remember_item', doingTool: 'wb_list_doing', handTool: 'wb_hand_to_butler' })
}

describe('人设:捎话那件工具要在单子上', () => {
  it('★单子上写着捎话那件工具,而且明说这一档不建事项、不列确认点', () => {
    const text = persona()
    expect(text).toContain(CHANNEL_TOOL_RELAY)
    expect(text).toContain('不建事项')
    expect(text).toContain('不列确认点')
  })

  it('★话术:不许甩锅,办不成要说卡在哪一步并回电', () => {
    const text = persona()
    expect(text).toContain('不许甩锅')
    expect(text).toContain('卡在哪一步')
    // 2026-10-02:称谓不写死「他」(这份夹具没有称呼表 → 中性的「对方」)。
    expect(text).toContain('打电话告诉对方')
    // 21:17 她说的那句话被**逐字列成禁例**(而不是当一种说法留在单子上)
    expect(text).toContain('这类话一句都不许说')
    expect(text).toContain('到时候打不通我可不管')
  })
})

describe('接口那只手:中转没配这一家就不给它', () => {
  const entry = (): AgentEntryView => ({
    id: 'doubao', name: '豆包办公', bundle_id: 'com.bot.pc.doubao', state: 'connected',
  } as unknown as AgentEntryView)

  it('★确凿没配 → 手里只剩窗口那一只(不去试、失败原因里也就不会有它)', () => {
    const target = targetFromEntry(entry(), {})
    expect(target?.hands).toEqual(['window'])
  })

  it('配了就照旧有接口那只手当兜底', () => {
    const target = targetFromEntry(entry(), { doubao: true })
    expect(target?.hands).toEqual(['window', 'api'])
  })

  it('没问到过(缺席)不猜:照老样子留着那只手', () => {
    expect(targetFromEntry(entry())?.hands).toEqual(['window', 'api'])
    expect(handsOf({ id: 'doubao', hasApp: true })).toEqual(['window', 'api'])
  })
})

describe('失败原因说人话、给下一步', () => {
  const raw = '没送:com.bot.pc.doubao 的输入框里有你没发出去的字,覆盖掉就找不回来了(要覆盖得明着说 overwrite)'

  it('★不再念包标识与 overwrite,改成一句人话 + 下一步', () => {
    const said = humanizeFailure(raw, 'doubao')
    expect(said).toContain('豆包办公')
    expect(said).not.toContain('com.bot.pc.doubao')
    expect(said).not.toContain('overwrite')
    // 2026-09-27(卡 DB)口径变了:「先存下来再发」现在是自动的(壳读回原文 + 工作台落盘 + 送完放回),
    // 走到这一句只剩「那段字**存不下来**」这一种 —— 所以说的是「没能存下来,不敢覆盖」+ 下一步。
    expect(said).toContain('没能把它存下来')
    expect(said).toContain('你把那句发掉或清掉,我马上重派')
  })

  it('归成自己的一类(界面与收件箱据此说下一句)', () => {
    expect(classifyFailure(raw)).toBe('draft_in_the_way')
    expect(classifyFailure(humanizeFailure(raw, 'doubao'))).toBe('draft_in_the_way')
  })

  it('别的原话原样带走(归不出类就不改写)', () => {
    expect(humanizeFailure('找不到窗口', 'doubao')).toBe('找不到窗口')
  })
})

describe('确认点:派给别家时别念「事务官自己办」', () => {
  it('★点了名 → 「这件事派给谁」那一条说那一家的名字', () => {
    const points = buildConfirmPoints({ need: '把这几天我跟你聊的内容总结一下', who: '豆包办公' })
    const block = formatConfirmBlock({ understanding: '让豆包总结这几天聊的内容', points })
    // 2026-10-02:第一人称(只有一个「我」)。
    expect(block).toContain('这件事派给谁(我先按「派给 豆包办公 做,我只跟进、回了告诉你」理解)')
    expect(block).not.toContain('事务官自己办,动的是工作台这一处')
    expect(block).not.toContain('事务官只跟进')
  })

  /*
   * ★ 2026-10-02(卡「电话里像个活人」第 7 条,也是 09-28「事务官自己不干活」那条拍板):
   * 没点名时的默认理解从「事务官自己办」改成「按各家的能力挑一家派出去」。
   * Air 那一通里念给她的正是「谁来执行,我按事务官自己办」—— 和那条拍板相反。
   */
  it('★没点名:默认也是派出去,不是自己办', () => {
    const points = buildConfirmPoints({ need: '随便一句谁也归不了类的话' })
    expect(points[0]?.guess).toBe('按各家的能力挑一家派出去,动的是工作台这一处,不牵别的')
    expect(points[0]?.guess).not.toContain('事务官自己办')
  })
})

describe('附规矩只附与这件活相关的', () => {
  const rules = (): StoredRule[] => ([
    { id: 'r1', text: '派活默认分工:写代码给 Claude / Codex,文案给 Kimi', area: 'all', status: 'active', at: '2026-09-25T00:00:00.000Z' },
    { id: 'r2', text: '界面上不要蓝色', area: 'ui', status: 'active', at: '2026-09-25T00:00:00.000Z' },
  ] as unknown as StoredRule[])

  it('★聊天 / 问答的活:全局那一批一条不附', () => {
    const block = dispatchRulesBlock(rules(), '把这几天我跟你聊的内容总结一下', { kind: 'chat' })
    expect(block?.text ?? '').not.toContain('派活默认分工')
  })

  it('★沾到界面的那件活照旧带界面那几条', () => {
    const block = dispatchRulesBlock(rules(), '做一个登录按钮的小网页', { kind: 'chat' })
    expect(block?.text).toContain('界面上不要蓝色')
    expect(block?.text ?? '').not.toContain('派活默认分工')
  })

  it('写代码那一类一个字没改(全局那批正是给它的)', () => {
    const block = dispatchRulesBlock(rules(), '把按钮改一下', { kind: 'code' })
    expect(block?.text).toContain('派活默认分工')
  })
})
