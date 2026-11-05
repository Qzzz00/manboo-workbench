export interface SseEvent { event: string; data: string }

/** 从累积 buffer 切出完整 SSE 帧（以空行分隔），返回事件与未完成的尾部。 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const block of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // 注释/keepalive
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

export interface ConnectOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (e: { event: string; data: any }) => void;
  getBaseUrl: () => string;
  getToken: () => string | null;
  getDeviceId: () => string;
  fetchImpl?: typeof fetch;
  onError?: (err: unknown) => void;
}

export function connectJourneyStream(opts: ConnectOpts): { close: () => void } {
  const fetchFn = opts.fetchImpl || fetch;
  let closed = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function run() {
    if (closed) return;
    controller = new AbortController();
    try {
      const token = opts.getToken();
      const headers: Record<string, string> = { 'X-Device-Id': opts.getDeviceId() };
      if (token) headers.Authorization = `Bearer ${token}`;
      const resp = await fetchFn(`${opts.getBaseUrl()}/api/sessions/stream`, {
        headers,
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`SSE status ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const e of events) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let data: any = e.data;
          try { data = JSON.parse(e.data); } catch { /* keep string */ }
          opts.onEvent({ event: e.event, data });
        }
      }
    } catch (err) {
      if (!closed) opts.onError?.(err);
    } finally {
      if (!closed) retryTimer = setTimeout(run, 2000); // 断线重连
    }
  }
  run();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { controller?.abort(); } catch { /* ignore */ }
    },
  };
}
