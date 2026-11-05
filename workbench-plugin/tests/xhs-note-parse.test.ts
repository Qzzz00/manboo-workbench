// @vitest-environment node
/**
 * 采集类的纯解析层(src/server/xhsNoteText.ts)。
 *
 * 这一份钉的是**红线在解析层的那几条**,外加几件"错了看不出来"的事:
 *
 * | 钉什么 | 为什么要钉 |
 * |---|---|
 * | 只认一条笔记的详情链接 | 搜索页 / 博主主页 / 话题页一旦被认下来,这件事就从"工具"变成"爬虫" |
 * | 子评论一条都不采 | 白板原话;而且这是解析层唯一能把它挡死的地方 |
 * | ≤100 条 + 优先高赞 | 同上 |
 * | 风控 / 验证码 / 未登录先判 | 墙上也可能有半份数据,先判墙才不会拿半份数据当成功 |
 * | 落盘文件里没有一个凭据字样 | 采集产物是要给人看、可能还会转发的 |
 *
 * 夹具在 `tests/xhsNoteFixtures.ts`,**数字与文本全是明显假的**,理由写在那个文件头。
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_WORDS, COMMENT_MAX, countOf, noteDirName, parseNoteLink, parseNotePayload,
  pickStream, pickTopComments, renderCommentsMd, renderNoteMd, safeNoteTitle, tagsOf, wallOf,
} from '../src/server/xhsNoteText.ts'
import {
  FAKE_BLOCKED_PAGE_TEXT, FAKE_CAPTCHA_PAGE_TEXT, FAKE_IMAGE_NOTE_PAYLOAD,
  FAKE_LOGIN_PAGE_TEXT, FAKE_NOTE_ID, FAKE_NOTE_PAYLOAD, FAKE_NOTE_URL,
} from './xhsNoteFixtures.ts'

describe('链接:只从他自己给的那一条笔记进', () => {
  it('认得 /explore/ 与 /discovery/item/ 两种写法,并且原样保留 xsec_token', () => {
    const one = parseNoteLink(FAKE_NOTE_URL)
    expect(one.ok).toBe(true)
    if (!one.ok) return
    expect(one.link.id).toBe(FAKE_NOTE_ID)
    // ★ 少了 xsec_token 多半打不开,所以**原样带着**,不做任何清洗。
    expect(one.link.url).toContain('xsec_token=FAKE_TOKEN_1111')

    const two = parseNoteLink(`https://www.xiaohongshu.com/discovery/item/${FAKE_NOTE_ID}`)
    expect(two.ok).toBe(true)
  })

  it('rednote.com 也认(2026 年换的新域名,同一个站)', () => {
    expect(parseNoteLink(`https://www.rednote.com/explore/${FAKE_NOTE_ID}`).ok).toBe(true)
  })

  /**
   * ★★ 这一条是**整张卡最要紧的一条用例**。
   *
   * 搜索页、博主主页、话题页、发现流 —— 这四种都是"批量遍历"的入口。
   * 一旦其中任何一种被认下来,「只从他自己给的链接进」这句承诺当场作废,
   * 而那句承诺是我们敢把这个功能交给用户的全部理由。
   */
  it.each([
    ['搜索页', 'https://www.xiaohongshu.com/search_result?keyword=%E7%BE%8E%E9%A3%9F'],
    ['博主主页', 'https://www.xiaohongshu.com/user/profile/aaaaaaaa1111bbbb2222cccc'],
    ['话题页', 'https://www.xiaohongshu.com/page/topics/aaaaaaaa1111bbbb2222cccc'],
    ['发现流', 'https://www.xiaohongshu.com/explore'],
    ['别的站', 'https://example.com/explore/aaaaaaaa1111bbbb2222cccc'],
    ['http 不是 https', 'http://www.xiaohongshu.com/explore/aaaaaaaa1111bbbb2222cccc'],
  ])('拒绝 %s', (_name, url) => {
    expect(parseNoteLink(url).ok).toBe(false)
  })

  it('短链拒绝,并且说清楚为什么(我们不替他跳转)', () => {
    const result = parseNoteLink('https://xhslink.com/a/FAKE1111')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('短链')
    expect(result.reason).toContain('地址栏')
  })

  it('空的 / 不是网址 / 不是字符串,一律拒绝而不是抛', () => {
    for (const bad of ['', '   ', 'not a url', undefined, null, 42, {}]) {
      expect(parseNoteLink(bad).ok).toBe(false)
    }
  })
})

describe('墙:先判墙,再判数据', () => {
  it('风控页判 blocked,并把页面上那句原话带出来', () => {
    const wall = wallOf('https://www.xiaohongshu.com/404/sec_FAKE', FAKE_BLOCKED_PAGE_TEXT)
    expect(wall?.state).toBe('blocked')
    expect(wall?.message).toContain('当前笔记暂时无法浏览')
    expect(wall?.message).toContain('不重试')
  })

  it('★ 验证码页判 captcha,并逐字说明「我不替你过验证码」', () => {
    const wall = wallOf('https://www.xiaohongshu.com/explore/x', FAKE_CAPTCHA_PAGE_TEXT)
    expect(wall?.state).toBe('captcha')
    expect(wall?.message).toContain('不替你过验证码')
  })

  it('未登录判 logged_out —— 两条判据(URL 里的 /login,页面上的「扫码登录」)各自都够', () => {
    expect(wallOf('https://www.xiaohongshu.com/login?x=1', '')?.state).toBe('logged_out')
    expect(wallOf('https://www.xiaohongshu.com/explore/x', FAKE_LOGIN_PAGE_TEXT)?.state).toBe('logged_out')
  })

  it('正常页面没有墙', () => {
    expect(wallOf(FAKE_NOTE_URL, '假标题\n假作者\n假评论')).toBeUndefined()
  })

  it('墙的判据里包含预研实测到的那个 300031', () => {
    expect(BLOCKED_WORDS).toContain('300031')
  })

  /**
   * ★ 2026-09-22 真跑抓到的那条风控跳转地址(逐字,只把 uuid 换成了一个假的)。
   *
   * 它要判成 **blocked(这条笔记被挡了)**,**不能**判成 captcha ——
   * 判成 captcha 会让他跑去那个浏览器窗口里找一个根本不存在的滑块。
   * 注意地址里那个**空的** `verifyMsg=`:它正是当时差点把这条判错的东西。
   */
  it('★ 真实的 300031 风控跳转地址判成 blocked,不是 captcha', () => {
    const href = 'https://www.xiaohongshu.com/404?source=/404/sec_FAKE'
      + '?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fexplore%2F6411cf99000000001300b6d9'
      + '&error_code=300031&error_msg=Sorry%2C%20This%20Page%20Isn%27t%20Available%20Right%20Now.'
      + '&uuid=00000000-0000-0000-0000-000000000000&verifyMsg='
    const wall = wallOf(href, '')
    expect(wall?.state).toBe('blocked')
    expect(wall?.message).toContain('300031')
  })
})

describe('笔记:采哪几样', () => {
  it('视频笔记:标题 / 短文案 / 标签 / 作者 / 发布时间 / 视频直链都采到', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    expect(result.state).toBe('ok')
    const note = result.note
    expect(note?.title).toBe('假标题:这是一条编出来的视频笔记')
    expect(note?.author).toBe('假作者')
    expect(note?.kind).toBe('video')
    expect(note?.published_at).toBe('2026-09-21T00:00:00.000Z')
    // 点赞收藏评论**原样那串**,不换算 —— 换算过的数对不上他在页面上看到的。
    expect(note?.likes).toBe('1111')
    expect(note?.collects).toBe('999')
    // 标签两处都取(tagList + 正文里的 #),去重,`[话题]` 后缀摘掉。
    expect(note?.tags).toEqual(['假标签一', '假标签三', '假标签二'])
    // ★ 两档分辨率里挑大的那一档。
    expect(note?.video?.url).toBe('https://fake.example/大-1111.mp4')
  })

  it('图文笔记:采到图片清单,没有 video', () => {
    const result = parseNotePayload(FAKE_IMAGE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    expect(result.note?.kind).toBe('normal')
    expect(result.note?.video).toBeUndefined()
    expect(result.note?.images).toHaveLength(2)
    // `nickName` 与 `nickname` 两种拼法都认(站点两种都出现过)。
    expect(result.note?.author).toBe('假作者')
  })

  it('payload 空 / 不是 JSON / 里面没有这条 —— 三种都如实说,一种都不抛', () => {
    for (const bad of ['', '   ', 'not json', '{}']) {
      const result = parseNotePayload(bad, FAKE_NOTE_ID)
      expect(result.state).toBe('not_found')
      expect(result.note).toBeUndefined()
    }
  })

  it('★ 就算 payload 是好的,页面上有墙也先判墙', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, FAKE_CAPTCHA_PAGE_TEXT)
    expect(result.state).toBe('captcha')
    expect(result.note).toBeUndefined()
  })

  it('pickStream:一档都没有 url 时就是没有视频,不退回一个空串', () => {
    expect(pickStream(undefined)).toBeUndefined()
    expect(pickStream({ media: { stream: { h264: [{ width: 1, height: 1 }] } } })).toBeUndefined()
    // backupUrls 也能用(masterUrl 带签名,backup 不带)。
    expect(pickStream({ media: { stream: { h264: [{ backupUrls: ['https://fake.example/b.mp4'] }] } } })?.url)
      .toBe('https://fake.example/b.mp4')
  })

  it('tagsOf:没有标签就是空数组,不是 [""]', () => {
    expect(tagsOf({})).toEqual([])
    expect(tagsOf({ desc: '没有井号的一段话' })).toEqual([])
  })
})

describe('评论:≤100 条、优先高赞、★ 子评论一条都不采', () => {
  it('按赞数降序,空正文那条被丢掉', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    const comments = result.comments ?? []
    expect(comments.map(one => one.id)).toEqual(['c-1111', 'c-888', 'c-77'])
    expect(comments[0]?.likes_raw).toBe('1111')
  })

  /**
   * ★★ 子评论那一条。夹具里那两条子评论的正文都以「★ 这是子评论」开头,
   * 所以**只要它们中的任何一条漏进来,这条用例当场红**。
   */
  it('子评论一个字都不进结果,只留一个条数', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    const dumped = JSON.stringify(result.comments)
    expect(dumped).not.toContain('这是子评论')
    expect(dumped).not.toContain('c-888-1')
    // 但"底下还有几条"这个数要留着 —— 他得知道自己没看到的有多少。
    expect(result.comments?.find(one => one.id === 'c-888')?.sub_count).toBe('2')
  })

  it('★ 上限 100:给 150 条,只留 100 条,而且留的是赞数最高那 100 条', () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      id: `c-${index}`, content: `假评论 ${index}`, likeCount: String(index),
    }))
    const picked = pickTopComments(many)
    expect(picked).toHaveLength(COMMENT_MAX)
    expect(picked[0]?.id).toBe('c-149')
    // 赞数最低那 50 条一条都不在。
    expect(picked.some(one => one.id === 'c-0')).toBe(false)
  })

  it('赞数一样时保留站点原来的顺序(稳定排序,不另造一套二级排序)', () => {
    const same = [
      { id: 'a', content: '甲', likeCount: '5' },
      { id: 'b', content: '乙', likeCount: '5' },
      { id: 'c', content: '丙', likeCount: '5' },
    ]
    expect(pickTopComments(same).map(one => one.id)).toEqual(['a', 'b', 'c'])
  })

  it('countOf:中文计数读得出来,读不出来回 0(只用于排序)', () => {
    expect(countOf('1.1万')).toBe(11_000)
    expect(countOf('2亿')).toBe(200_000_000)
    expect(countOf('88')).toBe(88)
    expect(countOf('赞')).toBe(0)
    expect(countOf(undefined)).toBe(0)
  })
})

describe('落盘:产物里写的是实话', () => {
  const meta = { at: '2026-09-22T01:00:00.000Z', url: FAKE_NOTE_URL }

  it('笔记.md:取不到的字段写「没采到」,不写 0、不写空', () => {
    const md = renderNoteMd({ id: 'x', tags: [], images: [] }, meta)
    expect(md).toContain('没采到')
    expect(md).not.toMatch(/\*\*作者\*\*:\s*$/m)
    // 采集时间与来源链接都在头上。
    expect(md).toContain(meta.at)
    expect(md).toContain(FAKE_NOTE_URL)
  })

  it('笔记.md:视频直链带一句「有时效」的提醒', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    const md = renderNoteMd(result.note as NonNullable<typeof result.note>, meta)
    expect(md).toContain('https://fake.example/大-1111.mp4')
    expect(md).toContain('有时效')
  })

  it('★ 评论.md 头上逐字写明「只采了 N 条」「子评论一条都没采」', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    const md = renderCommentsMd(result.comments ?? [], meta, result.note?.title, result.comment_total)
    expect(md).toContain('只采了 3 条')
    expect(md).toContain('子评论一条都没采')
    expect(md).toContain('没有点开任何「展开更多」')
    expect(md).toContain('站点上写着一共 888 条')
  })

  it('一条评论都没采到时如实说「两种我分不清」,不写「没有评论」', () => {
    const md = renderCommentsMd([], meta, '假标题')
    expect(md).toContain('分不清')
    expect(md).not.toContain('这条笔记没有评论。')
  })

  /**
   * ★ 凭据一个字不进产物。这两份 markdown 是要给人看、很可能还会被转发的,
   * 所以"里面能有什么"必须一眼说得清(同数据复盘那张卡对 `xhs-metrics.json` 的做法)。
   */
  it('两份产物里不出现任何凭据字样', () => {
    const result = parseNotePayload(FAKE_NOTE_PAYLOAD, FAKE_NOTE_ID, FAKE_NOTE_URL, '')
    const both = renderNoteMd(result.note as NonNullable<typeof result.note>, meta)
      + renderCommentsMd(result.comments ?? [], meta, result.note?.title)
    for (const word of ['cookie', 'Cookie', 'token', 'Token', 'authorization', 'web_session', 'localStorage']) {
      // `xsec_token` 在来源链接里 —— 它是他自己地址栏里那一条,不是我们取回来的凭据。
      expect(both.replace(/xsec_token=[^\s)]*/g, '')).not.toContain(word)
    }
  })

  it('目录名:路径分隔符与控制字符挡掉,标题读不出来时叫「无标题笔记」', () => {
    expect(noteDirName('2026-09-22', '假标题')).toBe('2026-09-22-假标题')
    expect(safeNoteTitle('a/b\\c:d')).toBe('a_b_c_d')
    // 全角冒号也挡:Finder 把文件名里的全角冒号显示成 `/`,看起来就像多了一层目录。
    expect(safeNoteTitle('标题:副标题')).toBe('标题_副标题')
    // 目录穿越:`..` 先换成 `_`、`/` 也换成 `_`,开头那一串再被削掉 —— 结果里一个 `.` 一个 `/` 都没有。
    expect(safeNoteTitle('../../etc/passwd')).toBe('etc_passwd')
    expect(safeNoteTitle(undefined)).toBe('无标题笔记')
    expect(safeNoteTitle('   ')).toBe('无标题笔记')
    expect(safeNoteTitle('长'.repeat(200))).toHaveLength(40)
  })
})
