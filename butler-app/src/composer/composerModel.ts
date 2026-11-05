/**
 * 统一输入框的纯函数(2026-09-24,docs/设计-统一输入框-2026-09-24.md 第三节)——**手机那一份**。
 *
 * 电脑那份在 workbench-plugin/src/client/composer/composerModel.ts,两端不互相 import(AGENTS.md),
 * 口径一致:TRIMS 四档、isSendKey、atQuery、itemBody。改一边要同步另一边。
 */
import type { ComposerAgentView, ComposerMode, ComposerOptionsView, ComposerUploadView } from '../api/protocol';

export type ComposerTrim = 'onboarding' | 'butler' | 'phone-home' | 'call';

export interface TrimSpec {
  plus: boolean;
  at: boolean;
  mode: boolean;
  model: boolean;
  voice: boolean;
  pillsMerged: boolean;
}

export const TRIMS: Readonly<Record<ComposerTrim, TrimSpec>> = {
  onboarding: { plus: false, at: false, mode: false, model: false, voice: false, pillsMerged: false },
  butler: { plus: true, at: true, mode: true, model: true, voice: false, pillsMerged: false },
  'phone-home': { plus: true, at: true, mode: true, model: true, voice: true, pillsMerged: true },
  call: { plus: false, at: false, mode: false, model: false, voice: false, pillsMerged: false },
};

export function isSendKey(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && event.isComposing !== true && event.keyCode !== 229;
}

export function atQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return undefined;
  if (at > 0 && !/\s/.test(before[at - 1] as string)) return undefined;
  const query = before.slice(at + 1);
  if (/\s/.test(query) || query.length > 20) return undefined;
  return { start: at, query };
}

export function dropAtQuery(text: string, start: number, caret: number): string {
  return `${text.slice(0, start)}${text.slice(caret)}`.replace(/^\s+/, '');
}

export function filterAgents(agents: readonly ComposerAgentView[], query: string): ComposerAgentView[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...agents];
  return agents.filter((one) => one.title.toLowerCase().includes(q) || one.family.includes(q));
}

// 「后台」不说「命令行」(卡 O,09-25 维护者设计原则:界面上不出现「命令行」「CLI」)。
const HAND_WORDS = { window: '窗口', cli: '后台', api: '接口' } as const;

export function handLine(agent: ComposerAgentView): string {
  if (agent.family === 'dsh') return '不 @ 就是它';
  const ready = agent.hands.filter((one) => one.ready);
  if (ready.length === 0) return agent.hands.map((one) => one.why ?? `${HAND_WORDS[one.hand]}用不了`).join(';');
  return ready.map((one, index) => (index === 0 ? HAND_WORDS[one.hand] : `${HAND_WORDS[one.hand]}(备用)`)).join(' · ');
}

export interface DraftAttachment {
  key: string;
  name: string;
  image: boolean;
  preview?: string;
  view?: ComposerUploadView;
  error?: string;
}

export interface DraftRef {
  kind: 'item' | 'project';
  id: string;
  title: string;
}

export interface ComposerDraft {
  text: string;
  agent?: { family: ComposerAgentView['family']; title: string; ready?: boolean; why?: string };
  attachments: readonly DraftAttachment[];
  refs: readonly DraftRef[];
}

export function canSend(draft: ComposerDraft): boolean {
  if (draft.agent?.ready === false) return false;
  if (draft.attachments.some((one) => one.view === undefined && one.error === undefined)) return false;
  return draft.text.trim() !== '' || draft.attachments.some((one) => one.view !== undefined);
}

/** 有没有片(谁来办、附件、引用)。 */
export function hasChips(draft: ComposerDraft): boolean {
  return draft.agent !== undefined || draft.attachments.length > 0 || draft.refs.length > 0;
}

/**
 * 右下角那颗键此刻是什么 —— **手机首页独有**,电脑那份没有这一条(2026-09-24,卡 feat/phone-composer-call-slot)。
 * 维护者原话:「参考 codex 的做法,在输入框里没有内容的时候,发送按钮就是通话按钮……检测到输入文字就变回可发送的那个按钮」。
 *   - 没内容(没字、没附件、没片)→ 通话;只打了空格也算没内容;
 *   - 有内容 → 发送(能不能点另由 canSend 管:附件还在传、只有一枚 @ 片时是灰的);
 *   - 正在发 → 发送(那颗键上显示「···」,别在路上变成通话键);
 *   - 外面没给通话入口(通话页、引导页)→ 永远是发送。
 */
export function actionKeyOf(draft: ComposerDraft, opts: { call: boolean; sending: boolean }): 'call' | 'send' {
  if (!opts.call || opts.sending) return 'send';
  return draft.text.trim() === '' && !hasChips(draft) ? 'call' : 'send';
}

/** 打了一半字又按住说:打的字在前、说的话在后,一起发(两样都不丢)。 */
export function joinSaid(typed: string, said: string): string {
  const head = typed.trim();
  return head === '' ? said : `${head} ${said}`;
}

export function itemBody(draft: ComposerDraft): Record<string, unknown> {
  const uploaded = draft.attachments.filter((one) => one.view !== undefined).map((one) => ({ id: (one.view as ComposerUploadView).id }));
  return {
    text: draft.text.trim(),
    ...(draft.agent === undefined || draft.agent.family === 'dsh' || draft.agent.ready === false ? {} : { assignee: draft.agent.family }),
    ...(uploaded.length === 0 ? {} : { attachments: uploaded }),
    ...(draft.refs.length === 0 ? {} : { refs: draft.refs.map((ref) => ({ kind: ref.kind, id: ref.id })) }),
  };
}

export function modeTitle(options: ComposerOptionsView | undefined, mode: ComposerMode | undefined): string {
  const id = mode ?? options?.mode ?? 'ask';
  return options?.modes.find((one) => one.id === id)?.title ?? (id === 'plan' ? '只出方案' : id === 'auto' ? '自动办' : '先问我');
}

export function uploadName(file: { name: string; type: string }, now: Date = new Date()): string {
  const name = file.name.trim();
  if (name !== '' && name !== 'image.png' && name !== 'image.jpg') return name;
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : file.type === 'image/gif' ? 'gif' : 'png';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `截图-${stamp}.${ext}`;
}

export function filesOf(list: { length: number; item: (index: number) => File | null } | null | undefined): File[] {
  if (list === null || list === undefined) return [];
  const out: File[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const file = list.item(i);
    if (file !== null) out.push(file);
  }
  return out;
}
