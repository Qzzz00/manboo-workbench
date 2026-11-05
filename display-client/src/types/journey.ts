export type JourneyNotificationType = 'beat' | 'presence' | 'task' | 'farewell' | 'silence';

export type PickupMode = 'pickup' | 'pickup_delayed' | 'pickup_voice_memo' | 'no_pickup' | 'pickup_short';

export interface JourneyNotification {
  id: string;
  type: JourneyNotificationType;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface PickupResult {
  mode: PickupMode;
  latency_ms?: number;
  deferred_response_at?: number;
  voice_emotion?: string;
  reason?: string;
  location?: string;
}

// 三方（后台/前端/服务端）统一的反馈类型全集（ALL-407）。
// voice 类型已知，但运行时暂无上传/转写链路：后台标注暂不可用，服务端以 voice_unsupported 明确拒绝。
export type TaskFeedbackType =
  | 'text'
  | 'image'
  | 'confirm'
  | 'option'
  | 'number'
  | 'location'
  | 'nfc_tag'
  | 'voice';

export interface JourneyTaskOption {
  id: string;
  label?: string;
}

export interface JourneyTask {
  id: string;
  name: string;
  description: string;
  feedback_types: Array<TaskFeedbackType>;
  /** option 反馈的可选项（来自任务模板） */
  options?: Array<JourneyTaskOption | string>;
  /** number 反馈的取值范围（来自任务模板） */
  min?: number;
  max?: number;
  prompt_template?: string;
  follow_up_message_template?: string;
}

// onComplete 回传给上层的反馈载荷（判别联合），上层据此构造提交接口的 body。
export type TaskFeedback =
  | { type: 'text'; value: string }
  | { type: 'image'; value: string }
  | { type: 'confirm'; value: true }
  | { type: 'option'; value: string }
  | { type: 'number'; value: number }
  | { type: 'location'; value: string }
  | { type: 'nfc_tag'; value: string }
  | { type: 'voice'; value: string };

export interface JourneyEnding {
  content: string;
  used_memories: Array<{ brief: string }>;
  bgm_url?: string;
}

export interface JourneyLifeSigns {
  location_id?: string;
  state_id?: string;
  wardrobe_item_id?: string;
  model_id?: string;
  background_id?: string;
  /** 动态场景背景（ALL-414）：当前/目标场景的标准化 key，随 background_id 一起下发 */
  scene_key?: string;
  /** SSE 推送携带的来源角色 id；用于多端/多角色时过滤非当前角色的背景下发 */
  avatarId?: string;
}

/** 纪念物展示形态 */
export type MementoForm = 'codex' | 'card' | 'statue' | 'figurine';

/** 与 ALL-200 Memorial schema 对齐 */
export interface Memento {
  instanceId: string;
  characterJourneyId: string;
  characterName?: string;
  completedAt: string;
  endingRhythm?: string;
  timeline: MementoTimelineItem[];
  derivedSkus?: MementoDerivedSku[];
}

export interface MementoTimelineItem {
  at: string;
  label: string;
  beatId?: string;
  imageRef?: string;
}

export interface MementoDerivedSku {
  skuId: string;
  label: string;
  previewUrl?: string;
}

/** 当前剧情节拍（服务端下发给客户端的子集） */
export interface CurrentBeat {
  id: string;
  name: string;
  emotion_state: string;
  key_event_description?: string;
  target_user_feeling?: string;
  llm_guidance?: {
    system_prompt_addition?: string;
  };
  status: 'in_progress';
}
