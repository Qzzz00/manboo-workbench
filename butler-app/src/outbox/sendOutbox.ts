/**
 * ★ **待发箱**(2026-10-12,卡「手机交代只执行一次」;交接 `docs/交接-1012-手机交代只执行一次.md`)。
 *
 * 运营同学 10-12 的验收标准:手机交代一次,电脑只执行一次,手机收到明确回执;断线恢复后不丢失、不重复执行;
 * 发送失败、等待处理、处理完成在手机上明确区分。这里管前两条在手机上的那一半:
 *
 * 1. **先落盘再发**。连同请求号(`client_key`)一起记在 Preferences(`wb.send.outbox.v1`),然后才发 ——
 *    发到一半 App 被杀,重开时账上还有它;
 * 2. **没送到就留着**(连不上、电脑 5xx),网络变了 / 每 30 秒 / App 重开时自动补发(session.ts 喊 `pump()`),
 *    补发带的还是那个号:电脑那头办过的原样回第一次那份,不办第二次(workbench-plugin/src/server/clientKeys.ts);
 * 3. **电脑答了「不行」(4xx)的不补**,留着给她看那句原话,她点「收起」才划掉。
 *
 * 超过 {@link SEND_OUTBOX_AUTO_MS} 的不再自动补(电脑那头的台账只记两天,而且一天前的话自己冒出去不像话),
 * 留着等她点「重发」。回执三档怎么摆在 chat/chatModel.ts 的 `receiptOf`。
 */
import type { ApiResult, RequestOptions } from '../api/client';
import type { KeyValueStore } from '../api/tokenStore';
import { newClientKey } from '../channel/clientKey';

/** 账记在 Preferences 的哪一格。改格式就换一个名字。 */
export const SEND_OUTBOX_KEY = 'wb.send.outbox.v1';

/**
 * 业务分类器按路径登记(2026-10-23,卡 A 复审):有的路 HTTP 200 但回包说没办成
 * (接续的 pick/unsupported/failed 那一档),是**业务拒绝** —— 不补发、不算投递。
 * 登记在模块层(分类器不带实例状态);返回一个撤销函数。没登记的路径走老口径,一字不变。
 */
type OutboxClassifier = (result: ApiResult<unknown>) => SendOutcome;
const OUTBOX_CLASSIFIERS = new Map<string, OutboxClassifier>();
export function registerOutboxClassifier(path: string, classifier: OutboxClassifier): () => void {
  OUTBOX_CLASSIFIERS.set(path, classifier);
  return () => { if (OUTBOX_CLASSIFIERS.get(path) === classifier) OUTBOX_CLASSIFIERS.delete(path); };
}
/** 多久之内的自动补发。 */
export const SEND_OUTBOX_AUTO_MS = 24 * 60 * 60 * 1000;

export type OutboxState = 'sending' | 'unsent' | 'rejected';

export interface OutboxEntry {
  /** 请求号,也是气泡的 localId。 */
  key: string;
  path: string;
  body: Record<string, unknown>;
  /** 气泡上那句话与时刻。 */
  text: string;
  at: string;
  /** 落盘那一刻(手机的钟,只用来算自动补发的窗口)。 */
  queuedAt: number;
  state: OutboxState;
  error?: string;
}

export type SendOutcome =
  | { kind: 'delivered'; data: unknown }
  | { kind: 'unsent'; error: string }
  | { kind: 'rejected'; error: string };

export interface SendOutboxEvent {
  delivered?: OutboxEntry;
  data?: unknown;
}

export interface SendOutboxClient {
  json<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResult<T>>;
}

export interface SendOutbox {
  ready(): Promise<void>;
  list(): readonly OutboxEntry[];
  send(path: string, body: Record<string, unknown>, view: { text: string; at: string }): Promise<{ key: string; outcome: SendOutcome }>;
  /** 她点「重发」:带原来那个号再发一次(不看窗口)。 */
  resend(key: string): Promise<SendOutcome>;
  /** 自动补发:没送到的、窗口之内的,按顺序。 */
  pump(): Promise<void>;
  /** 她点「收起」。 */
  discard(key: string): void;
  /** 账变了 / 送到了一条(带 `delivered`)。回的函数退订。 */
  subscribe(listener: (event?: SendOutboxEvent) => void): () => void;
  /** 会话换掉(重新配对、退出登录)时停:不再补发、不再写账(新会话那一份接手)。 */
  stop(): void;
}

export interface SendOutboxDeps {
  kv: KeyValueStore;
  client: SendOutboxClient;
  now?: () => number;
  /** 账记在哪一格(缺省 {@link SEND_OUTBOX_KEY})。session.ts 按配对的设备分开记:换一台电脑配对,不把上一台的话补发过去。 */
  storageKey?: string;
  /** 自己定时补发(session.ts 给;用例不给,手动 pump)。 */
  autoPump?: { everyMs: number; networkChanges?: (listener: () => void) => () => void };
  /**
   * 电脑认不认请求号(`/state.client_keys`)。**不认就不自动补**:老工作台收到补发会真办第二次 ——
   * 那几句留着,她看见「没送到」自己点「重发」(和从前她再说一遍一样)。缺席 = 认(用例)。
   */
  canAutoResend?: () => boolean;
}

export function createSendOutbox(deps: SendOutboxDeps): SendOutbox {
  const now = deps.now ?? (() => Date.now());
  const storageKey = deps.storageKey ?? SEND_OUTBOX_KEY;
  let stopped = false;
  let entries: OutboxEntry[] = [];
  const listeners = new Set<(event?: SendOutboxEvent) => void>();
  const inFlight = new Map<string, Promise<SendOutcome>>();
  let pumping: Promise<void> | undefined;

  const loaded = (async () => {
    try {
      const raw = await deps.kv.get(storageKey);
      const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);
      if (!Array.isArray(parsed)) return;
      const restored = parsed.filter((one): one is OutboxEntry => {
        const e = one as Partial<OutboxEntry> | null;
        return typeof e?.key === 'string' && typeof e.path === 'string' && e.body !== null && typeof e.body === 'object'
          && typeof e.text === 'string' && typeof e.at === 'string' && typeof e.queuedAt === 'number';
      });
      // 账上「在发」的那几条是上一次 App 被杀时正发着的:不知道到没到,算没送到 —— 补发靠请求号不会办两遍。
      entries = [...restored.map((e) => (e.state === 'sending' ? { ...e, state: 'unsent' as const } : e)), ...entries];
    } catch { /* 读不懂就从空的开始 */ }
  })();

  function emit(event?: SendOutboxEvent): void {
    for (const l of [...listeners]) { try { l(event); } catch { /* 一个订阅者抛不拦别的 */ } }
  }

  async function save(): Promise<void> {
    if (stopped) return;
    try { await deps.kv.set(storageKey, JSON.stringify(entries)); } catch { /* 写不下:内存里那份照样补 */ }
  }

  function patch(key: string, next: Partial<OutboxEntry> | undefined): void {
    entries = next === undefined
      ? entries.filter((e) => e.key !== key)
      : entries.map((e) => (e.key === key ? { ...e, ...next } : e));
  }

  function classify(entry: OutboxEntry, result: ApiResult<unknown>): SendOutcome {
    // 业务分类器(2026-10-23,卡 A 复审):有的路 HTTP 200 但回包说没办成(接续的 pick/unsupported/failed),
    // 那一档是**业务拒绝** —— 不补发、不算投递,把那句人话带回去。没登记的路走老口径,一字不变。
    const custom = OUTBOX_CLASSIFIERS.get(entry.path)
    if (custom !== undefined) return custom(result)
    if (result.ok) return { kind: 'delivered', data: result.data };
    // 连不上、令牌那一下、电脑 5xx:电脑都没记下这个号,补发会真办一次 —— 算没送到。
    if (result.kind === 'network' || result.kind === 'unauthorized' || result.status >= 500) return { kind: 'unsent', error: result.error };
    return { kind: 'rejected', error: result.error };
  }

  function deliver(entry: OutboxEntry): Promise<SendOutcome> {
    const running = inFlight.get(entry.key);
    if (running !== undefined) return running;
    const job = (async (): Promise<SendOutcome> => {
      // 在发:上一次没送到的那句原话先收起来。
      entries = entries.map((e) => {
        if (e.key !== entry.key) return e;
        const { error: _was, ...rest } = e;
        return { ...rest, state: 'sending' as const };
      });
      await save();
      emit();
  const outcome = classify(entry, await deps.client.json(entry.path, { method: 'POST', body: { ...entry.body, client_key: entry.key } }));
      if (outcome.kind === 'delivered') patch(entry.key, undefined);
      else patch(entry.key, { state: outcome.kind, error: outcome.error });
      await save();
      emit(outcome.kind === 'delivered' ? { delivered: entry, data: outcome.data } : undefined);
      return outcome;
    })();
    inFlight.set(entry.key, job);
    void job.finally(() => inFlight.delete(entry.key));
    return job;
  }

  function pump(): Promise<void> {
    if (stopped || deps.canAutoResend?.() === false) return Promise.resolve();
    pumping ??= (async () => {
      await loaded;
      for (const entry of [...entries]) {
        if (stopped) break;
        if (entry.state !== 'unsent' || now() - entry.queuedAt > SEND_OUTBOX_AUTO_MS) continue;
        const outcome = await deliver(entry);
        // 还是连不上:后面的也别一条条干等,下一拍再来。
        if (outcome.kind === 'unsent') break;
      }
    })().finally(() => { pumping = undefined; });
    return pumping;
  }

  const timer = deps.autoPump !== undefined && deps.autoPump.everyMs > 0
    ? setInterval(() => { void pump().catch(() => {}); }, deps.autoPump.everyMs)
    : undefined;
  const unwatch = deps.autoPump?.networkChanges?.(() => { void pump().catch(() => {}); });
  if (deps.autoPump !== undefined) void pump().catch(() => {});

  return {
    ready: () => loaded,
    list: () => entries,
    async send(path, body, view) {
      await loaded;
      const key = newClientKey();
      const entry: OutboxEntry = { key, path, body: { ...body }, text: view.text, at: view.at, queuedAt: now(), state: 'sending' };
      entries = [...entries, entry];
      return { key, outcome: await deliver(entry) };
    },
    async resend(key) {
      await loaded;
      const entry = entries.find((e) => e.key === key);
      if (entry === undefined) return { kind: 'rejected', error: '这一句已经不在待发箱里了' };
      return deliver(entry);
    },
    pump,
    discard(key) {
      if (inFlight.has(key)) return;
      patch(key, undefined);
      void save();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      unwatch?.();
    },
  };
}
