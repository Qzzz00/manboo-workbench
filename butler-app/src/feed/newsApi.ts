/**
 * 「资讯」这一块对工作台说的五句话(2026-09-21)。走的是与别处同一个 `ApiClient`
 * (局域网直连 8791 / 出了门经房间代理,见 channel/routedClient.ts),所以出门在外也能看。
 *
 *   GET  /feed            今天的资讯 + 播客 + 偏好
 *   POST /feed/feedback   跟进 / 不看了
 *   POST /feed/config     改资讯偏好
 *   POST /feed/run        手动跑一轮
 *   GET  /feed/podcast    播客音频(整段,Blob)—— **退路**,单人口播那一段
 *   GET  /feed/aidj       今天那期 Aiboo 双主播节目(2026-09-22)
 *   POST /feed/aidj/config 双主播播客的开关
 *
 * 404 =「这台工作台没接资讯」,与 503 =「接了但本机缺能力」分得开;两者的人话都由
 * 服务端给,这里**一个字都不改写**。
 */
import type { ApiClient, ApiResult } from '../api/client';
import type { AidjConfig, AidjConfigPatch, AidjView } from './aidjModel';
import type { NewsConfig, NewsView } from './newsModel';

export interface NewsApi {
  view(): Promise<ApiResult<NewsView>>;
  feedback(id: string, action: 'follow' | 'mute'): Promise<ApiResult<{ ok: true }>>;
  setConfig(patch: Partial<NewsConfig>): Promise<ApiResult<{ ok: true; config: NewsConfig }>>;
  run(): Promise<ApiResult<{ note: string }>>;
  podcast(date?: string): Promise<ApiResult<Blob>>;
  /** 今天那期 AIDJ 双主播节目。404 = 这台工作台没接 AIDJ(不是「今天没有」)。 */
  aidj(): Promise<ApiResult<AidjView>>;
  /** 改开关 / 填令牌。回包里**没有令牌**,只有 `token_set`。 */
  setAidjConfig(patch: AidjConfigPatch): Promise<ApiResult<{ ok: true; config: AidjConfig }>>;
}

export function createNewsApi(client: ApiClient): NewsApi {
  return {
    view: () => client.json<NewsView>('/feed'),
    feedback: (id, action) => client.json<{ ok: true }>('/feed/feedback', { method: 'POST', body: { id, action } }),
    setConfig: patch => client.json<{ ok: true; config: NewsConfig }>('/feed/config', { method: 'POST', body: patch }),
    run: () => client.json<{ note: string }>('/feed/run', { method: 'POST' }),
    podcast: date => client.blob(date === undefined ? '/feed/podcast' : `/feed/podcast?date=${encodeURIComponent(date)}`),
    aidj: () => client.json<AidjView>('/feed/aidj'),
    setAidjConfig: patch => client.json<{ ok: true; config: AidjConfig }>('/feed/aidj/config', { method: 'POST', body: patch }),
  };
}
