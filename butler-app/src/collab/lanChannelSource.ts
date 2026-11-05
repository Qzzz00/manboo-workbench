import type { LanChannelMessage, LanChannelSourceScope } from '../api/protocol';
import { guardDelivery, type RawDelivery } from './collabCore';

// 新公共字段随core唯一源到位；候选期不在手机声明第二份协议。
export type Publication = Required<Pick<LanChannelMessage, 'category' | 'topic' | 'source' | 'refs'>>;
export type SourceScope = LanChannelSourceScope;
export interface LanMessageRow {
  id: string; authorId: string; authorName: string; text: string; at: string; report: boolean;
  replyTo?: string; deliveries: readonly RawDelivery[]; publication?: Publication;
}
export interface LanChannelSnapshot { rows: LanMessageRow[]; sourceScope?: SourceScope }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const optionalString = (v: unknown) => v === undefined || str(v);
export const CATEGORY_TITLES = { news: '资讯', daily: '日报', weekly: '周报' } as const;
export function safeSourceUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}
function publication(v: unknown): v is Record<string, unknown> & Publication {
  if (!record(v) || !Object.hasOwn(CATEGORY_TITLES, String(v.category)) || !record(v.topic) || !str(v.topic.id) || !str(v.topic.title)
    || !record(v.source) || !str(v.source.id) || !str(v.source.recorded_at) || !Array.isArray(v.refs)) return false;
  const source = v.source;
  if (v.category === 'news' ? source.kind !== 'feed' || source.scope !== 'project-feed'
    : source.kind !== 'project-report' || source.scope !== 'local-project-records' || !record(source.period) || !str(source.period.from) || !str(source.period.to)) return false;
  if (source.period !== undefined && (!record(source.period) || !str(source.period.from) || !str(source.period.to))) return false;
  if (!optionalString(source.url) || !optionalString(source.publisher) || !optionalString(source.published_at)) return false;
  return v.refs.every(ref => record(ref) && (ref.kind === 'url' || ref.kind === 'task') && str(ref.id) && str(ref.title) && optionalString(ref.url));
}
function sourceScope(v: unknown): v is SourceScope {
  return record(v) && ['unwired', 'empty', 'ready', 'unknown'].includes(String(v.news)) && ['unknown', 'ready'].includes(String(v.reports))
    && v.peer_sources === 'paired-origin-claims' && typeof v.publication_enabled === 'boolean'
    && (v.notes === undefined || Array.isArray(v.notes) && v.notes.every(str));
}
/** transport/project与正式快照边界只读守卫；坏快照不降成假普通消息。 */
export function readLanChannel(data: unknown, projectId: string): LanChannelSnapshot | undefined {
  if (!record(data) || data.transport !== 'lan' || data.scope !== 'known-paired-members' || !Array.isArray(data.messages)) return undefined;
  const rows: LanMessageRow[] = [];
  for (const message of data.messages) {
    if (!record(message) || message.project_id !== projectId || !str(message.id) || !str(message.text) || !str(message.at)
      || !record(message.author) || !str(message.author.member_id) || !str(message.author.name) || (message.kind !== 'message' && message.kind !== 'report')) return undefined;
    const hasSnapshot = ['category', 'topic', 'source', 'refs'].some(field => Object.hasOwn(message, field));
    if (hasSnapshot && (message.kind !== 'message' || !publication(message))) return undefined;
    rows.push({ id: message.id, authorId: message.author.member_id, authorName: message.author.name, text: message.text, at: message.at, report: message.kind === 'report',
      ...(str(message.reply_to) ? { replyTo: message.reply_to } : {}),
      deliveries: Array.isArray(message.deliveries) ? message.deliveries.map(guardDelivery).filter((d): d is RawDelivery => d !== undefined) : [],
      ...(publication(message) ? { publication: { category: message.category, topic: message.topic, source: message.source, refs: message.refs } } : {}),
    });
  }
  return { rows, ...(sourceScope(data.source_scope) ? { sourceScope: data.source_scope } : {}) };
}
