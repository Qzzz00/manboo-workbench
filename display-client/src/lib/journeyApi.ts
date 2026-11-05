/**
 * 旅程引擎客户端运行时 API（按 ALL-200 接口协议 v1.0 实现）
 *
 * 本文件只包含 C 端可直接调用的运行时接口，类型与 `journey-engine.openapi.yaml`
 * `/api/journey/*` 部分保持一致。
 */

import { ApiError, apiGet } from './apiClient.ts';
import { API_JOURNEY_CRISIS_RESOURCES, API_JOURNEY_ENDING } from './apiConfig.ts';

export type EndingRhythm = 'warm' | 'bittersweet' | 'open' | 'reflective' | 'celebratory';

/**
 * 旅程结局对白（对应 OpenAPI `JourneyEnding` schema）。
 *
 * 注意：协议 v1.0 中 `JourneyEnding` 未包含配乐 URL；如需配乐，调用方应通过
 * `EndingScene` 的 `musicUrl` prop 注入，或等待协议补字段。
 */
export interface JourneyEnding {
  id: string;
  journeyInstanceId: string;
  endingTemplateId: string;
  bodyText: string;
  rhythm: EndingRhythm;
  generatedAt: string;
  llmModelUsed?: string;
  usedMemoryIds?: string[];
  usedSlotKeys?: string[];
}

export interface CrisisResource {
  title: string;
  phone?: string;
  url?: string;
  description: string;
}

/**
 * 拉取当前登录用户的旅程结局对白（JMEASURE-RUNTIME-001 起接真实后端）。
 *
 * 后端约束：实例必须已完成（status = completed）且结局已生成，否则返回 404
 * （code = ending_not_found）。传 avatarId 时收窄到该角色主旅程下的最新结局。
 */
export async function fetchJourneyEnding(avatarId?: string): Promise<JourneyEnding> {
  const query = avatarId ? `?avatar_id=${encodeURIComponent(avatarId)}` : '';
  const data = await apiGet(`${API_JOURNEY_ENDING}${query}`);
  const raw = (data ?? {}) as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.bodyText !== 'string') {
    throw new ApiError('旅程结局数据格式异常', 502, 'invalid_response');
  }
  return {
    id: raw.id,
    journeyInstanceId: typeof raw.journeyInstanceId === 'string' ? raw.journeyInstanceId : '',
    endingTemplateId: typeof raw.endingTemplateId === 'string' ? raw.endingTemplateId : '',
    bodyText: raw.bodyText,
    rhythm: isEndingRhythm(raw.rhythm) ? raw.rhythm : 'reflective',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    ...(typeof raw.llmModelUsed === 'string' ? { llmModelUsed: raw.llmModelUsed } : {}),
    ...(Array.isArray(raw.usedMemoryIds) ? { usedMemoryIds: raw.usedMemoryIds.filter((x): x is string => typeof x === 'string') } : {}),
    ...(Array.isArray(raw.usedSlotKeys) ? { usedSlotKeys: raw.usedSlotKeys.filter((x): x is string => typeof x === 'string') } : {}),
  };
}

const ENDING_RHYTHMS: readonly EndingRhythm[] = ['warm', 'bittersweet', 'open', 'reflective', 'celebratory'];

function isEndingRhythm(value: unknown): value is EndingRhythm {
  return typeof value === 'string' && (ENDING_RHYTHMS as readonly string[]).includes(value);
}

export async function fetchCrisisResources(): Promise<CrisisResource[]> {
  const data = await apiGet(API_JOURNEY_CRISIS_RESOURCES);
  const resources = (data as { resources?: unknown })?.resources;
  if (!Array.isArray(resources)) return [];
  return resources
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const resource = item as Record<string, unknown>;
      const title = typeof resource.title === 'string' ? resource.title.trim() : '';
      const description = typeof resource.description === 'string' ? resource.description.trim() : '';
      const phone = typeof resource.phone === 'string' ? resource.phone.trim() : '';
      const url = typeof resource.url === 'string' ? resource.url.trim() : '';
      if (!title || !description) return null;
      return {
        title,
        ...(phone ? { phone } : {}),
        ...(url ? { url } : {}),
        description,
      };
    })
    .filter((item): item is CrisisResource => item !== null);
}
