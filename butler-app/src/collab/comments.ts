/**
 * 协作区留言 / 邀请(2026-10-24,小K,阶段 2:接 core 真实投递口)。
 *
 * 设计口径(10-23 设计交接 3.6 + core 契约 §2):普通留言默认**只留记录**;
 * @ 名片 / 成员且选「请它处理」= 明确「谁会来处理什么」——服务端逐 mention 出真实投递状态
 * (me 即达 / 名片已受理待处理 / 找不到对象即失败带 `unknown target` 原因,不当作已邀请;
 * 回执按准确 message_id 对账,受理不冒处理完成)。**投递与成果回执分开。**
 *
 * 投递走待发箱:先落盘再发;断网暂存、恢复补发;`client_msg_id` 由这里生成并随 body 落盘,
 * 服务端按它幂等 —— 补发/重试不重复留言、不重复派活。
 */
import { registerOutboxClassifier } from '../outbox/sendOutbox';

/** 留言 / 邀请投递的工作台路径(core 真实口;局域网直连可用,外出走待发箱暂存)。 */
export const MESSAGE_PATH = '/collab/note/message';

/**
 * 留言分类器:在外出那条路上,「只在电脑边才有」的那一句(kind=unavailable)是**没到电脑**,
 * 按「没送到」暂存、回家自动补发;4xx(ask 没带对象 / 便签不在)是电脑说不行,留原话不自动补。
 */
registerOutboxClassifier(MESSAGE_PATH, (result) => {
  if (result.ok) return { kind: 'delivered', data: result.data };
  if (result.kind === 'network' || result.kind === 'unavailable' || result.kind === 'unauthorized' || result.status >= 500) {
    return { kind: 'unsent', error: result.error };
  }
  return { kind: 'rejected', error: result.error };
});

export type CommentIntent = 'record' | 'ask';

export const COMMENT_INTENTS: readonly { key: CommentIntent; label: string }[] = [
  { key: 'record', label: '只留记录' },
  { key: 'ask', label: '请它处理' },
];

export function intentLine(intent: CommentIntent): string {
  return intent === 'record'
    ? '这条只留记录,不派活'
    : '请它处理:发给 @ 的名片,逐个回投递状态(受理/送达/处理/失败)';
}

export type ComposeResult =
  | { ok: true; body: { task_id: string; client_msg_id: string; text: string; intent: CommentIntent; mentions: string[] }; display: string }
  | { ok: false; error: string };

function newMsgId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 组织一条留言 / 邀请:
 * - 从草稿里认 `@名字`(按名片显示名**最长先匹配**),认出的进 `mentions`(名片 id);
 * - 有 `@` 而认不出 → 拒发,点名哪个名字不认得(未知名字不当成功邀请);
 * - `ask` 必须至少一个 mention(请谁处理要明说);`record` 允许不带 mention。
 */
export function composeComment(
  taskId: string,
  draft: string,
  cards: Readonly<Record<string, string>>,
  intent: CommentIntent,
  nowDraft?: { clientMsgId?: string; pickedIds?: readonly string[] },
): ComposeResult {
  const text = draft.trim();
  if (text === '') return { ok: false, error: '还没写字' };
  const mentions: string[] = [];
  const names = Object.entries(cards).sort((a, b) => b[1].length - a[1].length);
  let rest = text;
  for (;;) {
    const at = rest.indexOf('@');
    if (at < 0) break;
    let matched: { id: string; name: string } | undefined;
    for (const [id, name] of names) {
      if (rest.startsWith(`@${name}`, at) && (rest.length === at + name.length + 1 || /[\s@，。！？、；：,.;:!?()（）\[\]{}]/u.test(rest[at + name.length + 1]))) { matched = { id, name }; break; }
    }
    if (matched === undefined) {
      const tail = rest.slice(at + 1);
      const stop = tail.search(/[\s@]/);
      const word = stop < 0 ? tail : tail.slice(0, stop);
      return { ok: false, error: `认不出「${word}」是谁 —— 从名片里选,别手敲` };
    }
    const sameName = names.filter(([, name]) => name === matched.name);
    const picked = sameName.filter(([id]) => nowDraft?.pickedIds?.includes(id));
    if (sameName.length > 1 && picked.length === 0) return { ok: false, error: `「${matched.name}」对应多张名片,请从名片列表按稳定身份选择` };
    for (const [id] of picked.length > 0 ? picked : sameName) if (!mentions.includes(id)) mentions.push(id);
    rest = rest.slice(at + 1 + matched.name.length);
  }
  if (intent === 'ask' && mentions.length === 0) {
    return { ok: false, error: '「请它处理」要先 @ 一个名片 —— 说清谁会来处理' };
  }
  return {
    ok: true,
    body: {
      task_id: taskId,
      client_msg_id: nowDraft?.clientMsgId ?? newMsgId(),
      text,
      intent,
      mentions,
    },
    display: text,
  };
}
