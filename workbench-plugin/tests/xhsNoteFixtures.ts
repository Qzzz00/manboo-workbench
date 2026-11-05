/**
 * 采集类解析器的夹具(2026-09-22)。
 *
 * ## ★★ 数字与文本全是明显假的,而且这里没有一份是"真的笔记页"
 *
 * 写这张卡的人**没有小红书账号**。2026-09-21 预研实测:不带登录态连笔记页都打不开
 * (边缘层 302 到 `error_code=300031`),所以**登录后的笔记页长什么样,我一个字都没见过**。
 *
 * 这里的 `FAKE_NOTE_PAYLOAD` 是照着
 * [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)(Apache-2.0)
 * 的 `xiaohongshu/types.go` 里那几个 struct 的**字段名**编出来的一份版面。
 * 它**只证明解析规则本身成立**(字段能抽出来、子评论不会被采进来、赞数能排序),
 * **不证明真页面能解析**。真页面能不能解析,要等 Ben 登录一次、给一条链接才知道。
 *
 * 所有数字都取成一眼假的形状(1111 / 999 / 888 / 77 / 6 / 5),
 * 所有文本都写成「假标题」「假作者」这种,就是为了万一有人把夹具当成
 * "小红书大概长这样"时能立刻看出来不对。
 */

/** 夹具里那条笔记的 id(24 位十六进制,形状真、内容假)。 */
export const FAKE_NOTE_ID = 'aaaaaaaa1111bbbb2222cccc'

/** 夹具里那条笔记的链接。 */
export const FAKE_NOTE_URL = `https://www.xiaohongshu.com/explore/${FAKE_NOTE_ID}?xsec_token=FAKE_TOKEN_1111`

/** 2026-09-21T00:00:00Z 的毫秒数。写死是为了产物里那个 ISO 串可预期。 */
const FAKE_TIME = Date.parse('2026-09-21T00:00:00.000Z')

/**
 * 视频笔记那一份。`JSON.stringify(noteDetailMap)` 的原文 —— 与浏览器那头读回来的形状一致。
 *
 * 故意放进去的几样,每一样都对应一条用例:
 * - `subComments` 里有两条 —— **一条都不该被采进来**;
 * - 三条评论赞数 `888` / `1111` / `77`,顺序是乱的 —— 排序要把 `1111` 那条排到最前;
 * - `stream` 里两档分辨率 —— 要挑大的那一档;
 * - 一条 `content` 是空串的评论 —— 该被丢掉,不该变成一条空评论。
 */
export const FAKE_NOTE_PAYLOAD = JSON.stringify({
  [FAKE_NOTE_ID]: {
    note: {
      noteId: FAKE_NOTE_ID,
      title: '假标题:这是一条编出来的视频笔记',
      desc: '这段短文案是编的 #假标签一 #假标签二[话题]',
      type: 'video',
      time: FAKE_TIME,
      ipLocation: '假省份',
      user: { nickname: '假作者', userId: 'fake-user-1111' },
      interactInfo: { likedCount: '1111', collectedCount: '999', commentCount: '888', sharedCount: '77' },
      tagList: [{ name: '假标签一', type: 'topic' }, { name: '假标签三', type: 'topic' }],
      video: {
        media: {
          video: { duration: 66 },
          stream: {
            h264: [
              { masterUrl: 'https://fake.example/小-1111.mp4', width: 360, height: 640, videoDuration: 66_000 },
              { masterUrl: 'https://fake.example/大-1111.mp4', width: 1080, height: 1920, videoDuration: 66_000 },
            ],
            h265: [],
          },
        },
      },
    },
    comments: {
      list: [
        {
          id: 'c-888', content: '假评论:赞数 888 的那条', likeCount: '888',
          createTime: FAKE_TIME, ipLocation: '假省份', userInfo: { nickname: '假网友甲' },
          subCommentCount: '2',
          subComments: [
            { id: 'c-888-1', content: '★ 这是子评论,一个字都不该被采进来', likeCount: '6' },
            { id: 'c-888-2', content: '★ 这也是子评论', likeCount: '5' },
          ],
        },
        {
          id: 'c-1111', content: '假评论:赞数 1111 的那条,应该排第一', likeCount: '1111',
          createTime: FAKE_TIME, userInfo: { nickname: '假网友乙' },
        },
        {
          id: 'c-77', content: '假评论:赞数 77 的那条', likeCount: '77',
          userInfo: { nickname: '假网友丙' },
        },
        // ★ 空正文:该被丢掉,不该变成一条空评论。
        { id: 'c-empty', content: '   ', likeCount: '999', userInfo: { nickname: '假网友丁' } },
      ],
      cursor: 'fake-cursor',
      hasMore: false,
    },
  },
})

/** 图文笔记那一份(没有 `video`,有 `imageList`)。 */
export const FAKE_IMAGE_NOTE_PAYLOAD = JSON.stringify({
  [FAKE_NOTE_ID]: {
    note: {
      noteId: FAKE_NOTE_ID,
      title: '假标题:这是一条编出来的图文笔记',
      desc: '图文的短文案也是编的',
      type: 'normal',
      time: FAKE_TIME,
      user: { nickName: '假作者' },
      interactInfo: { likedCount: '999' },
      imageList: [
        { urlDefault: 'https://fake.example/图1-1111.jpg', width: 1080, height: 1440 },
        { urlDefault: 'https://fake.example/图2-1111.jpg', width: 1080, height: 1440 },
      ],
    },
    comments: { list: [] },
  },
})

/**
 * 风控页的 `innerText`。
 *
 * 「当前笔记暂时无法浏览」这七个字是**真的** —— 2026-09-21 预研从
 * `error_code=300031&error_msg=` 那个跳转参数里逐字解出来的(实验三)。
 * 其余是编的版面。
 */
export const FAKE_BLOCKED_PAGE_TEXT = [
  '小红书',
  '当前笔记暂时无法浏览',
  '返回首页',
].join('\n')

/** 验证码页的 `innerText`(编的版面,关键词取自 `xhsNoteText.CAPTCHA_WORDS`)。 */
export const FAKE_CAPTCHA_PAGE_TEXT = [
  '安全验证',
  '请完成验证后继续',
  '拖动滑块完成拼图',
].join('\n')

/** 未登录页的 `innerText`(编的版面)。 */
export const FAKE_LOGIN_PAGE_TEXT = [
  '小红书',
  '扫码登录',
  '新用户可直接登录',
].join('\n')

/** 一份能读的 SRT(时间是编的,文字也是编的)。 */
export const FAKE_SRT = [
  '1',
  '00:00:00,000 --> 00:00:07,700',
  '假逐字稿第一句:开头在这里',
  '',
  '2',
  '00:00:07,700 --> 00:00:19,900',
  '假逐字稿第二句:正文在这里',
  '',
  '3',
  '00:01:06,000 --> 00:01:11,100',
  '假逐字稿第三句:结尾在这里',
  '',
].join('\n')

/**
 * ★★ **这一份是真的。** 2026-09-21 在这台机器上跑出来的,逐字抄的,一个字没改
 * (连它自己听错的「一條比計」「與素」「肉在好野力步起來」都留着)。
 *
 * 命令:`whisper-cli -m ggml-base.bin -f 口播.wav -l zh -osrt -of 字幕 -ml 40 -np`
 * —— 就是 `xhsBreakdown.ts` 里那一条,参数一个字都没改。
 * 音频是 macOS `say` 念的一段 46 秒中文口播(**假数据**:稿子是编的,没有任何真人的声音)。
 *
 * 留它当夹具的理由:**繁→简那一层的存在全靠这一份**。
 * 同一个模型、同一条命令,换另一段音频出来是纯简体 —— 字形是 whisper 自己挑的,参数按不住。
 * 全表在 `docs/交接-0922-转写简繁.md` 第二节。
 */
export const REAL_SRT_TRADITIONAL = [
  '1',
  '00:00:00,000 --> 00:00:08,340',
  '大家好,今天這條我們只講一件事,一條比計的內容框架到底是怎麼搭出來的,開頭三秒必',
  '',
  '2',
  '00:00:08,340 --> 00:00:17,700',
  '須給一個勾子,要麼拋結論,要麼提一個讓人心裡一緊的問題,正文分三塊,先說問題有多',
  '',
  '3',
  '00:00:17,700 --> 00:00:23,280',
  '常見,再說你採過哪個坑,最後給一個今天就能做的動作,',
  '',
  '4',
  '00:00:23,280 --> 00:00:32,740',
  '結尾不要說謝謝觀看,要給一個收藏的理由,比如這份清單你隨時能翻回來看,節奏上,每',
  '',
  '5',
  '00:00:32,740 --> 00:00:41,990',
  '十五秒換一個小話題,與素比平時快一點,停頓留在轉折的地方,記住,框架式骨頭,細節',
  '',
  '6',
  '00:00:41,990 --> 00:00:46,040',
  '式肉,骨頭搭不對,肉在好野力步起來。',
  '',
].join('\n')

/**
 * ★★ **这一份是真的。**
 *
 * 2026-09-22 真跑抓下来的:用一个**全新的空 Chrome 档案**(没登录任何账号)打开
 * yt-dlp 仓库里那条公开测试笔记链接
 * `https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9`,
 * 站点把我们**跳到了 `/explore`**(不是 `/login`!)并在上面盖了一张登录卡片。
 * 下面是那一页 `document.body.innerText` 的前 200 字,逐字抄的,一个字没改。
 *
 * 为什么要把它留成夹具:那一趟**真跑出了一个红线级的 bug** ——
 * 因为 URL 里没有 `/login`、而且 `__INITIAL_STATE__.note.noteDetailMap` 照样存在,
 * `readNoteWith` 当时的判据一条都没命中,于是它**在这堵登录墙上滚了 3 下**。
 * 修法见 `xhsNoteBrowser.ts` 里那段注释。这份夹具是那个 bug 的回归守卫。
 */
export const REAL_LOGGED_OUT_EXPLORE_TEXT = [
  '登录后推荐更懂你的笔记',
  '可用',
  '小红书',
  '或',
  '微信',
  '扫码',
  '小红书如何扫码',
  '手机号登录',
  '+86',
  '获取验证码',
  '登录',
  '我已阅读并同意《用户协议》《隐私政策》《儿童/青少年个人信息保护规则》',
  '新用户可直接登录',
  '创作中心',
  '业务合作',
  '发现',
  'RED',
  '直播',
  '发布',
  '通知',
  '消息',
  '登录',
  '',
  '沪ICP备13030189号',
].join('\n')

/** 同一趟真跑里,未登录时 `location.href` 停在哪。**不是 `/login`** —— 这正是当时判据漏掉的地方。 */
export const REAL_LOGGED_OUT_HREF = 'https://www.xiaohongshu.com/explore'

/**
 * 同一趟真跑里 `noteDetailMap` 读回来的那一份:**存在,但里面没有这条笔记**(134 个字符)。
 * 内容没抄(是站点的内部结构,与这张卡无关),只留一个"它非空"的形状。
 */
export const REAL_LOGGED_OUT_PAYLOAD = JSON.stringify({ 'some-other-id': { note: {} } })
