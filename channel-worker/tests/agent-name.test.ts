/**
 * 「他嘴里那一家」的读音近似解析(2026-09-27,卡 MS)。
 *
 * 现场:维护者说「给 minus 发个信息问他国庆节中国法定节日是放几天」,ASR 听成 `minus`,
 * 他说的是本机装着的 Manus。那一通里事务官问「没认出『minus』是哪条会话」,他:「哪有那么复杂?」
 */
import { describe, expect, it } from 'vitest'
import { FALLBACK_FAMILIES, canonicalWho, consonantKey, matchSpokenFamily, spokenWords } from '../src/agentName.ts'

describe('读音近似:唯一高置信直接当那一家,不问', () => {
  it('★minus → Manus(现场那一句)', () => {
    const match = matchSpokenFamily('给 minus 发个信息问他国庆节中国法定节日是放几天')
    expect(match).toMatchObject({ kind: 'one', id: 'manus', title: 'Manus' })
  })

  it('★mu si → Muse(ASR 把一个名字断成两截)', () => {
    expect(matchSpokenFamily('让 mu si 查一下')).toMatchObject({ kind: 'one', id: 'muse' })
  })

  it('★豆包 / 豆包办公 / 豆包工作 → 同一家', () => {
    for (const said of ['找豆包总结一下', '让豆包办公润色', '叫豆包工作写个提纲']) {
      expect(matchSpokenFamily(said), said).toMatchObject({ kind: 'one', id: 'doubao' })
    }
  })

  it('名字一字不差、中文译名、家名 id 都认', () => {
    expect(matchSpokenFamily('让 Codex 把它做了')).toMatchObject({ kind: 'one', id: 'codex' })
    expect(matchSpokenFamily('叫克劳德看看')).toMatchObject({ kind: 'one', id: 'claude' })
    expect(matchSpokenFamily('让 kimi 写个 Z')).toMatchObject({ kind: 'one', id: 'kimi' })
  })

  it('★两家都像才问一句,不猜', () => {
    // 登记表里两家的名字读音一样近(他机器上真装了两家听着像的)。
    const match = matchSpokenFamily('给 minus 发条信息', [
      { id: 'manus', title: 'Manus' },
      { id: 'menus', title: 'Menus' },
    ])
    expect(match.kind).toBe('many')
    if (match.kind === 'many') expect(match.line).toBe('是Manus还是Menus?')
  })

  it('一家都不像就说不像(不挑最像的那一家顶上)', () => {
    expect(matchSpokenFamily('给张三发个信息').kind).toBe('none')
    expect(matchSpokenFamily('').kind).toBe('none')
    expect(matchSpokenFamily('随便说点什么', []).kind).toBe('none')
  })

  it('辅音骨架:听错的几种写法都归到同一个骨架', () => {
    expect(consonantKey('minus')).toBe(consonantKey('manus'))
    expect(consonantKey('musi')).toBe(consonantKey('muse'))
    expect(consonantKey('claude')).not.toBe(consonantKey('codex'))
  })

  it('断成两截的词也当一个词看', () => {
    expect(spokenWords('mu si').map(one => one.word)).toContain('musi')
    // 中间隔了别的字就不算同一个名字
    expect(spokenWords('mu,发给 si').map(one => one.word)).not.toContain('musi')
  })
})

describe('送给工作台之前把听错的名字换成正名', () => {
  it('★minus → Manus,他那句话别的字一个不动', () => {
    expect(canonicalWho('给 minus 发个信息')).toBe('给 Manus 发个信息')
  })

  it('已经是正名的原样返回;认不准的原样返回(不替他改写)', () => {
    expect(canonicalWho('给 Manus 发个信息')).toBe('给 Manus 发个信息')
    expect(canonicalWho('给张三那条发个信息')).toBe('给张三那条发个信息')
  })

  it('登记表传进来就只认登记表里那几家(本机没装的不认)', () => {
    const onlyKimi = FALLBACK_FAMILIES.filter(one => one.id === 'kimi')
    expect(matchSpokenFamily('给 minus 发个信息', onlyKimi).kind).toBe('none')
  })
})

/**
 * ★ **两端认出来必是同一家**(2026-09-28,卡 FX)。
 *
 * 插件那头也有一份读音近似(`workbench-plugin/src/server/spokenFamily.ts`:先认家、
 * 再只在这家的会话里认对话)。顶层子目录互不 import,判据只能是**两份实现** ——
 * 所以这一组输入与 `workbench-plugin/tests/lookup-family-first.test.ts` 里那一组
 * **逐字相同**:两边答出不同的家,这两个用例就一起红。改判据要两边一起改。
 */
describe('★ 两端同一组用例', () => {
  const cases: readonly [string, string | undefined][] = [
    ['Codex', 'codex'],
    ['Kimi', 'kimi'],
    ['minus', 'manus'],
    ['Manus 现在在干什么', 'manus'],
    ['豆包现在什么状态', 'doubao'],
    ['豆包办公', 'doubao'],
    ['克劳德在跑什么', 'claude'],
    ['那个什么东西', undefined],
  ]
  for (const [said, id] of cases) {
    it(`「${said}」→ ${id ?? '认不出'}`, () => {
      const match = matchSpokenFamily(said)
      expect(match.kind === 'one' ? match.id : undefined).toBe(id)
    })
  }
})
