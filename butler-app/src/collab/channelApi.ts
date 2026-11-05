/**
 * 协作频道投影(2026-10-24,卡「完整手机协作下级页」,小K)。
 *
 * 频道是事务官们的聊天室(资讯/日报/周报),人类**只读**:这里没有发送框,只有读。
 * 数据来自 `GET /collab/relay/studio` 与 `GET /collab/relay/channel?id=`(真实端点,
 * 局域网直连可用;经房间白名单未放行,失败如实摆)。成员发现走的是中转工作室名单 ——
 * **局域网成员发现底座当前不存在**(core 小K 的 F 在核/补),这里不冒称 LAN 发现。
 *
 * 身份:显示名(nick)与稳定身份(account + device)分开摆;改名不丢关联是服务端的
 * 稳定 id 机制,界面只如实显示两端。
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 消息话题(与工作台 `CHANNEL_MESSAGE_KINDS` 同表;say 在聊天室里按「资讯」读)。 */
export const CHANNEL_KIND_TITLES: Readonly<Record<string, string>> = {
  say: '资讯',
  daily: '日报',
  weekly: '周报',
  status: '状态',
  system: '系统',
};

export interface StudioMemberRow {
  accountId: string;
  nick?: string;
  role?: string;
  devices?: readonly string[];
}

export interface StudioChannelRow {
  id: string;
  name: string;
  kind: string;
  version: number;
  projectName?: string;
}

export type StudioView =
  | { state: 'unwired'; why?: string }
  | { state: 'offline'; why?: string }
  | { state: 'none' }
  | { state: 'joined'; workspaceName?: string; members: readonly StudioMemberRow[]; channels: readonly StudioChannelRow[] }
  | { state: 'unknown' };

/** `GET /collab/relay/studio` 的回包 → 四态视图;认不出的按 unknown,不编造。 */
export function projectStudio(data: unknown): StudioView {
  if (!isRecord(data) || !isStr(data.state)) return { state: 'unknown' };
  switch (data.state) {
    case 'unwired':
    case 'offline':
      return { state: data.state, ...(isStr(data.why) ? { why: data.why } : {}) };
    case 'none':
      return { state: 'none' };
    case 'joined': {
      const members: StudioMemberRow[] = [];
      if (Array.isArray(data.members)) {
        for (const m of data.members) {
          if (isRecord(m) && isStr(m.account_id)) {
            members.push({
              accountId: m.account_id,
              ...(isStr(m.nick) ? { nick: m.nick } : {}),
              ...(isStr(m.role) ? { role: m.role } : {}),
              ...(Array.isArray(m.devices) ? { devices: m.devices.filter(isStr) } : {}),
            });
          }
        }
      }
      const channels: StudioChannelRow[] = [];
      if (Array.isArray(data.channels)) {
        for (const c of data.channels) {
          if (isRecord(c) && isStr(c.id) && isStr(c.name)) {
            channels.push({
              id: c.id, name: c.name, kind: isStr(c.kind) ? c.kind : 'workspace',
              version: typeof c.version === 'number' ? c.version : 0,
              ...(isRecord(c.project) && isStr(c.project.name) ? { projectName: c.project.name } : {}),
            });
          }
        }
      }
      return {
        state: 'joined',
        ...(isRecord(data.workspace) && isStr(data.workspace.name) ? { workspaceName: data.workspace.name } : {}),
        members, channels,
      };
    }
    default:
      return { state: 'unknown' };
  }
}

export interface ChannelRefRow {
  objectId: string;
  kind: string;
  title?: string;
}

export interface ChannelMessageRow {
  id: string;
  seq: number;
  kind: string;
  kindTitle: string;
  /** 发送者显示名(花名;可能是「企微·xxx」)。 */
  authorName: string;
  /** 稳定身份:account · device;事务官代发会标出来。 */
  identity: string;
  butler: boolean;
  at: string;
  text: string;
  retracted: boolean;
  refs: readonly ChannelRefRow[];
  replyToText?: string;
  via?: string;
}

export interface ChannelView {
  id: string;
  name: string;
  version: number;
  messages: readonly ChannelMessageRow[];
}

/**
 * `GET /collab/relay/channel` 的快照 → 消息流(升序 = 先说的在前,聊天室阅读习惯)。
 * 撤回的消息折成「已撤回」;坏消息跳过;`reply_to` 用同快照里的原文对回来(对不上只留序号)。
 */
export function messageRows(data: unknown): ChannelView {
  const empty: ChannelView = { id: '', name: '', version: 0, messages: [] };
  if (!isRecord(data) || !isRecord(data.channel)) return empty;
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  const byId = new Map<string, unknown>();
  for (const m of rawMessages) {
    if (isRecord(m) && isStr(m.id)) byId.set(m.id, m);
  }
  const rows: ChannelMessageRow[] = [];
  for (const m of rawMessages) {
    if (!isRecord(m) || !isStr(m.id) || !isRecord(m.author)) continue;
    const author = m.author;
    const nick = isStr(author.nick) ? author.nick : (isStr(author.person) ? author.person : '未知');
    const person = isStr(author.person) ? author.person : '';
    const device = isStr(author.device) ? author.device : '';
    const retracted = isRecord(m.retracted) || m.text === '';
    const kind = isStr(m.kind) ? m.kind : 'say';
    const refs: ChannelRefRow[] = [];
    if (Array.isArray(m.refs)) {
      for (const r of m.refs) {
        if (isRecord(r) && isStr(r.object_id)) {
          refs.push({ objectId: r.object_id, kind: isStr(r.kind) ? r.kind : '', ...(isStr(r.title) ? { title: r.title } : {}) });
        }
      }
    }
    let replyToText: string | undefined;
    if (isStr(m.reply_to)) {
      const target = byId.get(m.reply_to);
      if (isRecord(target) && isStr(target.text)) replyToText = target.text;
    }
    rows.push({
      id: m.id,
      seq: typeof m.seq === 'number' ? m.seq : rows.length + 1,
      kind,
      kindTitle: CHANNEL_KIND_TITLES[kind] ?? kind,
      authorName: nick,
      identity: [person, device].filter((s) => s !== '').join(' · '),
      butler: author.butler === true,
      at: isStr(m.at) ? m.at : '',
      text: retracted ? '已撤回' : (isStr(m.text) ? m.text : ''),
      retracted,
      refs,
      ...(replyToText === undefined ? {} : { replyToText }),
      ...(isStr(m.via) ? { via: m.via } : {}),
    });
  }
  rows.sort((a, b) => a.seq - b.seq);
  return {
    id: isStr(data.channel.id) ? data.channel.id : '',
    name: isStr(data.channel.name) ? data.channel.name : '',
    version: typeof data.channel.version === 'number' ? data.channel.version : 0,
    messages: rows,
  };
}
