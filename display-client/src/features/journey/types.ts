// Aiboo 旅程引擎 - 客户端任务卡片类型
// 对齐 PRD §3.4 TaskTemplate / §6.4 任务交互
// 命名保持 camelCase，与运行时协议一致。

export type FeedbackType = 'text' | 'image' | 'location' | 'nfc_tag' | 'voice';

export type TaskEvaluation = {
  text?: { minLength?: number; requiredKeywords?: string[] };
  image?: { visionModelCheck?: boolean; requiredElements?: string[] };
  location?: { targetLat?: number; targetLng?: number; radiusM?: number };
  nfcTag?: { expectedTagId?: string };
};

export type DimensionUpdate = {
  dimensionId: string;
  delta: number;
};

export type SlotUpdate = {
  slotName: string;
  value: unknown;
};

export type TaskOnComplete = {
  updateSlots?: SlotUpdate[];
  updateDimensions?: DimensionUpdate[];
  followUpMessageTemplate?: string;
};

export type TaskTemplate = {
  id: string;
  name: string;
  description: string;
  promptTemplate?: string;
  feedbackTypes: FeedbackType[];
  evaluation?: TaskEvaluation;
  onComplete?: TaskOnComplete;
  relatedBeatId?: string;
};

// ──────────────── 反馈值 ────────────────

export type TextFeedbackValue = { kind: 'text'; text: string };
export type ImageFeedbackValue = { kind: 'image'; file: File; previewUrl: string };
export type LocationFeedbackValue = {
  kind: 'location';
  lat: number;
  lng: number;
  accuracy?: number;
};
export type NfcFeedbackValue = { kind: 'nfc_tag'; tagId: string };
export type VoiceFeedbackValue = {
  kind: 'voice';
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

export type TaskFeedbackValue =
  | TextFeedbackValue
  | ImageFeedbackValue
  | LocationFeedbackValue
  | NfcFeedbackValue
  | VoiceFeedbackValue;

// ──────────────── 提交与信号 ────────────────

export type TaskSubmitPayload = {
  taskId: string;
  value: TaskFeedbackValue;
  clientCompletionId?: string;
};

export type DimensionSignalEvent =
  | { type: 'task_completed'; taskId: string; timestamp: string }
  | { type: 'task_failed_attempt'; taskId: string; reason?: string; timestamp: string };
