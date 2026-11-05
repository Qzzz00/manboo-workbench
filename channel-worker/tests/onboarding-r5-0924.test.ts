/**
 * 第五轮引导对话(2026-09-24 11:3x,0.2.79,维护者手机语音走引导)电话这一头的回放。
 * 原句取自 ~/.dsh/workbench/logs/channel-worker.log 那一通。工作台那一头在
 * workbench-plugin/tests/server-onboarding-r5-0924.test.ts。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OnboardingBrief } from '../src/onboarding.ts'
import { ONBOARDING_RESUME_INSTRUCTION, PHONE_TURN_RULES, TOOL_SCAN_PROJECTS, buildOnboardingInstructions, correctResultText, scanResultText } from '../src/onboarding.ts'
import { StutterFilter, collapseStutter, withoutStutter } from '../src/stutter.ts'
import { speakableText } from '../src/tts/speakable.ts'

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'projects',
    label: '②′ 项目',
    done: false,
    seed: '你想先把哪个项目交给我?说个名字就行,我先只录这一个。',
    speak_seed: false,
    goals: [],
    keys: [
      { name: 'read_scan_roots', kind: 'tri', desc: '读扫描根', required: false },
      { name: 'project', kind: 'project', desc: '项目', required: true },
    ],
    answered: { opening: ['nickname'], branch: ['mode'], template: ['template'] },
    nickname: 'Ben',
    ...over,
  }
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) return out
    out.push(next.value)
  }
}

function streamOf<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({ start(controller) { for (const item of items) controller.enqueue(item); controller.close() } })
}

describe('3 · 一句说两次(「运营?营?」)', () => {
  const said = '那我以后就这么叫你了,Ben。你说的这件事,更像是做产品研发,还是做自媒体运营?营?我按这个给你把工作台摆好。'
  const saidFull = '你说的这件事,更像是做产品研发,还是做自媒体运营？营？我按这个给你把工作台摆好。'

  it('整段里紧挨着重复、以句末标点收尾的一小段只留一遍(半角、全角问号都认)', () => {
    expect(collapseStutter(said)).toBe('那我以后就这么叫你了,Ben。你说的这件事,更像是做产品研发,还是做自媒体运营?我按这个给你把工作台摆好。')
    expect(collapseStutter(saidFull)).toBe('你说的这件事,更像是做产品研发,还是做自媒体运营？我按这个给你把工作台摆好。')
    expect(collapseStutter('对。对。那就这样。')).toBe('对。那就这样。')
  })

  it('叠字、隔了别的字的重复、正常句子都不动', () => {
    for (const text of ['好好,我记下了。', '哈哈哈,行。', '是这个吗?是这个。', '你好。今天好吗?', '好。好的。']) {
      expect(collapseStutter(text)).toBe(text)
    }
  })

  it('流式:重复那一段跨着两块来(模型一块一块吐)也能去掉,字一个不丢', () => {
    const filter = new StutterFilter()
    const pieces = ['你说的这件事,更像是做产品研发,', '还是做自媒体运营?', '营', '?我按这个', '给你把工作台摆好。']
    const out = pieces.map(piece => filter.push(piece)).join('') + filter.flush()
    expect(out).toBe('你说的这件事,更像是做产品研发,还是做自媒体运营?我按这个给你把工作台摆好。')
    const plain = new StutterFilter()
    const normal = ['好,Ben。', '你现在是已经有在做的事,', '还是想从一个新点子开始?']
    expect(normal.map(piece => plain.push(piece)).join('') + plain.flush()).toBe(normal.join(''))
  })

  it('接在 llmNode 上:ChatChunk 的字被过滤,工具调用与 usage 原样过', async () => {
    const chunk = (content: string) => ({ id: 'c', delta: { role: 'assistant', content } })
    const tool = { id: 'c', delta: { role: 'assistant', toolCalls: [{ name: 'record_answer' }] } }
    const usage = { id: 'c', usage: { completionTokens: 1 } }
    const got = await drain(withoutStutter(streamOf<unknown>([chunk('还是做自媒体运营?'), chunk('营?我按这个'), tool, chunk('摆好。'), usage])))
    const text = got.map(item => typeof item === 'string' ? item : ((item as { delta?: { content?: string } }).delta?.content ?? '')).join('')
    expect(text).toBe('还是做自媒体运营?我按这个摆好。')
    expect(got).toContainEqual(tool)
    expect(got).toContainEqual(usage)
  })

  it('agent.ts 把它接在模型输出上(合成、字幕、对话历史同一条)', () => {
    const agent = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8')
    // 2026-09-30 起外面多包一层 DSML(模型把工具调用写进正文那种)—— 去结巴那一层照旧在模型输出上。
    expect(agent).toContain('withoutStutter(withDsmlToolCalls(got))')
  })
})

describe('2 · 电话里接着做:不问「上次到哪」,只问那一题', () => {
  it('接着做那一句指示不再招呼「上次做到这儿,接着吗」', () => {
    expect(ONBOARDING_RESUME_INSTRUCTION).not.toContain('上次')
    expect(ONBOARDING_RESUME_INSTRUCTION).not.toContain('接着吗')
    expect(ONBOARDING_RESUME_INSTRUCTION).toContain('还没答的那一题')
    const agent = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8')
    expect(agent).toContain('generateReply({ instructions: ONBOARDING_RESUME_INSTRUCTION })')
    expect(agent).not.toContain('上次做到这儿,接着吗')
  })
})

describe('4 / 5 · 改称呼不再宣告;答得明确不求确认', () => {
  it('改好称呼的工具回话不再叫她说「那我以后就这么叫你了」', () => {
    const text = correctResultText({ status: 200, body: { ok: true } }).text
    expect(text).toContain('改好了')
    expect(text).toContain('不宣告')
    expect(text).not.toMatch(/跟他确认一句「那我以后就这么叫你了」/)
  })

  it('电话规矩里:答得明确直接记,不复述求「对吗」;称呼确认过不再宣告', () => {
    const rules = PHONE_TURN_RULES.join('\n')
    expect(rules).toContain('答得明确就不求确认')
    expect(rules).toContain('不再宣告「那我以后就这么叫你了」')
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain('改完**不宣告、不求确认**')
    expect(text).not.toContain('改完跟他确认一句')
  })
})

describe('6 / 7 · 电话里短;不用让合成语气怪的符号', () => {
  it('规矩里写明每轮最多两句、一个问题、40 字上下;不用破折号引号括号,字母不拆', () => {
    const rules = PHONE_TURN_RULES.join('\n')
    expect(rules).toContain('最多两句、一个问题')
    expect(rules).toContain('40 个字')
    expect(rules).toContain('不用破折号、引号、书名号、括号、省略号')
    expect(rules).toContain('不拆成字母')
  })

  it('送去合成前清掉:破折号 → 停顿,引号去掉,括号换停顿,「B e n」合成一个词,连字符念成空格', () => {
    expect(speakableText('明白了,是 Ben,B e n,我这就把名字改过来。')).toBe('明白了,是 Ben,Ben,我这就把名字改过来。')
    expect(speakableText('那我先给你摆成做产品研发那一套 —— 写代码、带 Agent、盯仓库和额度。')).toBe('那我先给你摆成做产品研发那一套，写代码、带 Agent、盯仓库和额度。')
    expect(speakableText('好,那就按「工作台」找。')).toBe('好,那就按工作台找。')
    expect(speakableText('我会往记忆文件夹里写(只在这台电脑上)。可以吗?')).toBe('我会往记忆文件夹里写，只在这台电脑上。可以吗?')
    expect(speakableText('最近在动的有 desktop-workbench、ben_dsh……是哪一个?')).toBe('最近在动的有 desktop workbench、ben dsh，是哪一个?')
    expect(speakableText('——好。')).toBe('好。')
    expect(speakableText('Ben, I am fine.')).toBe('Ben, I am fine.')
  })

  it('统筹指认的那一句(工人日志 142 行):引号与破折号换成自然停顿,字不丢', () => {
    const said = '那句「对吗」是因为把活儿归到哪一类是我猜的,得你点头我才敢往下记 —— 记错了后面整个桌子都摆歪了。那你想先把哪个项目交给我?'
    const spoken = speakableText(said)
    expect(spoken).not.toMatch(/[「」—]/)
    expect(spoken).toBe('那句对吗是因为把活儿归到哪一类是我猜的,得你点头我才敢往下记\uFF0C记错了后面整个桌子都摆歪了。那你想先把哪个项目交给我?')
  })

  it('提示词:被问「为什么问」一句话答完往下走,不解释内部考量、不打比方', () => {
    const rules = PHONE_TURN_RULES.join('\n')
    expect(rules).toContain('不替自己辩解')
    expect(rules).toContain('不打比方')
    expect(rules).toContain('一句话答完')
  })

  it('合成那两条路(逐句合成、开场白预合成)都先过 speakable;字幕那一份只剥语气标签', () => {
    const tts = readFileSync(join(import.meta.dirname, '..', 'src', 'tts', 'butlerTts.ts'), 'utf8')
    /**
     * 2026-10-02(卡「声音与形象跟着话走」):逐句那条改成了 `speakableSpeech`
     * —— 同一层既清洗、又把句首那个语气标签摘走(不摘的话「关心」两个字会被念出来)。
     * 清洗那一半一个字没变(speakableText 现在就是 `speakableSpeech(x).text`)。
     */
    expect(tts).toContain('speakableSpeech(this.inputText.trim())')
    expect(tts).toContain('tts.order.slot(stripToneTags(text).trim()')
    const greeting = readFileSync(join(import.meta.dirname, '..', 'src', 'tts', 'greeting.ts'), 'utf8')
    expect(greeting).toContain('text: speakableText(text)')
    /**
     * **开场白 / 垫场那条路照旧不带语气**(卡里点名的):那几句是我们自己写死的,
     * 语气由音色自己定;带一个语气过去只会让「我想想」忽然变得很高兴。
     */
    expect(greeting).not.toContain('emotion')
    expect(greeting).not.toContain('tone')
  })
})

describe('1 · 按名字没找到就念最近在动的几个让他挑', () => {
  it('回包带 candidates:一句话念名字让他挑,别让他报路径', () => {
    const text = scanResultText({
      status: 200,
      body: { query: '工作台', located: [], candidates: [{ name: 'desktop-workbench', path: '/u/desktop-workbench' }, { name: 'Aiboo', path: '/u/Aiboo' }, { name: 'ben-dsh-workbench', path: '/u/b' }] },
    })
    expect(text.ok).toBe(true)
    expect(text.text).toContain('desktop-workbench、Aiboo、ben-dsh-workbench')
    expect(text.text).toContain('别让他报路径')
    // 2026-09-24(已有项目拉齐):候选的 path 也交给模型(他挑中了带着它去读),单独一行注明别念;念的那一句里只有名字。
    const [say, paths] = text.text.split('\n')
    expect(say).not.toContain('/u/')
    expect(paths).toContain('desktop-workbench → /u/desktop-workbench')
    expect(paths).toContain('**别念**')
    expect(text.text).not.toContain('给我个路径')
  })

  it('这一段的提示词:name 照原话填、没找到会带回候选、他说了位置就当 name 填', () => {
    const text = buildOnboardingInstructions({ brief: brief() })
    expect(text).toContain('按名字没找到时工作台会带回最近在动的几个')
    expect(text).toContain('~/Documents/GitHub')
    expect(text).toContain(TOOL_SCAN_PROJECTS)
  })
})
