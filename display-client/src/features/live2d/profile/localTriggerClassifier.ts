// v2/v3 profile 本地关键词触发器 + 清除意图识别。
// 纯函数模块：无副作用、不依赖全局状态；仅输出诊断日志用于定位误触发。

import type { CostumeSlot } from './types.ts';
import type { V2ExpressionItem, V2Profile } from './v2Types.ts';

export interface LocalTriggerInput {
  userText: string;
  replyText: string;
  v2Profile: V2Profile;
  /**
   * 当前已激活的 costume slot 列表。用于"上下文无指代移除"兜底：
   * 当文本中出现 CLEAR_VERB 但没有命中任何具体 costume 关键词时，
   * 若此列表非空，则视为要清除所有已激活的 slot（如"把它收起来"）。
   */
  activeCostumeSlots?: CostumeSlot[];
  /**
   * 最近被清除的 costume slot 列表（按时间倒序，最近在最前）。
   * 用于"再看看"这类无明确物品名的复穿请求：若当前没有激活 slot，
   * 但用户表达了重复/再次查看的意图，则重新触发最近脱下的装扮。
   */
  recentClearedCostumeSlots?: CostumeSlot[];
  /**
   * 最近被设置（穿上）的 costume slot 列表（按时间倒序，最近在最前）。
   * 用于"换回去"这类无明确物品名的还原请求：清除最近一次的换装，
   * 而不是把身上所有 costume 都清掉。
   */
  recentSetCostumeSlots?: CostumeSlot[];
}

export interface LocalTriggerHit {
  slot: 'motion' | 'expression' | CostumeSlot;
  id?: string;
  keyword?: string;
  expressionId?: string;
  hitKeywords?: string[];
  verb?: string;
  intent?: 'set' | 'clear';
  score?: number;
  fromUser?: boolean;
  source?: 'user' | 'reply' | 'both';
}

export interface LocalTriggerResult {
  motionId?: string;
  expressionId?: string;
  /** 需要主动清除的 costume slot 列表。 */
  clearSlots?: CostumeSlot[];
  reasons: LocalTriggerHit[];
}

export interface ProseTriggerResult {
  motionId?: string;
  expressionId?: string;
}

/** 取消/移除动词表。只要出现在 keyword 前 ≤4 字符窗口内，即视为清除意图。
 * 长词优先，确保「脱掉」先于「脱」命中，日志更准。 */
const CLEAR_VERBS = [
  '搁在一边',
  '收起来', '放一边',
  '脱', '摘', '取下', '拿下', '卸下', '放下', '解下', '扔', '摘掉', '脱掉', '脱下', '取走',
  '去掉', '拿掉', '摘下', '收起', '搁下', '松开', '松手', '放手',
  '不戴', '不穿', '不拿', '不抱', '移除', '取消', '丢了',
].sort((a, b) => b.length - a.length);

type KeywordTable = Record<string, string[]>;

function isTriggerEnabled(item: { triggerEnabled?: boolean }): boolean {
  return item.triggerEnabled !== false;
}

function buildKeywordTable(items: { id: string; hint?: string; keywords?: string[] }[]): KeywordTable {
  const table: KeywordTable = {};
  for (const item of items) {
    if (item.keywords && item.keywords.length > 0) {
      table[item.id] = item.keywords;
    } else if (item.hint) {
      // keywords 缺省时用 hint 兜底（hint 即逐文件校验时写的中文说明），
      // 否则启用了触发的条目本地分类器永远命中不了。
      const derived = extractMatchKeywords({ id: item.id, hint: item.hint });
      if (derived.length > 0) table[item.id] = derived;
    }
  }
  return table;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function collectHits(text: string, keywords: string[]): { count: number; hits: string[] } {
  const hits = new Set<string>();
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) {
      hits.add(keyword);
      count += 1;
    }
  }
  return { count, hits: [...hits] };
}

function scoreSlot(
  table: KeywordTable,
  allowedIds: Set<string>,
  userText: string,
  replyText: string,
  slot: 'motion' | 'expression',
): { bestId: string | undefined; bestScore: number; bestFromUser: boolean; reasons: LocalTriggerHit[] } {
  let bestId: string | undefined;
  let bestScore = 0;
  let bestFromUser = false;
  const reasons: LocalTriggerHit[] = [];

  for (const [id, keywords] of Object.entries(table)) {
    if (!allowedIds.has(id)) continue;

    const userHits = collectHits(userText, keywords);
    const replyHits = collectHits(replyText, keywords);
    const userScore = userHits.count * 3;
    const replyScore = replyHits.count * 1;
    const score = userScore + replyScore;

    if (score <= 0) continue;

    const hitKeywords = Array.from(new Set([...userHits.hits, ...replyHits.hits]));
    const fromUser = userScore >= replyScore;

    reasons.push({
      slot,
      id,
      hitKeywords,
      score,
      fromUser,
      intent: 'set',
    });

    if (score > bestScore) {
      bestScore = score;
      bestId = id;
      bestFromUser = fromUser;
    }
  }

  return { bestId, bestScore, bestFromUser, reasons };
}

function findOccurrences(text: string, keyword: string): number[] {
  const indices: number[] = [];
  let pos = 0;
  while ((pos = text.indexOf(keyword, pos)) !== -1) {
    indices.push(pos);
    pos += 1;
  }
  return indices;
}

function findClearVerb(text: string, keywordIndex: number, maxLookback = 4): { hit: false } | { hit: true; verb: string } {
  const start = Math.max(0, keywordIndex - maxLookback);
  const window = text.slice(start, keywordIndex);
  for (const verb of CLEAR_VERBS) {
    if (window.includes(verb)) {
      return { hit: true, verb };
    }
  }
  return { hit: false };
}

function findClearVerbAfter(text: string, keywordEndIndex: number, maxLookahead = 4): { hit: false } | { hit: true; verb: string } {
  const end = Math.min(text.length, keywordEndIndex + maxLookahead);
  const window = text.slice(keywordEndIndex, end);
  for (const verb of CLEAR_VERBS) {
    if (window.includes(verb)) {
      return { hit: true, verb };
    }
  }
  return { hit: false };
}

function detectClearVerbAround(
  text: string,
  keywordIndex: number,
  keywordLength: number,
  maxDistance = 4,
): { hit: false } | { hit: true; verb: string; position: 'before' | 'after' } {
  const before = findClearVerb(text, keywordIndex, maxDistance);
  if (before.hit) {
    return { hit: true, verb: before.verb, position: 'before' };
  }
  const after = findClearVerbAfter(text, keywordIndex + keywordLength, maxDistance);
  if (after.hit) {
    return { hit: true, verb: after.verb, position: 'after' };
  }
  return { hit: false };
}

function getCostumeItemsBySlot(profile: V2Profile): Map<CostumeSlot, V2ExpressionItem> {
  const map = new Map<CostumeSlot, V2ExpressionItem>();
  for (const item of profile.expression.items) {
    if (
      item.category === 'costume' &&
      item.slot &&
      !map.has(item.slot) &&
      isTriggerEnabled(item) &&
      item.kind !== 'disabled' &&
      item.kind !== 'pending'
    ) {
      map.set(item.slot, item);
    }
  }
  return map;
}

/** 穿戴/装备动词表。用于识别"穿上丝袜"这类针对 defaultWorn costume 的还原请求。
 * 长词优先，确保「穿上」先于「穿」命中。 */
const WEAR_VERBS = [
  '穿上', '戴上', '换上', '披上', '套上', '穿起', '穿着', '穿戴', '换', '穿', '戴',
].sort((a, b) => b.length - a.length);

function findWearVerb(text: string, keywordIndex: number, maxLookback = 4): { hit: false } | { hit: true; verb: string } {
  const start = Math.max(0, keywordIndex - maxLookback);
  const window = text.slice(start, keywordIndex);
  for (const verb of WEAR_VERBS) {
    if (window.includes(verb)) {
      return { hit: true, verb };
    }
  }
  return { hit: false };
}

function findWearVerbAfter(text: string, keywordEndIndex: number, maxLookahead = 4): { hit: false } | { hit: true; verb: string } {
  const end = Math.min(text.length, keywordEndIndex + maxLookahead);
  const window = text.slice(keywordEndIndex, end);
  for (const verb of WEAR_VERBS) {
    if (window.includes(verb)) {
      return { hit: true, verb };
    }
  }
  return { hit: false };
}

function findWearVerbAround(
  text: string,
  keywordIndex: number,
  keywordLength: number,
  maxDistance = 4,
): { hit: false } | { hit: true; verb: string; position: 'before' | 'after' } {
  const before = findWearVerb(text, keywordIndex, maxDistance);
  if (before.hit) {
    return { hit: true, verb: before.verb, position: 'before' };
  }
  const after = findWearVerbAfter(text, keywordIndex + keywordLength, maxDistance);
  if (after.hit) {
    return { hit: true, verb: after.verb, position: 'after' };
  }
  return { hit: false };
}

function isDefaultWorn(item: V2ExpressionItem): boolean {
  return item.defaultWorn === true;
}

function findAnyClearVerb(text: string): { verb: string } | null {
  for (const verb of CLEAR_VERBS) {
    if (text.includes(verb)) {
      return { verb };
    }
  }
  return null;
}


const CLEAR_ALL_PHRASES = [
  '换回原来的样子',
  '换回原来',
  '恢复原样',
  '回到默认',
  '全部脱掉',
  '都脱掉',
  '全都脱',
];

function detectClearAllIntent(userText: string): boolean {
  return CLEAR_ALL_PHRASES.some((phrase) => userText.includes(phrase));
}

/** 换装/服饰还原请求：用户用自然语言让角色"换回去""换回来""换回原来的样子"等。
 *  优先按 phrase 中的 costume keyword 定位到具体 slot；没有具体 keyword 时清除所有激活 slot。 */
const REVERT_MARKERS = ['回去', '回来', '换回原来', '换回原本', '换回初始', '换回默认', '换回'];
const REVERT_PHRASES = [
  '换回原来的样子',
  '换回原来',
  '换回原本',
  '恢复原来',
  '恢复原本',
  '恢复原样',
  '回到默认',
  '回到原来',
  '换回去',
  '换回来',
  '换回初始',
  '换回默认',
  '还是原来的',
];

function detectRevertIntent(
  userText: string,
  v2Profile: V2Profile,
  activeCostumeSlots: CostumeSlot[] = [],
  recentSetCostumeSlots: CostumeSlot[] = [],
): { clearSlots: CostumeSlot[]; reasons: LocalTriggerHit[] } | null {
  const activeSlots = new Set<CostumeSlot>(activeCostumeSlots);
  const costumeItemsBySlot = getCostumeItemsBySlot(v2Profile);

  // 1) 先看是否 phrase 里夹带了具体 costume keyword，有则只清该 slot。
  //    例如"换装回去"→ outfit，"外套换回来"→ outerwear。
  for (const [slot, item] of costumeItemsBySlot) {
    for (const keyword of item.keywords ?? []) {
      if (!userText.includes(keyword)) continue;
      for (const marker of REVERT_MARKERS) {
        if (userText.includes(marker)) {
          if (!activeSlots.has(slot)) continue;
          console.info(`[trigger:local] revert intent: keyword=${keyword}, slot=${slot}, marker=${marker}`);
          return {
            clearSlots: [slot],
            reasons: [{
              slot,
              keyword,
              intent: 'clear',
              source: 'user',
              verb: marker,
            }],
          };
        }
      }
    }
  }

  // 2) 衣物类泛化词 + revert marker → 清所有 active 的衣物 slot，不动手持道具。
  //    覆盖"把衣服换回去""这身服装换回来"等自然表达。
  const CLOTHING_SLOTS: CostumeSlot[] = ['outfit', 'outerwear', 'headwear', 'legwear'];
  const clothingTerms = ['衣服', '服装', '衣裳', '衣物', '睡衣', '常服'];
  for (const term of clothingTerms) {
    if (!userText.includes(term)) continue;
    for (const marker of REVERT_MARKERS) {
      if (!userText.includes(marker)) continue;
      const slots = activeCostumeSlots.filter((s) => CLOTHING_SLOTS.includes(s));
      if (slots.length > 0) {
        console.info(`[trigger:local] revert-clothing intent: term=${term}, slots=${slots.join(',')}`);
        return {
          clearSlots: slots,
          reasons: slots.map((slot) => ({
            slot,
            intent: 'clear',
            source: 'user',
            verb: `${term}${marker}`,
          })),
        };
      }
    }
  }

  // 3) 没有具体 keyword 的通用还原 phrase：优先清最近设置过的 active slot，
  //    而不是把身上所有 costume 全清。如果最近设置列表为空或都不 active，再回退到全清。
  for (const phrase of REVERT_PHRASES) {
    if (userText.includes(phrase)) {
      for (const slot of recentSetCostumeSlots) {
        if (activeSlots.has(slot)) {
          console.info(`[trigger:local] revert-recent intent: phrase=${phrase}, slot=${slot}`);
          return {
            clearSlots: [slot],
            reasons: [{
              slot,
              intent: 'clear',
              source: 'user',
              verb: phrase,
            }],
          };
        }
      }
      console.info(`[trigger:local] revert-all intent: phrase=${phrase}, slots=${activeCostumeSlots.join(',')}`);
      return {
        clearSlots: [...activeCostumeSlots],
        reasons: activeCostumeSlots.map((slot) => ({
          slot,
          intent: 'clear',
          source: 'user',
          verb: phrase,
        })),
      };
    }
  }

  return null;
}

function scanClearHits(
  text: string,
  source: 'user' | 'reply',
  v2Profile: V2Profile,
  clearSlots: Set<CostumeSlot>,
  reasons: LocalTriggerHit[],
): void {
  const costumeItemsBySlot = getCostumeItemsBySlot(v2Profile);
  for (const [slot, item] of costumeItemsBySlot) {
    // defaultWorn 项的清除/穿戴语义与普通 add 项相反：
    // "脱掉丝袜" 是要应用 expression，"穿上丝袜" 才是清除，交给专门逻辑处理。
    if (isDefaultWorn(item)) continue;
    const keywords = item.keywords ?? [];
    for (const keyword of keywords) {
      for (const index of findOccurrences(text, keyword)) {
        const found = detectClearVerbAround(text, index, keyword.length, 4);
        if (found.hit) {
          const isNew = !clearSlots.has(slot);
          clearSlots.add(slot);
          reasons.push({
            slot,
            keyword,
            verb: found.verb,
            intent: 'clear',
            source,
          });
          if (isNew) {
            console.info(`[trigger:local] clear from ${source}: slot=${slot}`);
          }
        }
      }
    }
  }
}

function detectClearIntent(
  userText: string,
  v2Profile: V2Profile,
  activeCostumeSlots: CostumeSlot[] = [],
  recentSetCostumeSlots: CostumeSlot[] = [],
): { clearSlots: CostumeSlot[]; reasons: LocalTriggerHit[] } {
  const reasons: LocalTriggerHit[] = [];
  const clearSlots = new Set<CostumeSlot>();
  const activeSlots = new Set<CostumeSlot>(activeCostumeSlots);

  // 1) 只从 userText 识别清除意图。回复文本里的"我放下了"是 LLM 自身的叙述，
  //    不能覆盖用户没有明确说清除的意图；否则"唱首歌"等场景会因 LLM 脑补的
  //    舞台指示/附和语句误清装扮。
  scanClearHits(userText, 'user', v2Profile, clearSlots, reasons);

  // 上下文无指代移除兜底：keyword-matched 清除完全没命中、且 userText 中出现 CLEAR_VERB。
  // 先按最近一次的换装记录（recentSetCostumeSlots）找仍在身的 slot，解决多件在身时
  // "放下吧"这类刚刚拿起某物就想放下的场景；没有 recentSet 或最近设置都不在身时，
  // 若只有一件 costume 在身则移除它。多件在身且无 recentSet 时不猜，交给 LLM 主通道。
  if (clearSlots.size === 0) {
    const userVerb = findAnyClearVerb(userText);
    if (userVerb) {
      // 兜底前再确认 userText 没有提及任何 costume keyword：
      // 若用户已针对具体装扮（如 defaultWorn 的"脱掉丝袜"），即使 keyword-matched
      // 清除没命中，也不应把 clear 动作转嫁到其它 slot（如 handheld 的娃娃）。
      const userHasCostumeKeyword = Array.from(getCostumeItemsBySlot(v2Profile).values()).some((item) =>
        (item.keywords ?? []).some((keyword) => userText.includes(keyword)),
      );
      if (!userHasCostumeKeyword) {
        let slot: CostumeSlot | undefined;
        for (const recentSlot of recentSetCostumeSlots) {
          if (activeSlots.has(recentSlot)) {
            slot = recentSlot;
            break;
          }
        }
        if (!slot && activeCostumeSlots.length === 1) {
          slot = activeCostumeSlots[0];
        }
        if (slot) {
          clearSlots.add(slot);
          reasons.push({
            slot,
            intent: 'clear',
            source: 'user',
            verb: userVerb.verb,
          });
          console.info(`[trigger:local] no-referent clear fallback: slot=${slot}`);
        }
      }
    }
  }

  return { clearSlots: Array.from(clearSlots), reasons };
}

/** 默认已穿戴的 costume（defaultWorn=true）意图识别。
 *  这类 expression 文件表示"脱掉/取消"该装扮（如默认穿丝袜，baisi 是去掉丝袜）。
 *  因此：
 *  - "脱/去掉/不" + keyword → set expression（应用脱掉状态）
 *  - "穿上/戴上" + keyword → clear slot（恢复默认穿戴）
 *  - 只有 keyword（如"白丝"）→ 视为 set expression（触发该状态） */
function detectDefaultWornIntent(
  userText: string,
  replyText: string,
  v2Profile: V2Profile,
  activeCostumeSlots: CostumeSlot[] = [],
): { expressionId: string | undefined; clearSlots: CostumeSlot[]; reasons: LocalTriggerHit[] } | null {
  const activeSlots = new Set<CostumeSlot>(activeCostumeSlots);
  const costumeItemsBySlot = getCostumeItemsBySlot(v2Profile);
  const matches: {
    slot: CostumeSlot;
    item: V2ExpressionItem;
    keyword: string;
    index: number;
    wearVerb: { hit: true; verb: string } | null;
    source: 'user' | 'reply';
  }[] = [];

  for (const [slot, item] of costumeItemsBySlot) {
    if (!isDefaultWorn(item)) continue;
    for (const keyword of item.keywords ?? []) {
      for (const [text, source] of [[userText, 'user'], [replyText, 'reply']] as const) {
        for (const index of findOccurrences(text, keyword)) {
          const wear = findWearVerbAround(text, index, keyword.length, 4);
          matches.push({
            slot,
            item,
            keyword,
            index,
            wearVerb: wear.hit ? { hit: true, verb: wear.verb } : null,
            source,
          });
        }
      }
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.index - b.index);
  const first = matches[0];

  if (first.wearVerb) {
    const reasons: LocalTriggerHit[] = [];
    const clearSlots: CostumeSlot[] = [];
    if (activeSlots.has(first.slot)) {
      clearSlots.push(first.slot);
      reasons.push({
        slot: first.slot,
        keyword: first.keyword,
        intent: 'clear',
        source: first.source,
        verb: first.wearVerb.verb,
      });
      console.info(`[trigger:local] defaultWorn restore: keyword=${first.keyword}, slot=${first.slot}`);
    }
    return { expressionId: undefined, clearSlots, reasons };
  }

  console.info(`[trigger:local] defaultWorn apply: keyword=${first.keyword}, slot=${first.slot}, item=${first.item.id}`);
  return {
    expressionId: first.item.id,
    clearSlots: [],
    reasons: [{
      slot: 'expression',
      id: first.item.id,
      keyword: first.keyword,
      expressionId: first.item.id,
      intent: 'set',
      source: first.source,
    }],
  };
}

function detectCostumeSet(
  userText: string,
  replyText: string,
  v2Profile: V2Profile,
): { expressionId: string | undefined; reasons: LocalTriggerHit[] } {
  const reasons: LocalTriggerHit[] = [];
  const costumeItemsBySlot = getCostumeItemsBySlot(v2Profile);

  // 收集所有不含 clear 动词的 costume keyword 命中，按文本出现位置排序。
  const matches: { slot: CostumeSlot; item: V2ExpressionItem; keyword: string; index: number }[] = [];
  for (const [slot, item] of costumeItemsBySlot) {
    if (isDefaultWorn(item)) continue;
    for (const keyword of item.keywords ?? []) {
      for (const text of [userText, replyText]) {
        for (const index of findOccurrences(text, keyword)) {
          if (!detectClearVerbAround(text, index, keyword.length, 4).hit) {
            matches.push({ slot, item, keyword, index });
          }
        }
      }
    }
  }

  // 取文本中最先出现的命中作为 set 结果。
  matches.sort((a, b) => a.index - b.index);
  const first = matches[0];
  if (first) {
    reasons.push({
      slot: 'expression',
      id: first.item.id,
      keyword: first.keyword,
      expressionId: first.item.id,
      intent: 'set',
    });
    return { expressionId: first.item.id, reasons };
  }

  return { expressionId: undefined, reasons };
}

/** 复穿/复看请求：用户没有说出具体物品名，但用"再""又""还"等词要求重做上一次的动作。
 *  例如脱下娃娃后说"再看看"，应重新穿上娃娃。 */
const REPEAT_REQUEST_MARKERS = ['再', '又', '还', '重新'];
const REPEAT_ACTION_HINTS = ['看', '穿', '戴', '拿', '抱', '试', '玩', '给', '展示', '亮'];

function looksLikeRepeatRequest(text: string): boolean {
  return REPEAT_REQUEST_MARKERS.some((marker) => text.includes(marker)) &&
    REPEAT_ACTION_HINTS.some((hint) => text.includes(hint));
}

function resolveRepeatRequest(
  userText: string,
  v2Profile: V2Profile,
  activeCostumeSlots: CostumeSlot[],
  recentClearedCostumeSlots: CostumeSlot[],
): { expressionId: string | undefined; reasons: LocalTriggerHit[] } {
  const reasons: LocalTriggerHit[] = [];
  if (!looksLikeRepeatRequest(userText)) return { expressionId: undefined, reasons };
  if (activeCostumeSlots.length > 0) return { expressionId: undefined, reasons };

  const costumeItemsBySlot = getCostumeItemsBySlot(v2Profile);
  for (const slot of recentClearedCostumeSlots) {
    const item = costumeItemsBySlot.get(slot);
    if (item) {
      console.info(`[trigger:local] repeat-request fallback: slot=${slot}, item=${item.id}`);
      reasons.push({
        slot: 'expression',
        id: item.id,
        expressionId: item.id,
        intent: 'set',
        source: 'user',
      });
      return { expressionId: item.id, reasons };
    }
  }
  return { expressionId: undefined, reasons };
}

export function classifyProfileTriggers(input: LocalTriggerInput): LocalTriggerResult {
  const userText = normalizeText(input.userText);
  const replyText = normalizeText(input.replyText);

  // 全局"回到基态"出口：命中即短路返回，不清除单个 item，只把已激活 slot 全部清掉。
  if (detectClearAllIntent(userText)) {
    console.info(`[trigger:local] clear-all intent hit: text="${input.userText.slice(0, 30)}"`);
    return {
      motionId: undefined,
      expressionId: undefined,
      clearSlots: [...(input.activeCostumeSlots ?? [])],
      reasons: [],
    };
  }

  // 过滤 disabled / pending 项：不参与 scoreSlot、detectCostumeSet、detectClearIntent。
  const motionItems = input.v2Profile.motion.items.filter(
    (item) => item.kind !== 'disabled' && item.kind !== 'pending',
  );
  const expressionItems = input.v2Profile.expression.items.filter(
    (item) => item.kind !== 'disabled' && item.kind !== 'pending',
  );
  const nonCostumeExpressionItems = expressionItems.filter((item) => item.category !== 'costume');

  const motionIds = new Set(motionItems.map((item) => item.id));
  const expressionIds = new Set(expressionItems.map((item) => item.id));
  const nonCostumeExpressionIds = new Set(nonCostumeExpressionItems.map((item) => item.id));

  const motion = scoreSlot(buildKeywordTable(motionItems), motionIds, userText, replyText, 'motion');
  const expression = scoreSlot(buildKeywordTable(expressionItems), expressionIds, userText, replyText, 'expression');
  const nonCostumeExpression = scoreSlot(
    buildKeywordTable(nonCostumeExpressionItems),
    nonCostumeExpressionIds,
    userText,
    replyText,
    'expression',
  );

  const clear = detectClearIntent(
    userText,
    input.v2Profile,
    input.activeCostumeSlots ?? [],
    input.recentSetCostumeSlots ?? [],
  );
  const revert = detectRevertIntent(
    userText,
    input.v2Profile,
    input.activeCostumeSlots ?? [],
    input.recentSetCostumeSlots ?? [],
  );
  const defaultWorn = detectDefaultWornIntent(
    userText,
    replyText,
    input.v2Profile,
    input.activeCostumeSlots ?? [],
  );

  // 还原/换装回去请求优先于 costume set：避免"换装回去"被识别成再穿一次 huanzhuang。
  // defaultWorn 项（如默认穿丝袜，baisi 表去掉丝袜）也优先处理，避免被普通 set/clear 逻辑覆盖。
  const costumeSet = (revert || defaultWorn?.expressionId)
    ? { expressionId: undefined, reasons: [] }
    : detectCostumeSet(userText, replyText, input.v2Profile);

  // costume set 优先于通用 expression 评分：保证装饰关键词触发对应 slot。
  // 非装饰类 expression 仍走 PR #94 的评分路径。
  let expressionId = defaultWorn?.expressionId ?? costumeSet.expressionId ?? nonCostumeExpression.bestId;

  // 若用户没有命中任何 costume keyword（如"再看看"），但表达了复穿/复看意图，
  // 且最近刚脱下有装扮，则重新触发该 slot 的默认 costume。
  if (!expressionId && !revert) {
    const repeat = resolveRepeatRequest(
      userText,
      input.v2Profile,
      input.activeCostumeSlots ?? [],
      input.recentClearedCostumeSlots ?? [],
    );
    if (repeat.expressionId) {
      expressionId = repeat.expressionId;
      costumeSet.reasons.push(...repeat.reasons);
    }
  }

  return {
    motionId: motion.bestId,
    expressionId,
    clearSlots: [
      ...clear.clearSlots,
      ...(revert?.clearSlots ?? []),
      ...(defaultWorn?.clearSlots ?? []),
    ],
    reasons: [
      ...motion.reasons,
      ...expression.reasons,
      ...costumeSet.reasons,
      ...clear.reasons,
      ...(revert?.reasons ?? []),
      ...(defaultWorn?.reasons ?? []),
    ],
  };
}

/** 从 item 的 hint / keywords / id 提取用于文本匹配的关键词集合。
 *  会去掉 hint 里的括号内容，并按常见分隔符拆分。
 */
function extractMatchKeywords(item: { id: string; hint: string; keywords?: string[] }): string[] {
  const cleanedHint = item.hint.replace(/[（(].*?[）)]/g, '').trim();
  const fromHint = cleanedHint
    ? cleanedHint.split(/[,，、/\\|]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const fromKeywords = (item.keywords ?? []).filter(Boolean);
  const all = [...fromHint, ...fromKeywords, item.id].map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(all));
}

/** 从回复正文的舞台指示（括号内容）或全文中推断 motion / expression。
 *  舞台指示优先级最高；未命中时再扫全文作为补充。
 *  仅用于 LLM 没有显式输出 motion/expression 时的第三层兜底。
 */
export function inferTriggersFromProse(
  text: string,
  v2Profile: V2Profile,
): ProseTriggerResult {
  const stageDirections = [...text.matchAll(/[（(]([^）)]+)[）)]/g)].map((m) => m[1]);
  const stageText = stageDirections.join(' ').toLowerCase();
  const fullText = text.toLowerCase();

  const result: ProseTriggerResult = {};

  function tryMatch(source: string) {
    if (!source.trim()) return;

    for (const item of v2Profile.expression.items) {
      if (result.expressionId) break;
      if (item.kind === 'disabled' || item.kind === 'pending') continue;
      const keywords = extractMatchKeywords(item);
      const idMatch = item.id && source.includes(item.id.toLowerCase());
      if (idMatch || keywords.some((kw) => source.includes(kw.toLowerCase()))) {
        result.expressionId = item.id;
      }
    }

    for (const item of v2Profile.motion.items) {
      if (result.motionId) break;
      if (item.loop) continue;
      if (item.kind === 'disabled' || item.kind === 'pending') continue;
      const keywords = extractMatchKeywords(item);
      const idMatch = item.id && source.includes(item.id.toLowerCase());
      if (idMatch || keywords.some((kw) => source.includes(kw.toLowerCase()))) {
        result.motionId = item.id;
      }
    }
  }

  // 舞台指示优先级最高
  tryMatch(stageText);
  // 再扫全文，补充未命中的通道
  tryMatch(fullText);

  if (result.motionId || result.expressionId) {
    console.info('[trigger:prose] inferred from prose', {
      motionId: result.motionId,
      expressionId: result.expressionId,
      stageDirections,
    });
  }

  return result;
}
