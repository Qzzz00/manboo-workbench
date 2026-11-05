/**
 * 手机上「AIDJ 通勤播客」的只读契约与播放状态机(2026-09-22)。
 *
 * 服务端那一份在 `workbench-plugin/src/server/aidj.ts`,这里是**它的只读子集**
 * (字段名一字不改,同 `newsModel.ts` 对 `/feed` 的做法)。手机不认识的字段一律忽略。
 *
 * ## 这一版的播放模型(**故意比 Aiboo 屏保那套薄**)
 *
 * Aiboo 自己的 `src/screensaver/lib/djClient.ts` 还管 Live2D 口型、原生前台 Service、
 * 蓝牙媒体键。**这里一样都不搬** —— 任务卡明写了「不搬口型/Live2D」,
 * 而前台 Service 是原生插件的事(上一版「没做的」第 1 条,这个包里仍然没有)。
 *
 * 留下来的就是一条:**按序播**。
 *
 *   一段播完 → 下一段;某段没有音频(Aiboo 那行 TTS 失败了)→ 按字数停留同样往下走;
 *   全部播完 → 停在最后一段,不循环(它是一期节目,不是电台)。
 *
 * 状态机全是纯函数,放在这里单测;`<audio>` 与计时器在 `PodcastBar.tsx`。
 */

export interface AidjTopic {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  section?: string;
}

export interface AidjSegment {
  id: string;
  /** 主播名。 */
  speaker: string;
  text: string;
  /** 绝对地址(指向 Aiboo)。**缺席 = 那一段没有音频**,按字数停留。 */
  audio_url?: string;
  /** Aiboo 按字数估的毫秒。**不拿它报时长**,只做没有音频时的停留。 */
  duration_ms: number;
  tier?: string;
  topic_id?: string;
}

export interface AidjBed {
  url: string;
  title?: string;
  artist?: string;
}

export interface AidjProgram {
  date: string;
  status: 'ready' | 'empty';
  topics: AidjTopic[];
  segments: AidjSegment[];
  hosts: string[];
  bed?: AidjBed;
  estimated_total_ms: number;
}

export interface AidjConfig {
  enabled: boolean;
  base_url: string;
  push_interests: boolean;
  /**
   * Aiboo 写接口那把令牌**存没存**(2026-09-22)。
   * 真值一辈子不下发到手机 —— 服务端只回这个布尔(`publicAidjConfig`),
   * 所以界面上只说「已设置」,永远显示不出它是什么。
   */
  token_set: boolean;
}

/**
 * 能改的那几样。`token` **只写不读**:填了发上去存在 Mac 上那份
 * `aidj-config.json` 里,回来的只有 `token_set`。空串 = 清掉。
 */
export type AidjConfigPatch = Partial<Omit<AidjConfig, 'token_set'>> & { token?: string };

export interface AidjView {
  status: 'ready' | 'empty' | 'stale' | 'off' | 'error';
  program?: AidjProgram;
  /** 为什么没有。工作台 / Aiboo 的原话,**一个字都不改写**。 */
  error?: string;
  fetched_at: number;
  config: AidjConfig;
}

/** 还没问到的时候。**不是**「今天没有节目」—— 两者在界面上说的话不一样。 */
export const EMPTY_AIDJ: AidjView = {
  status: 'empty',
  fetched_at: 0,
  config: { enabled: true, base_url: '', push_interests: true, token_set: false },
};

/** 音乐床的音量。与 Aiboo 屏保里那个 `DUCK` 同一个数(口播时把音乐压到这儿)。 */
export const BED_VOLUME = 0.18;

/** 没有音频的一段停留多久:按字数估,但不少于 2.6 秒(同 Aiboo djClient 那条兜底)。 */
export function dwellMs(segment: AidjSegment): number {
  const byLength = segment.text.length * 170;
  const byServer = segment.duration_ms > 0 ? segment.duration_ms : 0;
  return Math.max(2600, byLength, byServer);
}

/**
 * 这一份视图**能不能播**。只有 `ready` 且真有段落才算。
 * 别的一律要退回上一版那条单人口播 —— 见 `fallbackNote`。
 */
export function canPlay(view: AidjView): boolean {
  return view.status === 'ready' && (view.program?.segments.length ?? 0) > 0;
}

/**
 * 退回单人口播时,在播放条下面说的那一句。
 * **回 undefined = 不用说**(能播 AIDJ,或者压根没接)。
 *
 * 每一种状态说一句不同的话 —— 「Aiboo 今天还没生成」与「连不上 Aiboo」
 * 在用户那儿是两件完全不同的事,一句「暂不可用」把它们糊在一起等于什么都没说。
 */
export function fallbackNote(view: AidjView): string | undefined {
  if (canPlay(view)) return undefined;
  switch (view.status) {
    case 'off':
      return '双主播播客关着,听的是工作台自己合成的那段。';
    case 'empty':
      return 'Aiboo 今天那期还没生成(它每天早上 7 点跑),先听工作台自己合成的那段。';
    case 'stale':
      return view.error ?? 'Aiboo 上最新那期不是今天的,先听工作台自己合成的那段。';
    case 'error':
      return view.error ?? '取不到 Aiboo 的播客,先听工作台自己合成的那段。';
    default:
      return undefined;
  }
}

/** 播放条标题:今天那期 + 几位主播。 */
export function programTitle(program: AidjProgram): string {
  const hosts = program.hosts.length === 0 ? '' : `·${program.hosts.join(' / ')}`;
  return `今天的资讯播客${hosts}`;
}

/**
 * 「第 n / N 段 · 约 x 分钟」。
 *
 * **时长前面那个「约」不是客气**:`estimated_total_ms` 是 Aiboo 按字数估出来的
 * (`ttsAdapter.estimateDurationMs`),不是音频的真时长。把它当真时长报出去就是编数。
 */
export function progressLabel(program: AidjProgram, index: number): string {
  const total = program.segments.length;
  const at = Math.min(Math.max(index + 1, 1), total);
  const minutes = Math.round(program.estimated_total_ms / 60000);
  return minutes > 0 ? `第 ${at}/${total} 段 · 约 ${minutes} 分钟` : `第 ${at}/${total} 段`;
}

/** 下一段的下标。到头了回 `segments.length`(= 播完了,**不循环**)。 */
export function nextIndex(program: AidjProgram, index: number): number {
  return Math.min(index + 1, program.segments.length);
}

/** 夹到合法范围。越界的下标(跳段按钮连点)不该把播放器弄崩。 */
export function clampIndex(program: AidjProgram, index: number): number {
  if (program.segments.length === 0) return 0;
  return Math.min(Math.max(index, 0), program.segments.length - 1);
}

/** 播完了没有。 */
export function isFinished(program: AidjProgram, index: number): boolean {
  return index >= program.segments.length;
}

/** 当前这一段。播完了 / 空节目回 undefined。 */
export function segmentAt(program: AidjProgram, index: number): AidjSegment | undefined {
  return program.segments[index];
}

/** 当前这一段在讲哪张话题卡片。没有就 undefined —— **不硬塞第一张**。 */
export function topicAt(program: AidjProgram, index: number): AidjTopic | undefined {
  const id = segmentAt(program, index)?.topic_id;
  if (id === undefined) return undefined;
  return program.topics.find(topic => topic.id === id);
}

/**
 * 从某一段起往后找第一段**有音频**的。用在「跳过没有音频的几段」那种手动跳转上。
 * 一段都没有就回 undefined(整期都没音频 —— 那就只能读文字)。
 */
export function nextPlayableIndex(program: AidjProgram, from: number): number | undefined {
  for (let i = Math.max(0, from); i < program.segments.length; i += 1) {
    if (program.segments[i]?.audio_url !== undefined) return i;
  }
  return undefined;
}

/** 整期一段音频都没有(Aiboo 那边 TTS 全挂了)。这时候界面只能当文字稿读。 */
export function isTextOnly(program: AidjProgram): boolean {
  return program.segments.length > 0 && nextPlayableIndex(program, 0) === undefined;
}
