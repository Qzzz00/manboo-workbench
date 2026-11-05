/**
 * 会议模式手机端**纯的**那一半(2026-09-21)。计时、分段的形状、几句人话。
 * 分段的上传记账在 meetingOutbox.ts(2026-10-09 起落在 Preferences,不再是内存队列)。
 * 没有 React、没有 Capacitor、没有 fetch —— 整份文件在 jsdom 里跑得动。
 *
 * Ben 原话:「手机上还有『会议模式』,开完会直接打通这套系统帮忙办事、梳理」。
 */

/** 一段录多久。十分钟一段:掉电/被杀最多丢十分钟,而不是整场。 */
export const SEGMENT_MS = 10 * 60 * 1000;

/** 计时器:`01:23:45`。会议常常过一小时,所以小时位一直在。 */
export function meetingClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * 录音电平 → 那根条有多长(0~1)。
 *
 * 人声的 RMS 大部分时间在 0.02~0.2 之间,直接画出来几乎看不出动静。所以开方再放大:
 * 这根条是给人看「它还在听」的,不是仪表,**不标数字**(标了就得对得上,而它对不上)。
 */
export function meetingLevelBar(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.sqrt(rms) * 1.6);
}

/** 电平多久没动就说一句「好像没声音」。三十秒:开会本来就有冷场。 */
export const SILENT_HINT_MS = 30_000;
export const SILENT_HINT_TEXT = '这半分钟一点声音都没有,确认手机没被捂住';

/** 一段等着上传的录音。 */
export interface MeetingSegment {
  seq: number;
  bytes: Uint8Array;
  mimeType: string;
  /** 这一段多长(毫秒)。电脑那边用它对时间戳。 */
  ms: number;
  /** 这一段在手机上的文件(原生那条落盘的路径;待传箱据此记账,App 重开后再读回来)。 */
  path?: string;
}

/**
 * 录音器交出来的一段(2026-10-09)。原生那条**只给路径**(文件已经在 App 的文件目录里,几 MB 不当场读进内存);
 * WebView 退路给字节(上层写成文件再记账)。两样至少有一样。
 */
export interface RecordedSegment {
  seq: number;
  ms: number;
  mimeType: string;
  path?: string;
  bytes?: Uint8Array;
}

export type UploadOutcome = { ok: true } | { ok: false; error: string };

/** 「正在整理」那一段里,按电脑回的状态说哪一句。 */
export function meetingWorkingText(status: string | undefined, transcribed: number | undefined, segments: number | undefined): string {
  if (status === 'transcribing') {
    // 段数还没上来时不说「0/0」——那看着像坏了。
    return segments === undefined || segments === 0 || transcribed === undefined
      ? '正在转写…'
      : `正在转写…(${Math.min(transcribed, segments)}/${segments} 段)`;
  }
  if (status === 'summarizing') return '正在梳理成纪要与待办…';
  return '正在整理…';
}

/** 「整理好的会」那一摞的标题(2026-10-13)。 */
export const MEETING_RECENT_TITLE = '整理好的会';

/** 看完一场往回走那颗键。 */
export const MEETING_RECENT_BACK = '回上一页';

/** 演示用那几场的记号(电脑上一键放进来的虚构样例)。**不冒充真会**。 */
export const MEETING_DEMO_TAG = '演示用';

/**
 * 一场会的三个页签(2026-10-13,卡「会议页不再空着」)。维护者原话:
 * 「一样按照会前会中会后三个来看」。顺序照会议本身的顺序;默认停在**会后**(刚开完会,人要看的是纪要)。
 */
export const MEETING_TABS = [
  ['before', '会前'],
  ['during', '会中'],
  ['after', '会后'],
] as const;

export type MeetingTab = (typeof MEETING_TABS)[number][0];

/** 这一场没有会前登记时,会前那一页说的话。**说清怎么才会有**,不只说没有。 */
export const MEETING_NO_PREP_TEXT = '这一场没有会前登记:直接按「开始录」的、或者只导了一份转写的会都没有会前那一段。'
  + '想要的话,开会前在输入框里说一句「下午三点跟品牌方谈一条植入」,事务官会登记下来、问清五件事、备一张预案卡。';

/** 这一场没有录音时,会中那一页的头一句。 */
export const MEETING_NO_RECORDING_TEXT = '这一场没有录音:转写是现成的,事务官只把它梳理成了纪要。';

/** 时间线上那一行小字:它是哪儿来的。**会中记号这一版没有,所以不能让人以为这是她记的**。 */
export const MEETING_TIMELINE_NOTE = '这是转写自己带的时间,不是现场记的记号 —— 会中「记一下」这一版还没有。';

/** 转写里一个时间戳都没有时那句话。 */
export const MEETING_NO_TIMELINE_TEXT = '这一场的转写里没有时间戳,所以摆不出时间线。';

/** 会中那一页的头一句:录了多久、几段录音;没有录音的照实说。 */
export function meetingDuringLine(meeting: { seconds?: number; segments: number }): string {
  if (meeting.segments <= 0) return MEETING_NO_RECORDING_TEXT;
  const how = meeting.seconds === undefined ? '时长读不出来' : `录了 ${meetingClock(meeting.seconds * 1000)}`;
  return `${how} · ${meeting.segments} 段录音`;
}

/**
 * 列表上一场会说一行:哪天 + 到哪一步。
 *
 * **到哪一步照实说**:没整理成的那一场不许看着像好了(点进去才知道白等一场)。
 */
export function meetingRecentLine(meeting: { date: string; status: string; demo?: true }): string {
  const step = meeting.status === 'done'
    ? '纪要好了'
    : meeting.status === 'failed'
      ? '没整理成'
      : meeting.status === 'transcribing'
        ? '正在转写'
        : meeting.status === 'summarizing'
          ? '正在梳理'
          : meeting.status;
  // 演示用那几场挂在最后一格:看得见,但不抢「哪天 · 到哪一步」那两样。
  return `${meeting.date} · ${step}${meeting.demo === true ? ` · ${MEETING_DEMO_TAG}` : ''}`;
}

/** 结束之后那句「可以先离开」。 */
export const MEETING_LEAVE_TEXT = '可以先去忙别的,整理好了事务官会在这里和电脑上告诉你。';

/** 没有录音权限时那句话。与通话那句**故意不同**:这一句的后果是整场会都录不到。 */
export const MEETING_MIC_DENIED_TEXT = '没有录音权限,会议录不了';

/** 网页里(vite dev / 浏览器)跑会议模式时顶上那句。 */
export const MEETING_WEB_NOTE = '这是在浏览器里,屏幕一关就停;手机上装了包才是后台继续录。';

/** 退回 WebView 录音(原生那件插件没登记上)时顶上那句。**说清后果**。 */
export const MEETING_NO_BACKGROUND_TEXT = '这台设备上后台录音没接上:请让屏幕一直亮着,锁屏会停。';

/** 原生前台服务录着时那句。 */
export const MEETING_BACKGROUND_TEXT = '屏幕可以关,会继续录。';

/**
 * 进会议页先看到的那句(2026-10-09 改):录音默认不出两台设备;出门先存手机、回家自动传。
 * 「经中转服务器传」是她这一场自己点的,点之前不发生,所以这一句不提它(那颗键旁边另有一句说清)。
 */
export const MEETING_PRIVACY_TEXT = '录音默认只在这台手机和你的电脑之间走,转写经火山;在外面时先存在手机上,回到家里的网自动传。';

/** 出门时那颗键(2026-10-09,维护者定「按场开关」)。点了只管这一场。 */
export const MEETING_RELAY_LABEL = '现在经中转服务器传';
/** 那颗键旁边那句:说清它会怎样(只转发、不存;这一场后面的段也这么走)。 */
export const MEETING_RELAY_HINT = '经事务官的中转服务器转给电脑:只转发,不存下来。这一场后面的段也这么走。';

/** 录到一半断了(App 被关掉 / 手机重启,前台服务也没了)那一屏。 */
export const MEETING_INTERRUPTED_TEXT = '上次这场会录到一半断了(App 被关掉或手机重启过)。录到的部分都在手机上。';
export const MEETING_INTERRUPTED_LABEL = '传完并整理';

/** 转写 / 梳理没成时那颗键(电脑收件箱那一档是同一件事)。 */
export const MEETING_RETRY_LABEL = '重新整理';
/** 按了之后那句。 */
export const MEETING_RETRY_TEXT = '重新整理了:已经转好的段不再送识别,只补没成的那一截。';

/** 录音都在,没删 —— 出事时必须说的那句。 */
export const MEETING_KEPT_TEXT = '录到的部分都还在(手机上和电脑的会议目录里),没有删。';
