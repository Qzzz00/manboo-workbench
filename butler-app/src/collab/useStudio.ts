/**
 * 协作工作室(频道)数据 hook(2026-10-24,小K)。
 *
 * 读 `GET /collab/relay/studio`(本机或配对设备可信;局域网直连可用,经房间白名单未放行,
 * 失败如实摆)。`tasks.relay_tick` 变一次重读一次(频道消息、成员变动都推这个数)。
 * 只读:这里没有发送框,人类在频道里旁观。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { projectStudio, type StudioView } from './channelApi';

export interface StudioData {
  studio: StudioView | undefined;
  loading: boolean;
  error: string | undefined;
  retry(): void;
}

export function useStudio(client: ApiClient, relayTick: number | undefined): StudioData {
  const [studio, setStudio] = useState<StudioView | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [round, setRound] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    client
      .json<unknown>('/collab/relay/studio', { method: 'GET' })
      .then((res) => {
        if (!alive || !mounted.current) return;
        if (res.ok) {
          setStudio(projectStudio(res.data));
          setError(undefined);
        } else {
          setStudio(undefined);
          setError(res.error || '读不到工作室');
        }
      })
      .catch(() => { if (alive && mounted.current) setError('读不到工作室'); })
      .finally(() => { if (alive && mounted.current) setLoading(false); });
    return () => { alive = false; };
    // relayTick 变一次重读一次;round 是手动重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, relayTick, round]);

  const retry = useCallback(() => setRound((r) => r + 1), []);
  return { studio, loading, error, retry };
}
