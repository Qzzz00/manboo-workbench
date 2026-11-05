/**
 * 手机页面上出的错报给工作台(2026-09-25,卡 V;与电脑端 workbench-plugin/src/client/reportClientError.ts 同一套)。
 *
 * 09-25 晚维护者在电脑上点「事务官」没反应、页面卡死 —— 没有任何地方记录。手机上同一件事更查不到:
 * 他人在外面,连不上局域网,adb 也接不上。从此两头都往 `POST /client/error` 报一条。
 *
 * 手机这头多一个麻烦:**报错随时可能发生,而能说话的客户端要配对之后才有**(直连 8791 或经房间代理)。
 * 所以这一份是「先攒着、有口子了再送」:
 * - `installPhoneErrorReporter()` 在 `main.tsx` 里第一时间挂上两个口子(比 React 渲染还早),攒进队列;
 * - 客户端一就绪,`setPhoneErrorSink(send)` 把队列一次性冲出去,之后来一条送一条;
 * - 配对之前出的错就攒在队列里(最多 `QUEUE_MAX` 条),永远等不到口子就随页面一起没了 —— 那也比现在的「什么都没有」好。
 *
 * 四条纪律与电脑那份一字不差:它自己失败了不许再报、同一条最多报几次、总数有上限、不动原来的行为。
 */

export const MAX_PER_KEY = 3;
export const MAX_TOTAL = 50;
/** 还没有口子时最多攒几条。 */
export const QUEUE_MAX = 10;

export interface PhoneErrorPayload {
  message: string;
  stack?: string;
  view?: string;
  where: 'phone';
}

/** 送出去的那只手。返回的 promise 失败无所谓(这里会吞掉)。 */
export type PhoneErrorSink = (payload: PhoneErrorPayload) => Promise<unknown>;

const seen = new Map<string, number>();
let total = 0;
let sink: PhoneErrorSink | undefined;
let queue: PhoneErrorPayload[] = [];
/** 此刻在哪一页(界面自己报一声;缺省不填)。 */
let currentView: string | undefined;

function send(payload: PhoneErrorPayload): void {
  if (sink === undefined) {
    if (queue.length < QUEUE_MAX) queue.push(payload);
    return;
  }
  // 报错这一发不许再抛:失败就算了。
  void sink(payload).catch(() => {});
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (value instanceof Error) return value.message || value.name;
  if (value === null || value === undefined) return undefined;
  try {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text === '{}' || text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** 报一条(两个口子都走它;也可以在 try/catch 里手动叫)。 */
export function reportPhoneError(input: { message: unknown; stack?: unknown }): void {
  if (total >= MAX_TOTAL) return;
  const message = messageOf(input.message);
  if (message === undefined) return;
  const stack = input.stack instanceof Error ? input.stack.stack : typeof input.stack === 'string' ? input.stack : undefined;
  const key = `${message}|${stack?.split('\n')[0] ?? ''}`;
  const times = seen.get(key) ?? 0;
  if (times >= MAX_PER_KEY) return;
  seen.set(key, times + 1);
  total += 1;
  send({
    message: message.slice(0, 240),
    ...(stack === undefined ? {} : { stack: stack.split('\n').slice(0, 5).join('\n').slice(0, 800) }),
    ...(currentView === undefined ? {} : { view: currentView }),
    where: 'phone',
  });
}

/** 界面告诉它此刻在哪一页(`home` / `inbox` / `call` / …)。只进报错里,不进别处。 */
export function setPhoneErrorView(view: string | undefined): void {
  currentView = view;
}

/** 客户端就绪:把攒着的一次性冲出去,之后来一条送一条。 */
export function setPhoneErrorSink(next: PhoneErrorSink | undefined): void {
  sink = next;
  if (next === undefined) return;
  const pending = queue;
  queue = [];
  for (const payload of pending) void next(payload).catch(() => {});
}

/** 挂上两个口子。返回拆掉它们的函数(测试用)。 */
export function installPhoneErrorReporter(target: {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
} = globalThis as never): () => void {
  const onError = (event: unknown): void => {
    const e = event as { message?: unknown; error?: unknown; filename?: unknown; lineno?: unknown };
    const stack = e.error instanceof Error ? e.error.stack : typeof e.filename === 'string' ? `${e.filename}:${String(e.lineno ?? '')}` : undefined;
    reportPhoneError({ message: e.error instanceof Error ? e.error : e.message, stack });
  };
  const onRejection = (event: unknown): void => {
    const reason = (event as { reason?: unknown }).reason;
    reportPhoneError({ message: reason, stack: reason });
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** 只给测试用:把攒下的与计数清回原样。 */
export function resetPhoneErrorReporterForTest(): void {
  seen.clear();
  total = 0;
  sink = undefined;
  queue = [];
  currentView = undefined;
}
