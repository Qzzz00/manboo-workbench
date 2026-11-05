import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('./authStore.ts', () => ({
  apiFetch: vi.fn(),
  getStoredToken: vi.fn(),
  ApiAuthError: class ApiAuthError extends Error {},
}));

vi.mock('../features/live2d/profile/v2Loader.ts', () => ({
  loadV2Profile: vi.fn(),
  loadV2MotionProfile: vi.fn(),
  loadV2ExpressionProfile: vi.fn(),
  validateV2Profile: vi.fn(),
}));

// journeyStore 通过 apiClient.apiGet 拉当前节拍；mock 它以断言「发消息前懒刷新」的请求去重。
vi.mock('./apiClient.ts', () => ({ apiGet: vi.fn() }));

import { apiFetch } from './authStore.ts';
import { apiGet } from './apiClient.ts';
import { API_JOURNEY_CURRENT_BEAT } from './apiConfig.ts';
import { loadV2Profile } from '../features/live2d/profile/v2Loader.ts';
import { createAssistantResponse, type ChatMessage } from './llm.ts';
import { getAvatarById } from '../features/live2d/avatarManifest.ts';
import type { AvatarManifest } from '../features/live2d/avatarManifest.ts';
import type { V2Profile } from '../features/live2d/profile/v2Types.ts';
import { installTestAvatars } from '../features/live2d/testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

const mockedApiFetch = vi.mocked(apiFetch);
const mockedApiGet = vi.mocked(apiGet);
const mockedLoadV2Profile = vi.mocked(loadV2Profile);

/**
 * node 测试环境无全局 localStorage；journeyStore 靠它持久化节拍拉取时间戳。
 * 不打这个内存版 stub，fetchedAt 无法留存，懒刷新的去重就失效（每次都会重新拉）。
 */
function installLocalStorageStub() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const mockV2Profile: V2Profile = {
  role: 'shuangsheng',
  motion: {
    role: 'shuangsheng',
    kind: 'motion',
    version: 'v2',
    items: [
      { id: 'idle', file: 'idle.motion3.json', group: 'idle', loop: true, hint: '待机' },
      { id: 'happy', file: 'motions/happy.motion3.json', group: 'default', loop: false, hint: '开心' },
      { id: 'sleepy', file: 'motions/sleepy.motion3.json', group: 'default', loop: false, hint: '困' },
      { id: 'nod', file: 'motions/nod.motion3.json', group: 'default', loop: false, hint: '点头' },
    ],
  },
  expression: {
    role: 'shuangsheng',
    kind: 'expression',
    version: 'v2',
    items: [
      { id: 'aixin', file: 'aixin.exp3.json', category: 'prop', hint: '爱心', keywords: ['爱心', '心心', '喜欢你', '我喜欢', '爱你', '么么哒', '亲亲'] },
      { id: 'baisi', file: 'baisi.exp3.json', category: 'costume', hint: '白丝', slot: 'legwear', keywords: ['白丝', '换白丝'] },
      { id: 'baowawa', file: 'baowawa.exp3.json', category: 'costume', hint: '抱娃娃', slot: 'handheld', keywords: ['娃娃', '抱娃', '棉花', '小熊', '小兔子', '布偶'] },
      { id: 'changge', file: 'changge.exp3.json', category: 'prop', hint: '唱歌', keywords: ['唱歌', '唱一首', '唱一段', '唱一下'] },
      { id: 'heilian', file: 'heilian.exp3.json', category: 'emotion', hint: '黑脸', keywords: ['生气', '讨厌', '烦', '不理你', '哼', '无语'] },
      { id: 'huanzhuang', file: 'huanzhuang.exp3.json', category: 'costume', hint: '换装', slot: 'outfit', keywords: ['换装', '换衣服', '换一套'] },
      { id: 'jiyan', file: 'jiyan.exp3.json', category: 'prop', hint: '亮闪闪眼', keywords: ['眼睛亮', '好棒', '好厉害', '太酷了', '崇拜'] },
      { id: 'lianhong', file: 'lianhong.exp3.json', category: 'emotion', hint: '脸红', keywords: ['脸红', '害羞', '不好意思', '好害羞'] },
      { id: 'tousi', file: 'tousi.exp3.json', category: 'costume', hint: '头饰', slot: 'headwear', keywords: ['头饰', '发卡', '戴上'] },
      { id: 'waitao', file: 'waitao.exp3.json', category: 'costume', hint: '外套', slot: 'outerwear', keywords: ['外套', '穿外套', '披外套', '披上'] },
      { id: 'yanlei', file: 'yanlei.exp3.json', category: 'emotion', hint: '眼泪', keywords: ['哭', '眼泪', '委屈', '难过', '想哭'] },
      { id: 'yun', file: 'yun.exp3.json', category: 'prop', hint: '晕', keywords: ['头晕', '晕', '转圈', '好累'] },
    ],
  },
};

function userMessage(content: string): ChatMessage {
  return { id: '1', role: 'user', type: 'text', content };
}

function makeAvatar(): AvatarManifest {
  return {
    id: 'shuangsheng',
    name: '霜声',
    summary: '测试角色',
    persona: { tone: '温柔', traits: ['安静'], styleRules: [] },
    modelJson: '',
    scaleMultiplier: 1,
    verticalOffset: 0,
    modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
    transformDefaults: { scale: 1, offsetX: 0, offsetY: 0 },
    expressions: [{ id: 'neutral', label: 'neutral', file: 'neutral.exp3.json' }],
  } as unknown as AvatarManifest;
}

function mockLlmReply(reply: string) {
  mockedApiFetch.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ reply }) } }],
  });
}

describe('createAssistantResponse local classifier fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedLoadV2Profile.mockResolvedValue(mockV2Profile);
  });

  it('LLM 没给 motion/expression 时用本地关键词兜底 expression', async () => {
    const avatar = getAvatarById('shuangsheng')!;
    (apiFetch as Mock).mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ reply: '好呀' }) } }],
    });

    const response = await createAssistantResponse({
      avatar,
      history: [userMessage('给我看看娃娃')],
    });

    expect(response.expressionFile).toContain('baowawa.exp3.json');
    expect(response.motionFile).toBeUndefined();
  });

  it('LLM 给了 motion 时不被本地兜底覆盖', async () => {
    const avatar = getAvatarById('shuangsheng')!;
    (apiFetch as Mock).mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ reply: '嗨', motion: 'happy' }) } }],
    });

    const response = await createAssistantResponse({
      avatar,
      history: [userMessage('你好')],
    });

    expect(response.motionFile).toBe('motions/happy.motion3.json');
    expect(response.expressionFile).toBeUndefined();
  });

  it('text fallback 时也会带上 classifier 结果', async () => {
    const avatar = getAvatarById('shuangsheng')!;
    (apiFetch as Mock)
      .mockResolvedValueOnce({ choices: [{ message: { content: '好呀，给你看娃娃' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '好吧，看娃娃' } }] });

    const response = await createAssistantResponse({
      avatar,
      history: [userMessage('给我看看娃娃')],
    });

    expect(response.reply).toBeTruthy();
    expect(response.expressionFile).toContain('baowawa.exp3.json');
  });
});

describe('createAssistantResponse clearSlots hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadV2Profile.mockResolvedValue(mockV2Profile);
  });

  it('LLM 散文含"脱下外套" → LlmReply.clearSlots 含 outerwear', async () => {
    mockLlmReply('（她轻轻脱下外套）');

    const noClear = await createAssistantResponse({
      avatar: makeAvatar(),
      history: [userMessage('今天有点热')],
    });
    expect(noClear.clearSlots).toBeUndefined();

    const withClear = await createAssistantResponse({
      avatar: makeAvatar(),
      history: [userMessage('帮我脱掉外套')],
    });
    expect(withClear.clearSlots).toContain('outerwear');
  });

  it('LLM 散文含"放下娃娃" → LlmReply.clearSlots 含 handheld', async () => {
    mockLlmReply('（她放下娃娃）');

    const noClear = await createAssistantResponse({
      avatar: makeAvatar(),
      history: [userMessage('该睡觉了')],
    });
    expect(noClear.clearSlots).toBeUndefined();

    const withClear = await createAssistantResponse({
      avatar: makeAvatar(),
      history: [userMessage('把娃娃放下')],
    });
    expect(withClear.clearSlots).toContain('handheld');
  });

  it('LLM 未给 expression 时 clearSlots 仍生效', async () => {
    mockLlmReply('好的');

    const response = await createAssistantResponse({
      avatar: makeAvatar(),
      history: [userMessage('帮我脱掉外套')],
    });

    expect(response.expressionFile).toBeUndefined();
    expect(response.clearSlots).toContain('outerwear');
  });

  it('LLM 给了同 slot 的 expression 时，clearSlots 覆盖 set', async () => {
    mockedApiFetch.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ reply: '（她脱下外套）', expression: 'waitao' }) } }],
    });

    const response = await createAssistantResponse({
      avatar: makeAvatar(),
      history: [userMessage('帮我脱掉外套')],
    });

    expect(response.expressionFile).toBeUndefined();
    expect(response.clearSlots).toContain('outerwear');
  });
});

describe('createAssistantResponse 发消息前节拍懒刷新去重', () => {
  beforeEach(() => {
    installLocalStorageStub();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedLoadV2Profile.mockResolvedValue(mockV2Profile);
    mockLlmReply('好呀');
    mockedApiGet.mockResolvedValue({ beat: null });
  });

  it('间隔 <60s 的两次调用，current-beat 底层 apiGet 只触发一次', async () => {
    const avatar = getAvatarById('shuangsheng')!;

    // 两次调用相隔毫秒级（远小于 60s 阈值），第二次应命中缓存不再请求。
    await createAssistantResponse({ avatar, history: [userMessage('你好')] });
    await createAssistantResponse({ avatar, history: [userMessage('在吗')] });

    // 只统计 current-beat 端点：同路径上 #8 记忆注入（memory-events）也走 apiGet，各自去重互不相干。
    const beatCalls = mockedApiGet.mock.calls.filter(([url]) => String(url).includes(API_JOURNEY_CURRENT_BEAT));
    expect(beatCalls).toHaveLength(1);
  });
});
