/**
 * 表情包类型定义
 */

export type StickerType = 'daily' | 'meme';

export type Sticker = {
  id: string;
  /** 展示名称（可选） */
  name?: string;
  /** 图片 URL */
  url: string;
  /** 缩略图 URL（可选，缺省用 url） */
  thumb_url?: string;
  /** 表情类型 */
  sticker_type?: StickerType;
  /** 排序权重 */
  sort_order?: number;
  /** 是否上架 */
  active?: boolean;
  /** 上架时间 */
  created_at?: string;
  /** 宽度（px，可选） */
  width?: number;
  /** 高度（px，可选） */
  height?: number;
};

/** 后端 sticker 列表响应 */
export type StickerListResponse = {
  stickers: Sticker[];
};

/** 本地缓存条目 */
export type StickerCacheEntry = {
  stickers: Sticker[];
  fetchedAt: number;
};
