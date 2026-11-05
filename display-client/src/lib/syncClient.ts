import { apiFetch } from './apiClient.ts';
import { API_SYNC_PULL, API_SYNC_PUSH } from './apiConfig.ts';

export type SyncCategory = 'diary' | 'relationships' | 'characterSettings' | 'bubbleStyle' | 'chatSummaries';

export type SyncItem = {
  data: unknown;
  updatedAt: number;
};

export type SyncPayload = Record<SyncCategory, SyncItem>;

type ServerSyncItem = {
  type: string;
  key: string;
  value: unknown;
  updatedAt: number;
  deleted: boolean;
};

const CATEGORY_TO_TYPE: Record<SyncCategory, string> = {
  diary: 'diary',
  relationships: 'relationship',
  characterSettings: 'characterSettings',
  bubbleStyle: 'bubbleStyle',
  chatSummaries: 'chatSummaries',
};

const TYPE_TO_CATEGORY: Record<string, SyncCategory> = {
  diary: 'diary',
  relationship: 'relationships',
  characterSettings: 'characterSettings',
  bubbleStyle: 'bubbleStyle',
  chatSummaries: 'chatSummaries',
};

function toServerType(category: SyncCategory): string {
  return CATEGORY_TO_TYPE[category];
}

export async function pullSync(): Promise<Partial<SyncPayload>> {
  const res = (await apiFetch(`${API_SYNC_PULL}?since=0`, { method: 'GET' })) as {
    items?: ServerSyncItem[];
    serverTime?: number;
  };
  const items = res.items ?? [];
  const payload: Partial<SyncPayload> = {};
  for (const item of items) {
    if (item.deleted) continue;
    const category = TYPE_TO_CATEGORY[item.type];
    if (!category) continue;
    payload[category] = { data: item.value, updatedAt: item.updatedAt };
  }
  return payload;
}

export async function pushSync(payload: Partial<SyncPayload>): Promise<Partial<SyncPayload>> {
  const items: Array<{ type: string; key: string; value: unknown; updatedAt: number }> = [];
  for (const [category, item] of Object.entries(payload)) {
    if (!item || typeof item !== 'object') continue;
    const typedItem = item as SyncItem;
    items.push({
      type: toServerType(category as SyncCategory),
      key: 'data',
      value: typedItem.data,
      updatedAt: typedItem.updatedAt,
    });
  }

  const res = (await apiFetch(API_SYNC_PUSH, {
    method: 'POST',
    body: JSON.stringify({ items }),
  })) as {
    accepted?: ServerSyncItem[];
    skipped?: number;
    serverTime?: number;
  };

  const result: Partial<SyncPayload> = {};
  for (const item of res.accepted ?? []) {
    const category = TYPE_TO_CATEGORY[item.type];
    if (!category) continue;
    result[category] = { data: item.value, updatedAt: item.updatedAt };
  }
  return result;
}
