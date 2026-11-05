/**
 * 舞台页的字幕(2026-09-17,Ben:「我比较喜欢 Grok 的暗色,就是字幕形式」)。
 * 只管「显示什么 / 显示多少 / 什么时候淡出」,纯函数,不碰 DOM、不碰网络。
 *
 * 一条字幕 = 最后一条记录的两行:上面我说的那句(ASR 出来的原话),下面事务官那句。
 * 事务官那句随朗读**逐句**出现(不是一个字一个字蹦);读完停留几秒再淡出。
 * 状态句(「事务官在办」这类,不是真回复)也上字幕,但标成 status——界面画淡一点,且不朗读(见 chatModel.ts:不编假回复)。
 */
import type { ButlerSide, ThreadMessage } from '../chat/chatModel';
import type { AnswerView, AnswersView } from '../api/protocol';

export interface CaptionLine {
  text: string;
  /** 同一条事项换了回复也算新字幕:key 变了就重新出一次。 */
  key: string;
}

export interface ButlerCaptionLine extends CaptionLine {
  kind: ButlerSide['kind'];
  /**
   * ★ **这一行是一条「问一句」的回答**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   * 带着那条回答的 id:她点一下 = 展开全文 + 标「看过了」(`POST /answers/seen`)。
   * 缺席 = 照旧那条事项字幕(行为一字不差)。
   */
  answerId?: string;
}

export interface CaptionLines {
  me?: CaptionLine;
  butler?: ButlerCaptionLine;
}

/** 字幕一行最多这么长,再长就截断 + 「展开」。手机一屏两行的量。 */
export const CAPTION_MAX = 56;

export interface CaptionTiming {
  /** 逐句出现的速度:每个字给多少毫秒(中文 TTS 大约每秒 5 个字)。 */
  msPerChar: number;
  /** 读完之后停留多久。 */
  holdMs: number;
  /** 淡出动画多久。 */
  fadeMs: number;
}

export const CAPTION_TIMING: CaptionTiming = { msPerChar: 190, holdMs: 5000, fadeMs: 600 };

/**
 * 哪一条能上首页字幕(2026-09-25 夜,卡 fix/phone-home-orb-first;统筹拍板「一刀切」):
 * **只取还在办 / 等你确认的事**(todo / doing / blocked / confirm),以及刚发出去、还没落成事项的那一句(没有 status)。
 * 办完了的(哪怕是一句真回答)、取消了的都不上首页 —— 办完的回答去右上角「记录」或事项详情里看。
 * 以前办完的那句回答照上,统筹小米真机上一段办完的长回答占了五行大字,把球压成一个小点。
 * 红字(出错)于是只会出现在一件还开着的事上。
 */
const CAPTION_STATUSES: ReadonlySet<string> = new Set(['todo', 'doing', 'blocked', 'confirm']);

export function captionEligible(message: ThreadMessage): boolean {
  return message.status === undefined || CAPTION_STATUSES.has(message.status);
}

/**
 * ★ **答案来找她 —— 字幕这一处**(2026-10-04,卡 `claude/answer-comes-to-her`)。
 *
 * 维护者 10-04(经工作台捎话):「信息直接从正在办切到办完了,我是自己追过去点开查看的……
 * 这个交互你得想想咋整」。病根是「问一句」的答案只留在那张卡里,而那张卡两秒钟就从
 * 「正在办」滑进「办完」。她点头的做法:**答案直接出现在她提问的那个地方** ——
 * 手机上就是这一行。
 *
 * 判「问一句 / 交代一件事」在**工作台一处**(`server/casualAsk.ts`),手机不自己判;
 * 摆哪一条也在**工作台一处**(`src/answerCell.ts` 的 `answerToShow`),手机照抄那一条规矩:
 * **最新那条还没看过的**。一条都没有 → 缺席,字幕让位给原来那条事项字幕。
 *
 * 为什么它压过事项字幕:她刚刚问的那一句,答案就在手里 —— 这会儿屏幕上最要紧的就是它。
 * (通话中 / 引导中这一整格本来就让位给通话字幕,见 `StagePage`;这里不另判一遍。)
 */
export function answerCaptionOf(view: AnswersView | undefined): AnswerView | undefined {
  return view?.items.find((one) => one.seen_at === undefined);
}

/** 那一条回答摆成两行字幕(上面她问的那一句,下面答案)。 */
export function answerCaptionLines(answer: AnswerView): CaptionLines {
  const key = `answer:${answer.id}:${answer.at}`;
  return {
    // 她问的那一句缺席(老账)时上面那一行干脆不出 —— 不编一句「你问了一句」。
    ...(answer.question === '' ? {} : { me: { text: answer.question, key } }),
    butler: { kind: 'reply', text: answer.answer, key, answerId: answer.id },
  };
}

export function captionLinesOf(thread: readonly ThreadMessage[]): CaptionLines {
  /**
   * 她停着等他(问了他一句 / 要他批一件事)的那一件先上字幕(2026-09-25,卡 M 补;统筹真壳:「她在等他答时,
   * 状态要说『等你回答』,手机字幕同理」)—— 哪怕后来他又说了一件别的事。没有在等他的,照旧取最后一件。
   */
  let last: ThreadMessage | undefined;
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const one = thread[i]!;
    if (captionEligible(one) && one.butler.waiting !== undefined) { last = one; break; }
  }
  for (let i = thread.length - 1; i >= 0 && last === undefined; i -= 1) {
    const one = thread[i]!;
    if (captionEligible(one)) { last = one; break; }
  }
  if (last === undefined) return {};
  const id = last.taskId ?? last.localId ?? '?';
  // 他那一句写**事项标题**(还没落地的那条只有原话):desc 不上首页(2026-09-25,卡 feat/first-look-orb-top)。
  const said = last.title !== undefined && last.title.trim() !== '' ? last.title : last.user;
  return {
    me: { text: said, key: `${id}:${last.butler.text}` },
    butler: { kind: last.butler.kind, text: last.butler.text, key: `${id}:${last.butler.text}` },
  };
}

export function truncateCaption(text: string, max: number = CAPTION_MAX): { shown: string; truncated: boolean } {
  if (text.length <= max) return { shown: text, truncated: false };
  return { shown: `${text.slice(0, max)}…`, truncated: true };
}

const SENTENCE = /[^。!?;!?;\n]*[。!?;!?;\n]|[^。!?;!?;\n]+/g;

export function splitSentences(text: string): string[] {
  if (text === '') return [];
  return text.match(SENTENCE) ?? [text];
}

/** 到 sinceMs 这一刻该显示多少:整句整句地放,第一句一上来就有。 */
export function revealedText(text: string, sinceMs: number, msPerChar: number = CAPTION_TIMING.msPerChar): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return '';
  const budget = sinceMs / Math.max(1, msPerChar);
  let out = sentences[0];
  for (let i = 1; i < sentences.length; i += 1) {
    if (out.length >= budget) break;
    out += sentences[i];
  }
  return out;
}

export type CaptionPhase = 'revealing' | 'hold' | 'leaving' | 'gone';

export function captionPhaseAt(input: {
  length: number;
  sinceMs: number;
  speaking: boolean;
  expanded: boolean;
  timing?: CaptionTiming;
}): CaptionPhase {
  const t = input.timing ?? CAPTION_TIMING;
  // 嘴上还在说就不走:TTS 比估算慢的时候字幕不能先消失。
  if (input.speaking) return 'revealing';
  const revealMs = input.length * t.msPerChar;
  if (input.sinceMs < revealMs) return 'revealing';
  // 点开看全文的时候不淡出,等 Ben 自己收起来。
  if (input.expanded) return 'hold';
  if (input.sinceMs < revealMs + t.holdMs) return 'hold';
  if (input.sinceMs < revealMs + t.holdMs + t.fadeMs) return 'leaving';
  return 'gone';
}
