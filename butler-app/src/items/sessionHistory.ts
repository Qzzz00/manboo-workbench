/**
 * 手机「最近的对话」(2026-10-01;维护者:「每一个智能体只显示一个最近会话,昨晚我主要是和你聊,起码三四个会话」)。
 *
 * 原来列的是 /state 里的会话表(这次开机以来报过到的),关掉的一条都不列。现在问电脑要 `GET /sessions/history`
 * —— 各家的会话记录文件里最近 7 天的,每家多条,往下翻分页;窗口型那几家只有最新一句,如实写。
 * 在跑的仍在「各家正在办」那一段(这里不重复列)。电脑是旧版(没有这条路)时退回原来那份,并说一句。
 *
 * ## 2026-10-03(卡「手机各家最近会话固定入口」)
 *
 * 维护者原话:「我说找不到,说明这一页现在的交互路径不可达或是太隐秘或有条件。现在只有『各家在办』只有运行中
 * 或运行中后一点时间才会显示,这显然违背了最初的设计目标。**给他一个固定的入口,固定显示每一家最近的十个会话,
 * 最好是按项目分好的。**」于是这个文件多了两样:
 *
 *   - 要法多一档:`?per_family=10` —— 各家各取最近 10 条、一次全给(分组要整份,拿一页分不了组)。
 *     这台电脑认不认这个参数只能看回包里有没有 `per_family`(老工作台把未知参数当没看见、照旧回一页);
 *     不认就退回原来那条平列表并说一句({@link HISTORY_FLAT_NOTE}),不空白。
 *   - 留哪些换了口径:{@link familyHistoryItems} **在跑的也留着**。原来那份({@link recentHistoryItems})
 *     把在跑的让给「各家正在办」—— 那正是她找不到会话的那条路:一条对话停下来 / 跑起来都会从某个列表里消失。
 *     固定入口这一份不许有「有条件」这回事:一家一组,十条就是十条。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import {
  SESSION_HISTORY_PER_FAMILY,
  SESSION_WINDOW_ONLY_NOTE,
  agoLabel,
  sessionDisplayTitle,
  type SessionHistoryItem,
  type SessionHistoryView,
  type WorkbenchState,
} from '../api/protocol';
import { agentColor, agentTitle, externalRunning } from '../stage/stageCardsModel';
import type { ItemCard } from './itemsModel';

const keyOf = (ref: { agent: string; session_id: string }): string => `${ref.agent}:${ref.session_id}`;

/** 列表里留哪些:在跑的(「各家正在办」里已经有)与事务官自己的不列。 */
export function recentHistoryItems(items: readonly SessionHistoryItem[], state: WorkbenchState): SessionHistoryItem[] {
  const running = new Set(externalRunning(state).map(keyOf));
  const self = new Set((state.agent_registry?.entries ?? []).filter((entry) => entry.self === true).map((entry) => entry.id));
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return item.agent !== 'dsh' && !self.has(item.agent) && item.status !== 'running' && !running.has(key);
  });
}

/**
 * 固定入口那一份留哪些(2026-10-03):**只去掉事务官自己与重复的** —— 在跑的照样在。
 * 理由见文件头:这一份不许「有条件」,一条会话不会因为跑起来 / 停下来而从这里消失。
 */
export function familyHistoryItems(items: readonly SessionHistoryItem[], state: WorkbenchState): SessionHistoryItem[] {
  const self = new Set((state.agent_registry?.entries ?? []).filter((entry) => entry.self === true).map((entry) => entry.id));
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return item.agent !== 'dsh' && !self.has(item.agent);
  });
}

/** 没有项目的那几条归这一组(Claude / Codex 的 cwd 不在任何项目里、窗口型那几家压根没有项目)。 */
export const HISTORY_NO_PROJECT = '未分项目';

/** 一家底下的一个项目组。 */
export interface HistoryProjectGroup {
  project: string;
  cards: ItemCard[];
}

/** 一家一折叠组:组头 = 家名 + 条数;底下按项目分好。 */
export interface HistoryFamilyGroup {
  agent: string;
  /** 家名**问主人要**(`/state.agent_registry`,agentTitle);手机里不再有名字表。 */
  name: string;
  count: number;
  projects: HistoryProjectGroup[];
}

/**
 * 按家、按项目分好(2026-10-03)。顺序**照电脑给的顺序**(它已经按最后动静排好、新的在前):
 * 哪一家最近动过就排前面,家里哪个项目最近动过就排前面,组里新的在前。
 * 手机不自己排时间 —— 窗口型那几家读不到真实时间(如实缺席),这里一排就会把缺席当成 1970 年。
 */
export function familyGroups(items: readonly SessionHistoryItem[], state: WorkbenchState): HistoryFamilyGroup[] {
  const families = new Map<string, { group: HistoryFamilyGroup; byProject: Map<string, HistoryProjectGroup> }>();
  for (const item of familyHistoryItems(items, state)) {
    let family = families.get(item.agent);
    if (family === undefined) {
      family = { group: { agent: item.agent, name: agentTitle(item.agent, state), count: 0, projects: [] }, byProject: new Map() };
      families.set(item.agent, family);
    }
    const project = item.project === undefined || item.project.trim() === '' ? HISTORY_NO_PROJECT : item.project;
    let bucket = family.byProject.get(project);
    if (bucket === undefined) {
      bucket = { project, cards: [] };
      family.byProject.set(project, bucket);
      family.group.projects.push(bucket);
    }
    bucket.cards.push(historyCard(item, state));
    family.group.count += 1;
  }
  return [...families.values()].map((one) => one.group);
}

/** 一条历史对话 → 事项页上的一张卡(点开看完整对话)。 */
export function historyCard(item: SessionHistoryItem, state: WorkbenchState): ItemCard {
  const name = agentTitle(item.agent, state);
  const ago = item.last_at === undefined ? undefined : agoLabel(item.last_at, state.now);
  const said = item.last_line === undefined ? undefined : item.last_line.who === 'you' ? `你:${item.last_line.text}` : item.last_line.text;
  const tint = agentColor(item.agent, state);
  return {
    id: `history:${keyOf(item)}`,
    kind: 'mine',
    title: sessionDisplayTitle(item, name),
    dot: item.status === 'waiting' ? 'yellow' : 'white',
    ...(tint === undefined ? {} : { tint }),
    label: [name, item.status === 'waiting' ? '在等你' : undefined, ago].filter((one): one is string => one !== undefined).join(' · '),
    ...(item.window_only === true ? { note: said === undefined ? SESSION_WINDOW_ONLY_NOTE : `${said} · 只能看最新一句` } : said === undefined ? {} : { note: said }),
    external: { agent: item.agent, sessionId: item.session_id },
  };
}

export type HistoryLoad =
  | { ok: true; view: SessionHistoryView }
  | { ok: false; old: boolean; error: string };

/** 手机上一页几条(事项页里这一段不该把「全部事项」压到老远;要更多就「再往前看」)。 */
export const HISTORY_PAGE = 10;

/**
 * 这台电脑上的工作台还不认 `per_family`(2026-10-03):回的是老的那一页,分不了组 —— 说清为什么、照旧列出来。
 * 不空白、不假装分好了。
 */
export const HISTORY_FLAT_NOTE = `电脑上的工作台这一版还不会按家分好(每家最近 ${SESSION_HISTORY_PER_FAMILY} 条);这里先按时间列,更新之后就按家、按项目分组。`;

/**
 * 还没问到第一份之前说的那一句(2026-10-03)。**不许在这一瞬间说上面那句** ——
 * 「电脑上的工作台这一版还不会…」是一句关于她那台电脑的断言,还没问到就说它是在编。
 */
export const HISTORY_ASKING_TEXT = '正在读各家最近的对话…';

export async function loadHistory(client: ApiClient, options: { before?: string; perFamily?: number } = {}): Promise<HistoryLoad> {
  // `per_family` 那一档不分页(整份一次给完),所以这两套参数不一起发。
  const query = options.perFamily === undefined
    ? `limit=${HISTORY_PAGE}&before=${encodeURIComponent(options.before ?? '')}`
    : `per_family=${options.perFamily}`;
  const res = await client.json<SessionHistoryView>(`/sessions/history?${query}`);
  if (res.ok && res.data !== undefined && Array.isArray(res.data.items)) return { ok: true, view: res.data };
  if (res.ok) return { ok: false, old: false, error: '电脑回的对话列表认不出' };
  // 旧版工作台没有这条路(404):退回会话表那一份。
  return { ok: false, old: res.status === 404, error: res.error };
}

export interface SessionHistoryState {
  items: SessionHistoryItem[];
  /** 还能往下翻。 */
  more: boolean;
  loading: boolean;
  error?: string;
  /** 电脑是旧版(连这条路都没有),这一段退回会话表那一份。 */
  old: boolean;
  /**
   * 第一次问**问完了没有**(成也算、败也算;2026-10-03)。界面靠它决定说哪一句 ——
   * 还没问完就只说「正在读…」,不许先说一句关于她那台电脑的断言。
   */
  asked: boolean;
  /**
   * 电脑真按「每家最多 n 条」取的那一份回来了(2026-10-03):值就是 n,界面据此按家、按项目分组。
   * **缺席 = 这台电脑不认这个参数** —— 界面退回一条平列表并说 {@link HISTORY_FLAT_NOTE}。
   */
  perFamily?: number;
  loadMore(): void;
  reload(): void;
}

/** 多久自己再看一次第一页(列表不是实时的:她回到这一页、或者过一会儿,就是新的)。 */
export const HISTORY_REFRESH_MS = 60_000;

/**
 * @param perFamily 要「每家最多这么多条」的那一档(2026-10-03,固定入口那一页传
 * {@link SESSION_HISTORY_PER_FAMILY})。缺省还是老的一页一页翻。
 */
export function useSessionHistory(client: ApiClient, perFamily?: number): SessionHistoryState {
  const [items, setItems] = useState<SessionHistoryItem[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [old, setOld] = useState(false);
  const [grouped, setGrouped] = useState<number | undefined>(undefined);
  const [asked, setAsked] = useState(false);
  const [round, setRound] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    const first = async (): Promise<void> => {
      setLoading(true);
      try {
        const got = await loadHistory(client, perFamily === undefined ? {} : { perFamily });
        if (!alive) return;
        if (got.ok) {
          setItems(got.view.items);
          setNext(got.view.next);
          setError(undefined);
          setOld(false);
          // 电脑真按每家 n 条取的才有这一格;老电脑把参数当没看见 → 缺席 → 界面退回平列表。
          setGrouped(typeof got.view.per_family === 'number' ? got.view.per_family : undefined);
        }
        else {
          setOld(got.old);
          setError(got.old ? undefined : got.error);
        }
      }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : '连不上工作台'); }
      finally { if (alive) { setLoading(false); setAsked(true); } }
    };
    void first();
    const timer = setInterval(() => { void first(); }, HISTORY_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [client, round, perFamily]);

  const loadMore = useCallback(() => {
    if (next === undefined || busy.current) return;
    busy.current = true;
    setLoading(true);
    void loadHistory(client, { before: next }).then((got) => {
      if (got.ok) {
        setItems((prior) => [...prior, ...got.view.items]);
        setNext(got.view.next);
      }
      else setError(got.error);
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : '连不上工作台')).finally(() => {
      busy.current = false;
      setLoading(false);
    });
  }, [client, next]);

  return {
    items,
    more: next !== undefined,
    loading,
    ...(error === undefined ? {} : { error }),
    old,
    asked,
    ...(grouped === undefined ? {} : { perFamily: grouped }),
    loadMore,
    reload: () => setRound((n) => n + 1),
  };
}
