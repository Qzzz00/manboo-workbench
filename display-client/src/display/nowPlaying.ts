/**
 * 展示台音乐卡上写什么(2026-09-30,维护者:「音乐和播客现在格式坏的」)。
 *
 * 根因:电台的节目单里除了歌还有 DJ 口播段,通勤播客整期都是主播口播段 —— 这些段落
 * `dj.playing` 是 `{ kind: 'tts', role, text }`,**没有 title / artist**。展示台 09-10 起只认歌名,
 * 于是**正在出声**的时候卡片写「未在播放 / —」,看着就是坏的。
 *
 * 现在按段落类型写:
 *   · 歌:歌名 / 歌手;
 *   · 电台 DJ 口播:「DJ 在说」/ 原话;
 *   · 通勤播客:在聊的那张话题卡的标题 / 「主播:原话」;
 *   · 没在出声:如实说为什么(播客准备中、本期播完、节目单还没生成好、在连、连不上)。
 * 电台本身(Aiboo 云端)一行没改;这里只管「写什么」。
 */

export interface NowPlayingItem {
  kind: 'track' | 'tts';
  queue_item_id: string;
  title?: string;
  artist?: string;
  role?: string;
  text?: string;
  duration_ms: number;
}

export interface NowPlayingInput {
  mode: string;
  status: 'idle' | 'connecting' | 'connected' | 'error';
  playing: NowPlayingItem | null;
  segment?: { title?: string } | null;
  topics?: readonly { id: string; title: string }[];
  currentTopicId?: string | null;
}

export interface NowPlayingText {
  title: string;
  sub: string;
  /** 这会儿真有东西在放(进度那一行才有意义)。 */
  live: boolean;
}

export const MODE_LABELS: readonly { key: string; label: string }[] = [
  { key: 'focus', label: '音乐' },
  { key: 'commute', label: '播客' },
];

function spoken(item: NowPlayingItem): string {
  const text = (item.text ?? '').trim();
  const role = (item.role ?? '').trim();
  if (text === '') return role;
  return role === '' ? text : `${role}:${text}`;
}

export function nowPlayingText(input: NowPlayingInput): NowPlayingText {
  const commute = input.mode === 'commute';
  const item = input.playing;
  if (item !== null) {
    if (item.kind === 'track') {
      const title = (item.title ?? '').trim();
      return { title: title === '' ? '在放' : title, sub: (item.artist ?? '').trim() || '—', live: true };
    }
    if (commute) {
      const topic = input.topics?.find((t) => t.id === input.currentTopicId);
      return { title: topic?.title ?? '通勤播客', sub: spoken(item), live: true };
    }
    return { title: `${(item.role ?? '').trim() || 'DJ'} 在说`, sub: (item.text ?? '').trim() || '—', live: true };
  }
  const sub = commute ? '播客' : '电台';
  if (input.status === 'error') return { title: '电台连不上', sub, live: false };
  if (input.status === 'connecting' || input.status === 'idle') return { title: '在连电台…', sub, live: false };
  const said = input.segment?.title?.trim();
  if (said !== undefined && said !== '') return { title: said, sub, live: false };
  return { title: commute ? '今天的播客还没准备好' : '今天的节目单还没生成好', sub, live: false };
}
