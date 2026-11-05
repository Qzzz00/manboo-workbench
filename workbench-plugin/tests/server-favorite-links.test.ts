// @vitest-environment node
/**
 * 「收藏网址」的读写(2026-09-21,素材管理第八格)。
 *
 * 这一份钉的是**不许替他整理**:只追加、不重排、不去重整份文件、不改他手写的行;
 * 以及**认不出来的行不丢**(解析失败不等于可以抹掉他写的东西)。
 */
import { describe, expect, it } from 'vitest'
import {
  OPS_FAVORITES_REL, appendFavoriteLink, favoriteLinksOf, favoritesFilePath, favoritesSeedText,
  findFavoriteLink, formatFavoriteLink, normalizeFavoriteUrl, parseFavoriteLinks,
} from '../src/server/favoriteLinks.ts'

describe('路径', () => {
  it('在工作目录下的 素材/收藏网址.md', () => {
    expect(OPS_FAVORITES_REL).toBe('素材/收藏网址.md')
    expect(favoritesFilePath('/Users/x/工作台')).toBe('/Users/x/工作台/素材/收藏网址.md')
  })

  it('工作目录没配 → 没有路径(**不猜一个**)', () => {
    expect(favoritesFilePath(undefined)).toBeUndefined()
    expect(favoritesFilePath('')).toBeUndefined()
  })
})

describe('解析', () => {
  it('标题 + 链接 + 备注', () => {
    const [line] = parseFavoriteLinks('- [创作者中心](https://creator.xiaohongshu.com/) —— 后台数据在这儿')
    expect(line?.link).toEqual({
      title: '创作者中心',
      url: 'https://creator.xiaohongshu.com/',
      note: '后台数据在这儿',
    })
  })

  it('没有备注也认;破折号写成 — 或 -- 也认', () => {
    expect(parseFavoriteLinks('- [A](https://a.com)')[0]?.link?.note).toBeUndefined()
    expect(parseFavoriteLinks('- [A](https://a.com) — 备注')[0]?.link?.note).toBe('备注')
    expect(parseFavoriteLinks('- [A](https://a.com) -- 备注')[0]?.link?.note).toBe('备注')
  })

  it('他手写的裸链接:标题就是链接本身(**不去打开它取网页标题**)', () => {
    const [line] = parseFavoriteLinks('- https://example.com/x 随手存的')
    expect(line?.link?.url).toBe('https://example.com/x')
    expect(line?.link?.title).toBe('https://example.com/x')
    expect(line?.link?.note).toBe('随手存的')
  })

  it('认不出来的行**原样留着**,只是不算一条', () => {
    const lines = parseFavoriteLinks('# 收藏网址\n\n> 说明\n- [坏]的一行(\n')
    expect(lines.every(line => line.raw !== '')).toBe(true)
    expect(lines.filter(line => line.link !== undefined)).toHaveLength(0)
    expect(lines.map(line => line.raw)).toContain('# 收藏网址')
  })

  it('空行不进结果', () => {
    expect(parseFavoriteLinks('\n\n')).toEqual([])
  })
})

describe('写成一行', () => {
  it('备注空着就不挂一个光秃秃的破折号', () => {
    expect(formatFavoriteLink({ title: 'A', url: 'https://a.com' })).toBe('- [A](https://a.com)')
    expect(formatFavoriteLink({ title: 'A', url: 'https://a.com', note: 'n' })).toBe('- [A](https://a.com) —— n')
  })

  it('标题空着就用链接顶上(**不编一个标题**)', () => {
    expect(formatFavoriteLink({ title: '  ', url: 'https://a.com' })).toBe('- [https://a.com](https://a.com)')
  })

  it('写出来的一行能被自己读回去', () => {
    const link = { title: '可灵 AI', url: 'https://app.klingai.com/cn/', note: '生成视频' }
    expect(favoriteLinksOf(formatFavoriteLink(link))[0]).toEqual(link)
  })
})

describe('查重', () => {
  it('末尾斜杠、协议与域名大小写不算两条', () => {
    expect(normalizeFavoriteUrl('HTTPS://A.com/x/')).toBe('https://a.com/x')
    expect(normalizeFavoriteUrl('https://a.com/x')).toBe('https://a.com/x')
  })

  it('查询串一个字不动:?id=1 与 ?id=2 是两条', () => {
    expect(normalizeFavoriteUrl('https://a.com?id=1')).not.toBe(normalizeFavoriteUrl('https://a.com?id=2'))
  })

  it('已经有了就找得出来(技能要念出已有那一条的标题)', () => {
    const text = '- [旧标题](https://a.com/x)'
    expect(findFavoriteLink(text, 'https://A.com/x/')?.title).toBe('旧标题')
    expect(findFavoriteLink(text, 'https://b.com')).toBeUndefined()
  })
})

describe('追加', () => {
  it('文件不存在 / 空文件 → 先垫一份头再追加', () => {
    for (const before of [undefined, '', '  \n']) {
      const result = appendFavoriteLink(before, { title: 'A', url: 'https://a.com' })
      expect(result.added).toBe(true)
      expect(result.text).toContain('# 收藏网址')
      expect(result.text.trimEnd().endsWith('- [A](https://a.com)')).toBe(true)
    }
  })

  it('只追加:他手写的行、顺序、别的内容一个字不动', () => {
    const before = `${favoritesSeedText()}- [他手写的](https://b.com) —— 别动我\n随便写的一行\n`
    const result = appendFavoriteLink(before, { title: 'A', url: 'https://a.com' })
    expect(result.text.startsWith(before)).toBe(true)
    expect(result.text).toContain('随便写的一行')
  })

  it('同一个链接不重复写,回已有那一条', () => {
    const before = '- [旧标题](https://a.com/x) —— 旧备注\n'
    const result = appendFavoriteLink(before, { title: '新标题', url: 'https://a.com/x/' })
    expect(result.added).toBe(false)
    expect(result.existing?.title).toBe('旧标题')
    expect(result.text).toBe(before)
  })

  it('原文没有末尾换行时也不会把两行粘一起', () => {
    const result = appendFavoriteLink('- [A](https://a.com)', { title: 'B', url: 'https://b.com' })
    expect(result.text).toContain('- [A](https://a.com)\n- [B](https://b.com)')
  })
})

describe('新文件的头', () => {
  it('头两行就把格式写给他看(他要能手写一行)', () => {
    const seed = favoritesSeedText()
    expect(seed).toContain('# 收藏网址')
    expect(seed).toContain('- [标题](链接) —— 备注')
    expect(favoriteLinksOf(seed)).toEqual([])
  })
})
