import { useEffect, useRef, useState } from 'react';
import type { AvatarManifest, ExpressionLayer, ParameterOverride } from '../features/live2d/avatarManifest.ts';
import type { CostumeSlot } from '../features/live2d/profile/types.ts';
import { MOUTH_PARAM_IDS_SET } from '../features/live2d/mouthParams.ts';
import {
  createAssistantResponse,
  LlmConfigurationError,
  LlmConnectionError,
  LlmResponseFormatError,
  type AssistantSegment,
  type ChatMessage,
  type ChatMessageSticker,
} from '../lib/llm.ts';
import type { HoloControl } from '../holo/holoControl.ts';
import type { Emotion } from '../lib/emotion.ts';
import { getAvatarNeutralExpressionId, hasAvatarExpression } from '../features/live2d/avatarManifest.ts';
import type { PresenceStore } from '../features/live2d/presence/presenceStore.ts';
import { createAuChatEngine, type AuChatEngine } from '../features/live2d/au/auChatEngine.ts';
import { classifyCallEmotion, findEmotionMotion } from '../lib/callEmotion.ts';
import { expressionMixForEmotion } from '../features/live2d/emotionExpression.ts';
import type { PreparedSpeech, TtsSettings, TtsState } from '../lib/tts.ts';
import { prepareSpeech, stopSpeaking, subscribeTtsState, getTtsState } from '../lib/tts.ts';
import { addFavorability } from '../lib/relationshipStore.ts';
import { scheduleStagedMessages, OPENING_MESSAGE_INTERVAL_MS, type OpeningMessage } from '../lib/openingApi.ts';
import { QuotaExceededError, isQuotaError } from '../lib/errorTypes.ts';
import { showToast } from '../lib/toastStore.ts';
import {
  ResponseSyncController,
  type ResponseSyncRound,
} from '../lib/responseSyncController.ts';
import {
  generateImage,
  saveGeneratedImage,
  saveGeneratedVoice,
  saveChatMessage,
} from '../lib/chatMedia.ts';
import {
  buildHistoryForPrompt,
  maybeSummarize,
  loadChatMetadata,
} from '../lib/memory/index.ts';

type SyncedTextPayload = Awaited<ReturnType<typeof createAssistantResponse>>;

type SyncedMotionPayload = Pick<
  SyncedTextPayload,
  'expressionMix' | 'parameterOverrides' | 'motion' | 'emotion' | 'intensity'
>;

type RenderSegment =
  | { type: 'text'; text: string }
  | { type: 'action'; text: string }
  | { type: 'voice'; text: string }
  | { type: 'image'; prompt: string; alt?: string };

type UseChatArgs = {
  selectedAvatar: AvatarManifest;
  selectedAvatarId: string;
  ttsSettings: TtsSettings;
  ttsEnabled: boolean;

  messages: ChatMessage[];
  setMessages: (msgs: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  /** 形象状态合成器：模型唯一写入口。情绪/服饰/形态/动作四层都走它。 */
  presence: PresenceStore;
  setMotionName: (name: string | undefined) => void;
  setMouthOpen: (value: number) => void;
  openSettings: () => void;
  /** TTS 语音已准备好（含估算时长），供外部（如 profile binding）订阅开播时机。 */
  onPreparedSpeech?: (prepared: PreparedSpeech) => void;
  /**
   * v2 profile 接管 live2d 输出后，把 LLM 产出的 motion / expression 文件名
   * 与需要主动清除的 costume slot 一起转给外部调度器。有内容时才调用。
   */
  onProfileTrigger?: (payload: { files: string[]; clearSlots?: CostumeSlot[] }) => void;
  /**
   * 读取当前已激活的 v2 profile costume slot（通常从 live2d runtime 的
   * profileCostumeSlots 里映射）。用于"上下文无指代移除"兜底：
   * "把它收起来"这类没有指向具体物品的话，就默认要脱掉当前所有已激活的装扮。
   * 没提供或返回空数组时，兜底不会触发。
   */
  getActiveProfileCostumeSlots?: () => CostumeSlot[];
  /**
   * 读取最近被清除的 v2 profile costume slot（按时间倒序，最近在最前）。
   * 用于"再看看"类无明确物品名的复穿请求。
   */
  getRecentClearedProfileCostumeSlots?: () => CostumeSlot[];
  /**
   * 读取最近被设置（穿上）的 v2 profile costume slot（按时间倒序，最近在最前）。
   * 用于"换回去"类无明确物品名的还原请求。
   */
  getRecentSetProfileCostumeSlots?: () => CostumeSlot[];
  /**
   * v2 profile 模式下跳过旧通道对 live2d 的写入（presence.applyEmotion /
   * setMotionName 等），保留 IM 气泡、TTS、记忆等非 live2d 副作用。
   */
  bypassLegacyLive2dOutputs?: boolean;
  /**
   * 全息屏语音控制回合：为 true 时向 LLM 追加控制子句，允许其回 control 字段。
   * 仅 holo 面传 true；移动端主客户端缺省，行为不变。
   */
  holoControl?: boolean;
  /**
   * LLM 判出播放控制意图时回调（在 TTS/渲染之前触发——控制先行，语音确认异步跟上）。
   * 仅 holo 面接线，映射到 djView 播放控制/模式切换。
   */
  onControl?: (control: HoloControl) => void;
  /**
   * 用户真正发起一轮对话（提交文字/表情/图片回合）时回调。
   * 用于世界书对账等后台旁路：不 await、不阻塞消息发送。
   */
  onDialogueStart?: () => void;
};

export function useChat({
  selectedAvatar,
  selectedAvatarId,
  ttsSettings,
  ttsEnabled,

  messages,
  setMessages,
  presence,
  setMotionName,
  setMouthOpen,
  openSettings,
  onPreparedSpeech,
  onProfileTrigger,
  getActiveProfileCostumeSlots,
  getRecentClearedProfileCostumeSlots,
  getRecentSetProfileCostumeSlots,
  bypassLegacyLive2dOutputs,
  holoControl,
  onControl,
  onDialogueStart,
}: UseChatArgs) {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [ttsState, setTtsState] = useState<TtsState>(getTtsState());
  // 情绪淡回时长（旧 6s 自动回 neutral 逻辑收敛进合成器 applyEmotion 的 holdMs）。
  const EMOTION_HOLD_MS = 6000;
  // ① 情绪层 AU 引擎：按角色持有 solver + history。切角色重建（history 重置）。
  // 有 profile 的角色（如 estella）走 solver；无 profile 的角色 ready()===false，回退临时桥。
  const auEngineRef = useRef<AuChatEngine | null>(null);
  const roundCounterRef = useRef(0);
  const activeRoundIdRef = useRef<string | null>(null);
  const pendingMessageIdRef = useRef<string | null>(null);
  const pendingSpeechRef = useRef<PreparedSpeech | null>(null);
  const segmentRenderTokenRef = useRef(0);
  // 每次渲染同步最新 messages，供异步回调（如发图 handleSendImage→handleSubmit）读取，
  // 避免 stale 闭包：发图先 setMessages 入列图片，紧接着调用的 handleSubmit 需看到这条图片消息。
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const syncControllerRef = useRef(
    new ResponseSyncController<SyncedTextPayload, PreparedSpeech | null, SyncedMotionPayload>(),
  );
  const activeRoundRef = useRef<
    ResponseSyncRound<SyncedTextPayload, PreparedSpeech | null, SyncedMotionPayload> | null
  >(null);
  useEffect(() => {
    return subscribeTtsState(setTtsState);
  }, []);

  // 切角色：重建 AU 引擎（重置该角色的表情历史）。无 au-profile.json 的角色得到
  // 一个 ready()===false 的引擎，applyMotionPayload 据此回退到 LLM expressionMix 临时桥。
  useEffect(() => {
    let cancelled = false;
    auEngineRef.current = null;
    if (selectedAvatar.modelJson === '') return; // 没有形象(NO_AVATAR):没有表情可驱动
    void createAuChatEngine(selectedAvatar.modelJson)
      .then((engine) => {
        if (!cancelled) auEngineRef.current = engine;
      })
      .catch((error) => {
        console.warn('[au-engine] init failed, falling back to expressionMix bridge', error);
        if (!cancelled) auEngineRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAvatar.modelJson]);

  useEffect(() => {
    return () => {
      activeRoundRef.current?.cancel();
      pendingSpeechRef.current?.cancel();
      stopSpeaking();
      setMouthOpen(0);
    };
  }, [setMouthOpen]);

  function replaceMessage(
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage | null,
  ) {
    setMessages((current) => current.flatMap((message) => {
      if (message.id !== messageId) return [message];
      const nextMessage = updater(message);
      return nextMessage ? [nextMessage] : [];
    }));
  }

  function resetPendingSpeech() {
    if (pendingSpeechRef.current) {
      pendingSpeechRef.current.cancel();
      pendingSpeechRef.current = null;
    }
  }

  function cancelActiveRound() {
    segmentRenderTokenRef.current += 1;
    activeRoundRef.current?.cancel();
    activeRoundRef.current = null;
    activeRoundIdRef.current = null;
    resetPendingSpeech();
    stopSpeaking();
    setMouthOpen(0);
    if (!bypassLegacyLive2dOutputs) {
      setMotionName(undefined);
    }

    const pendingMessageId = pendingMessageIdRef.current;
    if (pendingMessageId) {
      replaceMessage(pendingMessageId, () => null);
      pendingMessageIdRef.current = null;
    }
  }

  function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  type TextBurst = { text: string; kind: 'dialogue' | 'action' };

  // 先把 (动作/神态) 旁白切成独立块：台词块继续按标点分段，动作块整体保留绝不再切。
  // 这样旁白不会被中间的逗号劈开，也不会和台词挤进同一个气泡。全角（）与半角()都识别。
  function splitOutStageDirections(text: string): TextBurst[] {
    const chunks: TextBurst[] = [];
    const re = /（[^（）]*）|\([^()]*\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const dialogue = text.slice(lastIndex, match.index).trim();
      if (dialogue) chunks.push({ text: dialogue, kind: 'dialogue' });
      const action = match[0].trim();
      if (action) chunks.push({ text: action, kind: 'action' });
      lastIndex = match.index + match[0].length;
    }
    const tail = text.slice(lastIndex).trim();
    if (tail) chunks.push({ text: tail, kind: 'dialogue' });
    return chunks;
  }

  // 台词块内部的标点/长度分段（原 splitTextIntoBursts 的逻辑）。
  // 注意：不能用 lookbehind 正则 /(?<=…)/ ——Chrome 61 WebView（U1 Pro 低端机）不支持
  // ES2018 正则语法，SystemJS 实例化该模块时直接 SyntaxError，整条 TTS/分段链路挂掉。
  // 手写「分隔符或空白后断开」扫描，断点集合与原 lookbehind 组合一致（随后统一 trim）。
  const BURST_BREAK_CHARS = '。！？!?~～…，,、';
  function splitAfterBreaks(text: string): string[] {
    const parts: string[] = [];
    let buf = '';
    for (const ch of text) {
      buf += ch;
      if (BURST_BREAK_CHARS.indexOf(ch) >= 0 || /\s/.test(ch)) {
        parts.push(buf);
        buf = '';
      }
    }
    if (buf) parts.push(buf);
    return parts;
  }

  function splitDialogueIntoBursts(text: string): string[] {
    const roughParts = splitAfterBreaks(text)
      .map((part) => part.trim())
      .filter(Boolean);

    const bursts: string[] = [];
    for (const part of roughParts.length ? roughParts : [text]) {
      if (part.length <= 18) {
        bursts.push(part);
        continue;
      }

      for (let index = 0; index < part.length; index += 14) {
        bursts.push(part.slice(index, index + 14));
      }
    }
    return bursts;
  }

  function splitTextIntoBursts(text: string): TextBurst[] {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return [];

    const bursts: TextBurst[] = [];
    for (const chunk of splitOutStageDirections(normalized)) {
      if (chunk.kind === 'action') {
        bursts.push(chunk);
        continue;
      }
      for (const piece of splitDialogueIntoBursts(chunk.text)) {
        bursts.push({ text: piece, kind: 'dialogue' });
      }
    }

    return bursts.slice(0, 12);
  }

  function expandAssistantSegments(segments: AssistantSegment[]): RenderSegment[] {
    const expanded: RenderSegment[] = [];

    for (const segment of segments) {
      if (segment.type === 'text') {
        expanded.push(
          ...splitTextIntoBursts(segment.text).map((burst) =>
            burst.kind === 'action'
              ? ({ type: 'action' as const, text: burst.text })
              : ({ type: 'text' as const, text: burst.text }),
          ),
        );
      } else {
        expanded.push(segment);
      }
    }

    return expanded.length ? expanded.slice(0, 12) : [{ type: 'text', text: '...' }];
  }

  function segmentDelay(segment: RenderSegment) {
    if (segment.type === 'image') return 560;
    if (segment.type === 'voice') return 420;
    return Math.min(760, Math.max(260, segment.text.length * 55));
  }

  async function appendAssistantSegments({
    pendingMessageId,
    response,
    missingParts,
    renderToken,
    profilePayload,
  }: {
    pendingMessageId: string;
    response: SyncedTextPayload;
    missingParts: Array<'text' | 'audio' | 'motion'>;
    renderToken: number;
    profilePayload?: { files: string[]; clearSlots?: CostumeSlot[] };
  }) {
    replaceMessage(pendingMessageId, () => null);

    const baseMessage = {
      role: 'assistant' as const,
      expression: response.expression,
      expressionMix: response.expressionMix,
      parameterOverrides: response.parameterOverrides,
      meta: response.source,
      syncMissingParts: missingParts,
    };

    let profileTriggered = false;

    for (const [segmentIndex, segment] of expandAssistantSegments(response.segments).entries()) {
      if (segmentRenderTokenRef.current !== renderToken) return;
      await wait(segmentDelay(segment));
      if (segmentRenderTokenRef.current !== renderToken) return;

      let segmentTriggerError: string | undefined;
      if (!profileTriggered && profilePayload && (profilePayload.files.length > 0 || (profilePayload.clearSlots?.length ?? 0) > 0)) {
        profileTriggered = true;
        try {
          onProfileTrigger?.(profilePayload);
        } catch (err) {
          console.warn('[trigger] profile play failed', {
            segmentIndex,
            profileId: profilePayload.files[0],
            error: err,
          });
          segmentTriggerError = String(err);
        }
      }

      const segmentBaseMessage = Object.assign(
        {},
        baseMessage,
        segmentTriggerError ? { triggerError: segmentTriggerError } : {},
      );
      if (segment.type === 'text') {
        const messageId = crypto.randomUUID();
        const textMessage = {
          ...segmentBaseMessage,
          id: messageId,
          content: segment.text,
          type: 'text' as const,
        };
        setMessages((current) => [...current, textMessage]);
        // AI 文字回复也要持久化（之前只有 voice/image 存服务端，纯文字重启即丢）
        void saveChatMessage(selectedAvatarId, textMessage).catch((error) => {
          console.error('[chat] save assistant text failed:', error);
        });
        continue;
      }

      if (segment.type === 'action') {
        // (动作/神态) 旁白：纯展示气泡，不发 TTS（整段语音已在 sync 路径单独合成）。
        const messageId = crypto.randomUUID();
        const actionMessage = {
          ...segmentBaseMessage,
          id: messageId,
          content: segment.text,
          type: 'text' as const,
          variant: 'action' as const,
        };
        setMessages((current) => [...current, actionMessage]);
        // 旁白同样持久化（服务端不存 variant，重载后降级为普通文字气泡，内容不丢）
        void saveChatMessage(selectedAvatarId, actionMessage).catch((error) => {
          console.error('[chat] save assistant action failed:', error);
        });
        continue;
      }

      if (segment.type === 'image') {
        const messageId = crypto.randomUUID();
        setMessages((current) => [
          ...current,
          {
            ...segmentBaseMessage,
            id: messageId,
            content: segment.alt ?? '图片生成中...',
            type: 'text',
            pendingStatus: 'typing',
          },
        ]);

        try {
          const blob = await generateImage(segment.prompt);
          if (segmentRenderTokenRef.current !== renderToken) return;
          await saveGeneratedImage(messageId, blob);
          const objectUrl = URL.createObjectURL(blob);

          // Local display with blob URL for instant preview
          replaceMessage(messageId, () => ({
            ...segmentBaseMessage,
            id: messageId,
            content: segment.alt ?? '',
            type: 'image',
            image: {
              url: objectUrl,
              width: 1024,
              height: 1024,
              mime_type: blob.type || 'image/png',
              size_bytes: blob.size,
            },
            imagePrompt: segment.prompt,
          }));

          // Server save with empty URL (media lives in sandbox + can be regenerated)
          const serverMessage: ChatMessage = {
            ...segmentBaseMessage,
            id: messageId,
            content: segment.alt ?? '',
            type: 'image',
            image: {
              url: '',
              width: 1024,
              height: 1024,
              mime_type: blob.type || 'image/png',
              size_bytes: blob.size,
            },
            imagePrompt: segment.prompt,
          };
          void saveChatMessage(selectedAvatarId, serverMessage).catch((error) => {
            console.error('[assistant-image] save message failed:', error);
          });
        } catch (error) {
          console.warn('[assistant-image] generation failed', error);
          replaceMessage(messageId, () => ({
            ...segmentBaseMessage,
            id: messageId,
            content: segment.alt ? `图片没发出来：${segment.alt}` : '图片暂时没发出来',
            type: 'text',
            meta: '图片生成失败',
          }));
        }
        continue;
      }

      if (!ttsEnabled) {
        setMessages((current) => [
          ...current,
          {
            ...segmentBaseMessage,
            id: crypto.randomUUID(),
            content: segment.text,
            type: 'text',
          },
        ]);
        continue;
      }

      const messageId = crypto.randomUUID();
      setMessages((current) => [
        ...current,
        {
          ...segmentBaseMessage,
          id: messageId,
          content: '',
          type: 'text',
          pendingStatus: 'speaking',
        },
      ]);

      try {
        const preparedSpeech = await prepareSpeech({
          text: segment.text,
          settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
          avatarId: selectedAvatarId,
          onMouthChange: setMouthOpen,
          onBlob: (blob) => {
            void saveGeneratedVoice(messageId, blob).catch((error) => {
              console.error('[assistant-voice] save to sandbox failed:', error);
            });
          },
          emotion: response.emotion,
        });
        onPreparedSpeech?.(preparedSpeech);
        if (segmentRenderTokenRef.current !== renderToken) {
          preparedSpeech.cancel();
          return;
        }

        if (preparedSpeech.audioUrl) {
          // Local display with audioUrl for instant playback
          replaceMessage(messageId, () => ({
            ...segmentBaseMessage,
            id: messageId,
            content: segment.text,
            type: 'voice',
            voice: {
              url: preparedSpeech.audioUrl!,
              duration_ms: preparedSpeech.durationMs ?? Math.max(1200, segment.text.length * 260),
              mime_type: preparedSpeech.mimeType || 'audio/mpeg',
            },
            ttsText: segment.text,
          }));

          // Server save with empty URL (audio lives in sandbox + can be regenerated)
          const serverMessage: ChatMessage = {
            ...segmentBaseMessage,
            id: messageId,
            content: segment.text,
            type: 'voice',
            voice: {
              url: '',
              duration_ms: preparedSpeech.durationMs ?? Math.max(1200, segment.text.length * 260),
              mime_type: preparedSpeech.mimeType || 'audio/mpeg',
            },
            ttsText: segment.text,
          };
          void saveChatMessage(selectedAvatarId, serverMessage).catch((error) => {
            console.error('[assistant-voice] save message failed:', error);
          });
        } else {
          replaceMessage(messageId, () => ({
            ...segmentBaseMessage,
            id: messageId,
            content: segment.text,
            type: 'text',
          }));
        }
      } catch (error) {
        console.warn('[assistant-voice] synthesis failed, falling back to text', error);
        replaceMessage(messageId, () => ({
          ...segmentBaseMessage,
          id: messageId,
          content: segment.text,
          type: 'text',
        }));
      }
    }
  }

  function cancelTts() {
    cancelActiveRound();
    setIsSending(false);
  }

  async function handleSubmit(inputText: string, sticker?: ChatMessageSticker) {
    const trimmedInput = inputText.trim();
    // 图片回合：user 图片消息已由 App 入列，此时文本可为空，直接走回复链路。
    // 用 messagesRef.current 读最新（发图后 setMessages 是异步的，闭包里的 messages 可能还没含图）。
    const currentMessages = messagesRef.current;
    const lastMsg = currentMessages[currentMessages.length - 1];
    const lastIsUserImage = lastMsg?.role === 'user' && lastMsg.type === 'image';
    // 图片回合「仅当没打字、且最后一条正是刚发的图片」时成立。只要用户打了字，一律当文字轮
    //（必建 user 消息）——即使上一条恰好是「发了没被回复的旧图片」（发图→切角色取消了那轮→回来打字），
    // 也不能吞掉这次文字、更不能拿旧图重跑（否则表现为「答非所问、回旧图内容」）。
    const isImageRound = !trimmedInput && lastIsUserImage;
    if (!sticker && !trimmedInput && !isImageRound) return;

    // 用户真正发起一轮对话：世界书对账等后台旁路（不 await、不阻塞发送）。
    onDialogueStart?.();

    cancelActiveRound();

    const userMessage: ChatMessage | null = sticker
      ? {
          id: crypto.randomUUID(),
          role: 'user',
          type: trimmedInput ? 'text_with_sticker' : 'sticker',
          content: trimmedInput || '[表情]',
          sticker,
          createdAt: Date.now(),
        }
      : trimmedInput
        ? { id: crypto.randomUUID(), role: 'user', content: trimmedInput }
        : null;
    const pendingMessageId = crypto.randomUUID();
    const roundId = `chat-round-${Date.now()}-${roundCounterRef.current + 1}`;
    const historyMessages = currentMessages.filter((message) => !message.pendingStatus);

    roundCounterRef.current += 1;
    activeRoundIdRef.current = roundId;
    pendingMessageIdRef.current = pendingMessageId;

    const nextMessages = userMessage ? [...historyMessages, userMessage] : historyMessages;
    setMessages([
      ...nextMessages,
      {
        id: pendingMessageId,
        role: 'assistant',
        content: '',
        pendingStatus: 'typing',
      },
    ]);
    setInput('');
    setIsSending(true);

    // 所有用户消息（文字/表情/图片回合外的纯文字）都持久化到服务端——
    // 之前只有 sticker 走这里，纯文字对话重启即丢（用户反馈"聊天记录只剩表情包"）
    if (userMessage) {
      void saveChatMessage(selectedAvatarId, userMessage).catch((error) => {
        console.error('[chat] save user message failed:', error);
      });
    }

    let profilePayload: { files: string[]; clearSlots?: CostumeSlot[] } | undefined;

    const syncRound = syncControllerRef.current.start({
      id: roundId,
      // 云端 LLM + TTS 合成常见会超过 5s。这里保持音画字同步，但给
      // “文本生成 + 音频准备”一个完整窗口，避免文本刚回来前就误降级。
      timeoutMs: 30000,
      onReady: (result) => {
        if (activeRoundIdRef.current !== result.id) return;

        activeRoundRef.current = null;
        activeRoundIdRef.current = null;
        pendingMessageIdRef.current = null;
        setIsSending(false);

        const renderStartedAt = performance.now();
        const response = result.text;
        const motion = result.motion;
        const speech = result.audio;
        const renderToken = segmentRenderTokenRef.current + 1;
        segmentRenderTokenRef.current = renderToken;

        if (result.missingParts.includes('audio')) {
          resetPendingSpeech();
          stopSpeaking();
          setMouthOpen(0);
        }

        if (motion) applyMotionPayload(motion, true);

        if (response) {
          void appendAssistantSegments({
            pendingMessageId,
            response,
            missingParts: result.missingParts,
            renderToken,
            profilePayload,
          });
          addFavorability(selectedAvatarId);
          // 出站表情包：AI 这轮挑了 sticker，就在文本气泡之外补一条助手侧 sticker 消息并渲染（只加分支，不改现有渲染路径）。
          if (response.sticker) {
            const aiSticker = response.sticker;
            setMessages((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                type: 'sticker',
                content: '[表情]',
                sticker: aiSticker,
                createdAt: Date.now(),
              },
            ]);
          }
        } else {
          replaceMessage(pendingMessageId, () => ({
            id: pendingMessageId,
            role: 'assistant',
            content: '回复准备超时，请稍后再试',
            expression: getAvatarNeutralExpressionId(selectedAvatar),
            expressionMix: [{ key: getAvatarNeutralExpressionId(selectedAvatar), weight: 1 }],
            meta: '同步降级',
            syncMissingParts: result.missingParts,
          }));
        }

        const speechStartedAt = performance.now();
        const speechPromise = speech?.start() ?? Promise.resolve();
        const actionStartedAt = performance.now();
        pendingSpeechRef.current = speech ?? null;

        console.log('[response-sync] render dispatch', {
          roundId: result.id,
          degraded: result.degraded,
          missingParts: result.missingParts,
          textDelayMs: Math.round(renderStartedAt - result.firedAt),
          audioStartDelayMs: Math.round(speechStartedAt - renderStartedAt),
          motionStartDelayMs: Math.round(actionStartedAt - renderStartedAt),
        });

        void speechPromise.catch((error) => {
          console.error(error);
          setMouthOpen(0);
        }).finally(() => {
          if (activeRoundIdRef.current === null) {
            pendingSpeechRef.current = null;
          }
        });
      },
    });
    activeRoundRef.current = syncRound;

    try {
      const chatForPrompt = {
        id: selectedAvatarId,
        messages: nextMessages,
        metadata: loadChatMetadata(selectedAvatarId),
        characterName: selectedAvatar.name,
        userName: '用户',
      };
      const { summary, recent } = buildHistoryForPrompt(chatForPrompt);

      const response = await createAssistantResponse({
        avatar: selectedAvatar,
        history: recent,
        chatSummary: summary,
        stickerId: sticker?.id,
        activeProfileCostumeSlots: getActiveProfileCostumeSlots?.() ?? [],
        recentClearedCostumeSlots: getRecentClearedProfileCostumeSlots?.() ?? [],
        recentSetCostumeSlots: getRecentSetProfileCostumeSlots?.() ?? [],
        holoControl,
      });
      if (activeRoundIdRef.current !== roundId || !syncRound.isActive) return;

      // 控制先行：LLM 判出播放控制意图就立刻执行（换歌/切模式是瞬时的），
      // 不等下面的 TTS/渲染——语音确认异步跟上。仅 holo 面 onControl 有值。
      if (response.control) onControl?.(response.control);

      // 异步触发摘要（不阻塞 UI）
      const assistantMessage: ChatMessage = {
        id: pendingMessageId,
        role: 'assistant',
        content: response.reply,
        expression: response.expression,
        expressionMix: response.expressionMix,
        parameterOverrides: response.parameterOverrides,
        meta: response.source,
      };
      const chatForSummary = {
        ...chatForPrompt,
        messages: [...nextMessages, assistantMessage],
      };
      void maybeSummarize(chatForSummary);

      profilePayload = buildProfileTriggerPayload(response);

      syncRound.markTextReady(response);
      syncRound.markMotionReady({
        expressionMix: response.expressionMix,
        parameterOverrides: response.parameterOverrides,
        motion: response.motion,
        // P3：① 情绪层由 emotion+intensity 经 AU solver 解算（②③④ 聊天不再驱动）。
        emotion: response.emotion,
        intensity: response.intensity,
      });

      const hasRichSegments = response.segments.some((segment) => segment.type !== 'text');
      const preparedSpeech = !ttsEnabled || hasRichSegments
        ? null
        : await prepareSpeech({
            text: response.reply,
            // 每角色音色覆盖：avatar.voice 优先于全局 ttsSettings.apiVoice。
            settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
            onMouthChange: setMouthOpen,
            avatarId: selectedAvatarId,
            emotion: response.emotion,
          }).catch((error) => {
            console.error('[response-sync] audio prepare failed, degrading without audio', error);
            return null;
          });
      if (activeRoundIdRef.current !== roundId || !syncRound.isActive) {
        preparedSpeech?.cancel();
        return;
      }

      if (preparedSpeech) {
        onPreparedSpeech?.(preparedSpeech);
      }
      pendingSpeechRef.current = preparedSpeech;
      syncRound.markAudioReady(preparedSpeech);
    } catch (error) {
      if (activeRoundIdRef.current !== roundId) return;

      syncRound.cancel();
      activeRoundRef.current = null;
      activeRoundIdRef.current = null;
      pendingMessageIdRef.current = null;
      setIsSending(false);

      const neutralExpression = getAvatarNeutralExpressionId(selectedAvatar);
      let content = '大模型连接失败. Please check the settings in 大模型设置.';
      let meta = '连接失败';

      if (error instanceof LlmConfigurationError) {
        content = '大模型未配置. Open 大模型设置 and fill in API地址、模型和API密钥.';
        meta = '需要设置';
        openSettings();
      } else if (error instanceof LlmConnectionError) {
        if (error.status === 503) {
          content = '我这会儿有点忙，喘口气，稍等再发一次好吗～';
          meta = '稍后再试';
        } else if (error.status === 429 || isQuotaError(error.message, error.status)) {
          content = 'API 配额已用完，请稍后再试或更换密钥';
          meta = '配额用尽';
          showToast('API 配额已用完，请稍后再试或更换密钥', 'warning', 5000);
        } else {
          content =
            error.status === 401 || error.status === 403
              ? '大模型连接失败. 请检查API密钥是否正确.'
              : '大模型连接失败. 请检查API地址、模型、API密钥和网络连接.';
        }
      } else if (error instanceof QuotaExceededError) {
        content = 'API 配额已用完，请稍后再试或更换密钥';
        meta = '配额用尽';
        showToast('API 配额已用完，请稍后再试或更换密钥', 'warning', 5000);
      } else if (error instanceof LlmResponseFormatError) {
        const raw = error.rawContent || '';
        const replyMatch = raw.match(/"?reply"?\s*:\s*"([^"]+)"/);
        if (replyMatch) {
          content = replyMatch[1];
          meta = '';
        } else {
          content = raw.replace(/[{}[\]]"/g, '').replace(/reply|expression|meta/gi, '').trim().slice(0, 300) || '收到回复但无法解析';
          meta = '';
        }
      }

      replaceMessage(pendingMessageId, () => ({
        id: pendingMessageId,
        role: 'assistant',
        content,
        expression: neutralExpression,
        expressionMix: [{ key: neutralExpression, weight: 1 }],
        meta,
      }));
    }
  }

  // 把 LLM 一回合产出的 motion / expression 文件路径与 clearSlots 转成 profile 触发载荷，
  // 供 v2 driver 外部调度器消费。
  function buildProfileTriggerPayload(response: SyncedTextPayload): { files: string[]; clearSlots?: CostumeSlot[] } {
    const files: string[] = [];

    if (response.motionFile) {
      files.push(response.motionFile);
    }
    if (response.expressionFile) {
      files.push(response.expressionFile);
    }

    const payload = {
      files,
      ...(response.clearSlots && response.clearSlots.length > 0 ? { clearSlots: response.clearSlots } : {}),
    };
    console.info('[trigger] buildProfileTriggerPayload', payload);
    return payload;
  }

  // 应用一轮 motion payload，只驱动 ① 情绪层（经形象合成器 presence.applyEmotion，临时，holdMs 后淡回）。
  //
  // P3：聊天 LLM 只吐 {emotion,intensity}，物理上碰不到 ②服饰/③形态/④动作。
  //  - 该角色有 AUProfile → 用 AU solver 把 {emotion,intensity} 解算成 {expressionMix, parameterOverrides}
  //    （同情绪多次出不同脸 + 互斥/绑定/noisy-OR），再下发 ① 情绪层。
  //  - 该角色无 AUProfile（其它角色）→ 回退到 LLM 给的 expressionMix 临时桥（保持原行为）。
  //  - ②③ 不再由聊天链路驱动（去除「乱点 get_smaller」的根本）：presence.setApparel/setMorph
  //    保留给 journey/DIY 等非聊天路径，这里一律不调。
  // filterMouthParams：正常回复过滤掉口型参数(由 lip-sync 接管)，opening 路径保持原样不过滤。
  function applyMotionPayload(motion: SyncedMotionPayload, filterMouthParams: boolean): void {
    const engine = auEngineRef.current;
    const solved = engine?.ready()
      ? engine.solveEmotion(motion.emotion, motion.intensity ?? 0.65)
      : null;

    if (bypassLegacyLive2dOutputs) {
      // v2 profile 模式：表情/动作走独立的 profile binding，但情绪层 AU 微表情/呼吸参数仍要下发。
      const expressionMix = solved?.expressionMix.filter((layer) =>
        hasAvatarExpression(selectedAvatar, layer.key),
      ) ?? [];
      const lineParams = filterMouthParams
        ? (solved?.parameterOverrides ?? []).filter((po) => !MOUTH_PARAM_IDS_SET.has(po.id))
        : (solved?.parameterOverrides ?? []);
      presence.applyEmotion({
        expressionMix,
        parameterOverrides: lineParams,
        holdMs: EMOTION_HOLD_MS,
      });
      return;
    }

    // solver 命中 → 用其产出；否则回退 LLM expressionMix 临时桥（无 profile 的角色）。
    let emotionMix: ExpressionLayer[] = solved?.expressionMix.length
      ? solved.expressionMix
      : motion.expressionMix;
    // solver 产出的 expressionMix key 收敛到该角色实际存在的表情（去脏，缺失回落基础情绪）。
    emotionMix = emotionMix.filter((layer) => hasAvatarExpression(selectedAvatar, layer.key));
    if (emotionMix.length === 0) {
      emotionMix = motion.expressionMix.filter((layer) =>
        hasAvatarExpression(selectedAvatar, layer.key),
      );
    }

    // 参数层：solver 命中用 solver 的 parameterOverrides，否则用 LLM 给的。回复路径过滤口型参数。
    const rawParams = solved ? solved.parameterOverrides : motion.parameterOverrides;
    const lineParams = filterMouthParams
      ? rawParams.filter((po) => !MOUTH_PARAM_IDS_SET.has(po.id))
      : rawParams;

    presence.applyEmotion({
      expressionMix: emotionMix,
      parameterOverrides: lineParams,
      holdMs: EMOTION_HOLD_MS,
    });

    // 传统 motion 名（与情绪表情正交，opening/回复都按需播放一次）。
    setMotionName(motion.motion);
  }

  async function handleOpening(
    text: string,
    messageId: string,
    openingEmotion?: { emotion?: Emotion; intensity?: number },
  ) {
    cancelActiveRound();

    const roundId = `opening-round-${Date.now()}-${roundCounterRef.current + 1}`;
    roundCounterRef.current += 1;
    activeRoundIdRef.current = roundId;
    pendingMessageIdRef.current = messageId;

    const neutralExpression = getAvatarNeutralExpressionId(selectedAvatar);
    const neutralMix: ExpressionLayer[] = [{ key: neutralExpression, weight: 1 }];

    setMessages((current) => [
      ...current,
      {
        id: messageId,
        role: 'assistant',
        content: '',
        pendingStatus: 'typing',
      },
    ]);
    setIsSending(true);

    // 开场情绪已在「开场生成」阶段一并解算（后端：新引擎 LLM JSON / legacy 启发式），
    // 这里直接拿来用——不再额外打一次客户端 LLM（原 deriveLineEmotion 慢/flaky，已删）。
    // 有 profile 的角色由 AU solver 在 applyMotionPayload 里据 emotion 解算 ① 情绪层；
    // 无 profile 的角色 openMix 回落 neutral（与原无 profile 行为一致）。
    const openEmotion: Emotion = openingEmotion?.emotion ?? 'neutral';
    const openIntensity = openingEmotion?.intensity ?? 0.6;
    const openMix: ExpressionLayer[] = neutralMix;
    const openParams: ParameterOverride[] = [];
    const openExpression = neutralExpression;

    const syncRound = syncControllerRef.current.start({
      id: roundId,
      timeoutMs: 30000,
      onReady: (result) => {
        if (activeRoundIdRef.current !== result.id) return;

        activeRoundRef.current = null;
        activeRoundIdRef.current = null;
        pendingMessageIdRef.current = null;
        setIsSending(false);

        const renderStartedAt = performance.now();
        const speech = result.audio;

        if (result.missingParts.includes('audio')) {
          resetPendingSpeech();
          stopSpeaking();
          setMouthOpen(0);
        }

        const motion = result.motion;
        if (motion) applyMotionPayload(motion, false);

        const nextAssistantMessage: ChatMessage = {
          id: messageId,
          role: 'assistant',
          content: text,
          expression: openExpression,
          expressionMix: openMix,
          parameterOverrides: openParams,
          meta: 'opening',
          syncMissingParts: result.missingParts,
        };

        replaceMessage(messageId, () => nextAssistantMessage);

        const speechStartedAt = performance.now();
        const speechPromise = speech?.start() ?? Promise.resolve();
        const actionStartedAt = performance.now();
        pendingSpeechRef.current = speech ?? null;

        console.log('[response-sync] opening render dispatch', {
          roundId: result.id,
          degraded: result.degraded,
          missingParts: result.missingParts,
          textDelayMs: Math.round(renderStartedAt - result.firedAt),
          audioStartDelayMs: Math.round(speechStartedAt - renderStartedAt),
          motionStartDelayMs: Math.round(actionStartedAt - renderStartedAt),
        });

        void speechPromise.catch((error) => {
          console.error(error);
          setMouthOpen(0);
        }).finally(() => {
          if (activeRoundIdRef.current === null) {
            pendingSpeechRef.current = null;
          }
        });
      },
    });
    activeRoundRef.current = syncRound;

    // Text is immediately ready for opening. The opening onReady handler renders
    // from the local `text`/`neutralMix` and never reads segments/intensity/durationMs,
    // so this is a deliberately partial payload used only to gate sync timing.
    syncRound.markTextReady({
      reply: text,
      expression: openExpression,
      expressionMix: openMix,
      parameterOverrides: openParams,
      motion: undefined,
      source: 'opening',
    } as unknown as SyncedTextPayload);

    // Motion is immediately ready (按推导出的情绪/参数)。
    // P3：开场也走 AU solver——有 profile 的角色用 emotion+intensity 解算 ① 情绪层；
    // 无 profile 的角色回退到推导出的 openMix。
    syncRound.markMotionReady({
      expressionMix: openMix,
      parameterOverrides: openParams,
      motion: undefined,
      emotion: openEmotion,
      intensity: openIntensity,
    });

    // Prepare TTS audio
    try {
      const preparedSpeech = await prepareSpeech({
        text,
        settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
        onMouthChange: setMouthOpen,
      }).catch((error) => {
        console.error('[response-sync] opening audio prepare failed, degrading without audio', error);
        return null;
      });

      if (activeRoundIdRef.current !== roundId || !syncRound.isActive) {
        preparedSpeech?.cancel();
        return;
      }

      if (preparedSpeech) {
        onPreparedSpeech?.(preparedSpeech);
      }
      pendingSpeechRef.current = preparedSpeech;
      syncRound.markAudioReady(preparedSpeech);
    } catch (error) {
      console.error('[opening] unexpected error preparing speech:', error);
      if (activeRoundIdRef.current === roundId) {
        syncRound.cancel();
        activeRoundRef.current = null;
        activeRoundIdRef.current = null;
        pendingMessageIdRef.current = null;
        setIsSending(false);
      }
    }
  }

  // 开场多条版（ALL-320 P2-c）：把服务端返回的 2~4 条短消息按 1s 间隔逐条推气泡，
  // 模仿真人"啪啪啪连发"。返回 cancel()：用户中途插话/切角色时停掉未推的后续条。
  //
  // 为什么不直接对每条调用 handleOpening：handleOpening 走「单活动轮」——每次进入都
  // cancelActiveRound()，会把上一条尚未 onReady（TTS 未就绪，约数秒）的气泡整条删掉，
  // 多条会互相吞。这里改为：每条作为「已完成」气泡直接 append（内容来自服务端，无需
  // 流式/typing），逐条复用同一套 emotion→AU solver（applyMotionPayload）与 TTS
  // （prepareSpeech）原语；TTS 串行入队，避免单声道叠音。
  //
  // 单条（legacy / 降级 / 老服务端）沿用旧的 handleOpening，行为完全不变。
  function handleOpeningSequence(
    msgs: OpeningMessage[],
    intervalMs: number = OPENING_MESSAGE_INTERVAL_MS,
  ): () => void {
    if (!msgs.length) return () => {};

    if (msgs.length === 1) {
      const only = msgs[0];
      void handleOpening(only.content, only.id, { emotion: only.emotion, intensity: only.intensity });
      return () => {};
    }

    // 起点清一次旧轮（清掉可能残留的待定气泡/播放），此后逐条 append 不再动活动轮。
    cancelActiveRound();
    let cancelled = false;
    let ttsChain: Promise<void> = Promise.resolve();

    const neutralExpression = getAvatarNeutralExpressionId(selectedAvatar);
    const neutralMix: ExpressionLayer[] = [{ key: neutralExpression, weight: 1 }];

    const reveal = (m: OpeningMessage) => {
      if (cancelled) return;

      setMessages((current) => [
        ...current,
        {
          id: m.id,
          role: 'assistant',
          content: m.content,
          expression: neutralExpression,
          expressionMix: neutralMix,
          parameterOverrides: [] as ParameterOverride[],
          meta: 'opening',
        },
      ]);

      // 情绪 → AU solver：与 handleOpening onReady 内的 applyMotionPayload 同一路径。
      applyMotionPayload(
        {
          expressionMix: neutralMix,
          parameterOverrides: [],
          motion: undefined,
          emotion: m.emotion ?? 'neutral',
          intensity: m.intensity ?? 0.6,
        },
        false,
      );

      // TTS 串行入队：单声道逐条播，避免叠音；被 cancel 后不再起播。
      ttsChain = ttsChain.then(async () => {
        if (cancelled) return;
        const prepared = await prepareSpeech({
          text: m.content,
          settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
          onMouthChange: setMouthOpen,
        }).catch(() => null);
        if (cancelled || !prepared) {
          prepared?.cancel();
          return;
        }
        onPreparedSpeech?.(prepared);
        await prepared.start().catch(() => {}).finally(() => setMouthOpen(0));
      });
    };

    const cancelTimers = scheduleStagedMessages(msgs, reveal, intervalMs);
    return () => {
      cancelled = true;
      cancelTimers();
      stopSpeaking();
      setMouthOpen(0);
    };
  }

  // 主动消息（旅程 beat / 强制触发）的演出：与普通回复同一条渲染路径——
  // 内容来自服务端而非本地 LLM，但同样经 appendAssistantSegments 拆成
  // 对白气泡 + （动作）灰色旁白气泡，并走带 avatarId/emotion 的 TTS。
  // 取代旧的 handleOpening 单气泡渲染（无分段、TTS 缺 avatarId）。
  async function performProactive(
    content: string,
    emotion?: string,
    intensity?: number,
    messageId: string = `proactive-${Date.now()}`,
  ) {
    if (!content) return;
    cancelActiveRound();

    const roundId = `proactive-round-${Date.now()}-${roundCounterRef.current + 1}`;
    roundCounterRef.current += 1;
    activeRoundIdRef.current = roundId;
    pendingMessageIdRef.current = messageId;

    const neutralExpression = getAvatarNeutralExpressionId(selectedAvatar);
    const neutralMix: ExpressionLayer[] = [{ key: neutralExpression, weight: 1 }];
    const proEmotion: Emotion = (emotion as Emotion) || 'neutral';
    const proIntensity = typeof intensity === 'number' ? intensity : 0.6;

    // 合成与普通回复同形状的 response：单个 text 段，内联 （动作） 交由
    // appendAssistantSegments→splitOutStageDirections 拆成灰色动作旁白气泡。
    const proactiveResponse = {
      reply: content,
      segments: [{ type: 'text', text: content }],
      expression: neutralExpression,
      expressionMix: neutralMix,
      parameterOverrides: [],
      intensity: proIntensity,
      durationMs: 0,
      source: 'opening',
      motion: undefined,
      emotion: proEmotion,
    } as unknown as SyncedTextPayload;

    setMessages((current) => [
      ...current,
      { id: messageId, role: 'assistant', content: '', pendingStatus: 'typing' },
    ]);
    setIsSending(true);

    const syncRound = syncControllerRef.current.start({
      id: roundId,
      timeoutMs: 30000,
      onReady: (result) => {
        if (activeRoundIdRef.current !== result.id) return;
        activeRoundRef.current = null;
        activeRoundIdRef.current = null;
        pendingMessageIdRef.current = null;
        setIsSending(false);

        const renderToken = segmentRenderTokenRef.current + 1;
        segmentRenderTokenRef.current = renderToken;

        if (result.missingParts.includes('audio')) {
          resetPendingSpeech();
          stopSpeaking();
          setMouthOpen(0);
        }

        const motion = result.motion;
        if (motion) applyMotionPayload(motion, true);

        const response = result.text;
        if (response) {
          void appendAssistantSegments({
            pendingMessageId: messageId,
            response,
            missingParts: result.missingParts,
            renderToken,
          });
        } else {
          replaceMessage(messageId, () => null);
        }

        const speech = result.audio;
        const speechPromise = speech?.start() ?? Promise.resolve();
        pendingSpeechRef.current = speech ?? null;
        void speechPromise.catch((error) => {
          console.error(error);
          setMouthOpen(0);
        }).finally(() => {
          if (activeRoundIdRef.current === null) pendingSpeechRef.current = null;
        });
      },
    });
    activeRoundRef.current = syncRound;

    syncRound.markTextReady(proactiveResponse);
    syncRound.markMotionReady({
      expressionMix: neutralMix,
      parameterOverrides: [],
      motion: undefined,
      emotion: proEmotion,
      intensity: proIntensity,
    });

    try {
      const hasRichSegments = proactiveResponse.segments.some((segment) => segment.type !== 'text');
      const preparedSpeech = !ttsEnabled || hasRichSegments
        ? null
        : await prepareSpeech({
            text: content,
            settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
            onMouthChange: setMouthOpen,
            avatarId: selectedAvatarId,
            emotion: proEmotion,
          }).catch((error) => {
            console.error('[proactive] audio prepare failed, degrading without audio', error);
            return null;
          });
      if (activeRoundIdRef.current !== roundId || !syncRound.isActive) {
        preparedSpeech?.cancel();
        return;
      }
      if (preparedSpeech) {
        onPreparedSpeech?.(preparedSpeech);
      }
      pendingSpeechRef.current = preparedSpeech;
      syncRound.markAudioReady(preparedSpeech);
    } catch (error) {
      console.error('[proactive] unexpected error preparing speech:', error);
      if (activeRoundIdRef.current === roundId) {
        syncRound.cancel();
        activeRoundRef.current = null;
        activeRoundIdRef.current = null;
        pendingMessageIdRef.current = null;
        setIsSending(false);
      }
    }
  }

  // 通话演出：她的定稿字幕（RTC subtitle）→ 本地规则判情绪 → 复用聊天同一条 ① 情绪层链路
  // （AU solver 解算 + holdMs 淡回 + 无 profile 角色优雅降级）。拿不准（null）保持原表情不动；
  // 角色动作库里有匹配该情绪的动作组则顺带播一次。
  //
  // expressionMix 这里给的是**没 profile 角色的回落**：applyMotionPayload 的既有语义就是
  // 「solver 命中用 solver 的，否则用传进来的 expressionMix」，所以有 profile 的角色行为完全不变，
  // 只有声明了 emotionExpressions 的（电台幽灵狗）才靠这张表把 exp3 真正点亮。
  function performCallUtterance(text: string): void {
    const hit = classifyCallEmotion(text);
    if (!hit) return;
    applyMotionPayload(
      {
        emotion: hit.emotion,
        intensity: hit.intensity,
        expressionMix: expressionMixForEmotion(selectedAvatar, hit.emotion),
        parameterOverrides: [],
        motion: findEmotionMotion(selectedAvatar.motions, hit.emotion),
      },
      true,
    );
  }

  return { input, setInput, isSending, ttsState, cancelTts, handleSubmit, handleOpening, handleOpeningSequence, performProactive, performCallUtterance } as const;
}
