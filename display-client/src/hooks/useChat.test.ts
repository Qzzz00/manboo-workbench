/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToString } from 'react-dom/server';
import { useChat } from './useChat.ts';
import { createAssistantResponse } from '../lib/llm.ts';
import type { AssistantResponse, ChatMessage, ChatMessageSticker } from '../lib/llm.ts';

vi.mock('../lib/llm.ts', () => ({
  createAssistantResponse: vi.fn(),
  LlmConfigurationError: class LlmConfigurationError extends Error {},
  LlmConnectionError: class LlmConnectionError extends Error {
    status?: number;
  },
  LlmResponseFormatError: class LlmResponseFormatError extends Error {
    rawContent?: string;
  },
}));

vi.mock('../features/live2d/avatarManifest.ts', () => ({
  getAvatarNeutralExpressionId: () => 'neutral',
  hasAvatarExpression: () => true,
}));

vi.mock('../lib/tts.ts', () => ({
  getTtsState: () => 'idle',
  subscribeTtsState: () => () => {},
  stopSpeaking: () => {},
  prepareSpeech: vi.fn(),
}));

vi.mock('../lib/relationshipStore.ts', () => ({
  addFavorability: vi.fn(),
}));

vi.mock('../lib/toastStore.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../lib/errorTypes.ts', () => ({
  QuotaExceededError: class QuotaExceededError extends Error {},
  isQuotaError: () => false,
}));

vi.mock('../lib/chatMedia.ts', () => ({
  generateImage: vi.fn(),
  saveGeneratedImage: vi.fn(),
  saveGeneratedVoice: vi.fn(),
  saveChatMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/memory/index.ts', () => ({
  buildHistoryForPrompt: vi.fn(() => ({ summary: '', recent: [] })),
  maybeSummarize: vi.fn(),
  loadChatMetadata: vi.fn(() => ({})),
}));

vi.mock('../features/live2d/au/auChatEngine.ts', () => ({
  createAuChatEngine: vi.fn(() =>
    Promise.resolve({
      ready: () => false,
      solveEmotion: vi.fn(),
    }),
  ),
}));

vi.mock('../lib/callEmotion.ts', () => ({
  classifyCallEmotion: vi.fn(),
  findEmotionMotion: vi.fn(),
}));

const mockedCreateAssistantResponse = vi.mocked(createAssistantResponse);

function makeAvatar(): any {
  return {
    id: 'test',
    name: 'Test',
    modelJson: '',
    voice: 'test-voice',
    expressions: [{ id: 'neutral', label: 'neutral', file: 'neutral.exp3.json' }],
  };
}

function makeResponse(): AssistantResponse {
  return {
    reply: '第一段第二段第三段',
    segments: [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
      { type: 'text', text: '第三段' },
    ],
    expression: 'neutral',
    expressionMix: [{ key: 'neutral', weight: 1 }],
    parameterOverrides: [],
    emotion: 'neutral',
    intensity: 0.6,
    durationMs: 0,
    source: 'remote',
    motion: undefined,
    motionFile: 'motion.motion3.json',
  } as AssistantResponse;
}

function renderUseChat(props: any) {
  let api: any = null;
  const Component: FC<any> = (p) => {
    api = useChat(p);
    return null;
  };
  renderToString(createElement(Component, props));
  if (!api) throw new Error('useChat did not return API');
  return api;
}

describe('useChat → profile trigger catch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('单段 profile 触发抛错时不中断整条消息流，且打日志、标记 triggerError', async () => {
    const warnSpy = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {});

    let messages: ChatMessage[] = [];
    const setMessages = (
      updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
    ) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    };

    const onProfileTrigger = vi.fn(() => {
      throw new Error('profile scheduler exploded');
    });

    const api = renderUseChat({
      selectedAvatar: makeAvatar(),
      selectedAvatarId: 'test',
      ttsSettings: { apiVoice: 'test-voice' },
      ttsEnabled: false,
      messages,
      setMessages,
      presence: { applyEmotion: vi.fn() },
      setMotionName: vi.fn(),
      setMouthOpen: vi.fn(),
      openSettings: vi.fn(),
      onProfileTrigger,
      bypassLegacyLive2dOutputs: true,
    });

    mockedCreateAssistantResponse.mockResolvedValue(makeResponse());

    const handlePromise = api.handleSubmit('你好');
    // 让 createAssistantResponse 的 Promise 以及 syncRound ready 走一轮
    await vi.advanceTimersByTimeAsync(0);
    await handlePromise;

    // appendAssistantSegments 里按 segmentDelay 等待，推进所有定时器
    await vi.runAllTimersAsync();

    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    // 消息流未中断：3 段 assistant 消息都渲染出来
    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages.map((m) => m.content)).toEqual(['第一段', '第二段', '第三段']);

    // profile 触发只调用一次，且被 catch 住
    expect(onProfileTrigger).toHaveBeenCalledTimes(1);
    expect(onProfileTrigger).toHaveBeenCalledWith({
      files: ['motion.motion3.json'],
    });

    // console.warn 带固定前缀和段上下文
    const warnCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[trigger] profile play failed'),
    );
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toBe('[trigger] profile play failed');
    expect(warnCalls[0][1]).toMatchObject({
      segmentIndex: 0,
      profileId: 'motion.motion3.json',
    });
    expect(String(warnCalls[0][1].error)).toContain('profile scheduler exploded');

    // 抛错段带 triggerError，其余段不带
    expect(assistantMessages[0].triggerError).toContain('profile scheduler exploded');
    expect(assistantMessages[1].triggerError).toBeUndefined();
    expect(assistantMessages[2].triggerError).toBeUndefined();

    warnSpy.mockRestore();
  });
});

describe('useChat → sticker support', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeSticker(): ChatMessageSticker {
    return { id: 'sticker-123', url: 'https://example.com/sticker.png' };
  }

  function makeStickerResponse(): AssistantResponse {
    return {
      ...makeResponse(),
      reply: '收到你的表情啦',
      segments: [{ type: 'text', text: '收到你的表情啦' }],
      sticker: { id: 'sticker-456', url: 'https://example.com/ai-sticker.png' },
    } as AssistantResponse;
  }

  function setupApi(messages: ChatMessage[] = []) {
    const setMessages = (
      updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
    ) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    };

    const api = renderUseChat({
      selectedAvatar: makeAvatar(),
      selectedAvatarId: 'test',
      ttsSettings: { apiVoice: 'test-voice' },
      ttsEnabled: false,
      messages,
      setMessages,
      presence: { applyEmotion: vi.fn() },
      setMotionName: vi.fn(),
      setMouthOpen: vi.fn(),
      openSettings: vi.fn(),
    });

    return { api, getMessages: () => messages };
  }

  it('发送纯 sticker 时生成 type=sticker 的用户消息', async () => {
    const { api, getMessages } = setupApi();
    mockedCreateAssistantResponse.mockResolvedValue(makeResponse());

    const sticker = makeSticker();
    const handlePromise = api.handleSubmit('', sticker);
    await vi.advanceTimersByTimeAsync(0);
    await handlePromise;

    const userMessages = getMessages().filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].type).toBe('sticker');
    expect(userMessages[0].sticker).toEqual(sticker);
    expect(userMessages[0].content).toBe('[表情]');
  });

  it('发送文字+sticker 时生成 type=text_with_sticker 的用户消息', async () => {
    const { api, getMessages } = setupApi();
    mockedCreateAssistantResponse.mockResolvedValue(makeResponse());

    const sticker = makeSticker();
    const handlePromise = api.handleSubmit('hello', sticker);
    await vi.advanceTimersByTimeAsync(0);
    await handlePromise;

    const userMessages = getMessages().filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].type).toBe('text_with_sticker');
    expect(userMessages[0].sticker).toEqual(sticker);
    expect(userMessages[0].content).toBe('hello');
  });

  it('把 sticker id 传给 createAssistantResponse', async () => {
    const { api } = setupApi();
    mockedCreateAssistantResponse.mockResolvedValue(makeResponse());

    const sticker = makeSticker();
    const handlePromise = api.handleSubmit('', sticker);
    await vi.advanceTimersByTimeAsync(0);
    await handlePromise;

    expect(mockedCreateAssistantResponse).toHaveBeenCalledWith(
      expect.objectContaining({ stickerId: sticker.id }),
    );
  });

  it('AI 返回 sticker 时在消息列表追加助手 sticker 消息', async () => {
    const { api, getMessages } = setupApi();
    mockedCreateAssistantResponse.mockResolvedValue(makeStickerResponse());

    const handlePromise = api.handleSubmit('你好');
    await vi.advanceTimersByTimeAsync(0);
    await handlePromise;
    await vi.runAllTimersAsync();

    const stickerMessages = getMessages().filter(
      (m) => m.role === 'assistant' && m.type === 'sticker',
    );
    expect(stickerMessages).toHaveLength(1);
    expect(stickerMessages[0].sticker).toEqual({
      id: 'sticker-456',
      url: 'https://example.com/ai-sticker.png',
    });
  });
});
