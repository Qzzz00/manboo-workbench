// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/VoiceBindingsForm.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import VoiceBindingsForm from './VoiceBindingsForm';
import { toast } from '@/shared/components/toast';
import { AdminApiError } from '@/shared/api/errors';
import type { VoiceSettings } from '@/shared/types';
import type { PutVoiceSettingsPayload } from '../api/voiceSettings';

const mocks = vi.hoisted(() => ({
  getVoiceSettings: vi.fn(),
  putVoiceSettings: vi.fn(),
  listVoiceMappings: vi.fn(),
  resolveVoiceMapping: vi.fn(),
  putVoiceMapping: vi.fn(),
  deleteVoiceMapping: vi.fn(),
  previewVoice: vi.fn(),
  listTtsProviders: vi.fn(),
  getTtsVoices: vi.fn(),
  listRtcProviders: vi.fn(),
  putVoiceBinding: vi.fn(),
  deleteVoiceBinding: vi.fn(),
}));

vi.mock('@/features/avatars/api', () => ({
  putVoiceBinding: mocks.putVoiceBinding,
  deleteVoiceBinding: mocks.deleteVoiceBinding,
}));

vi.mock('@/features/avatars/api/voiceSettings', () => ({
  getVoiceSettings: mocks.getVoiceSettings,
  putVoiceSettings: mocks.putVoiceSettings,
  listVoiceMappings: mocks.listVoiceMappings,
  resolveVoiceMapping: mocks.resolveVoiceMapping,
  putVoiceMapping: mocks.putVoiceMapping,
  deleteVoiceMapping: mocks.deleteVoiceMapping,
  previewVoice: mocks.previewVoice,
}));

vi.mock('@/features/settings/api/ttsProviders', () => ({
  listTtsProviders: mocks.listTtsProviders,
  getTtsVoices: mocks.getTtsVoices,
}));

vi.mock('@/features/settings/api/rtcProviders', () => ({
  listRtcProviders: mocks.listRtcProviders,
}));

vi.mock('@/shared/components/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mockGetSettings = mocks.getVoiceSettings;
const mockPutSettings = mocks.putVoiceSettings;
const mockListTts = mocks.listTtsProviders;
const mockListRtc = mocks.listRtcProviders;
const mockGetVoices = mocks.getTtsVoices;
const mockPreview = mocks.previewVoice;
const mockListMappings = mocks.listVoiceMappings;
const mockPutMapping = mocks.putVoiceMapping;
const mockDeleteMapping = mocks.deleteVoiceMapping;
const mockPutBinding = mocks.putVoiceBinding;

const ttsProviders = [{ id: 'tts_minimax', name: 'MiniMax', provider_type: 'minimax' }];
const rtcProviders = [{ id: 'rtc_volc', name: '火山 RTC', provider_type: 'volcengine_rtc' }];

type AudioMock = { play: ReturnType<typeof vi.fn>; src?: string };
let audioInstances: AudioMock[];

function mockAudioFactory() {
  audioInstances = [];
  const AudioMockClass = vi.fn(function Audio(this: AudioMock, src?: string) {
    Object.assign(this, { play: vi.fn().mockResolvedValue(undefined), src });
    audioInstances.push(this);
  }) as unknown as typeof Audio;
  vi.stubGlobal('Audio', AudioMockClass);
  return AudioMockClass;
}

function independentSettings(): VoiceSettings {
  return {
    avatar_id: 'av1',
    voice_sync_mode: 'independent',
    base_voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' },
    rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
  };
}

function echoVoiceSettings(p: PutVoiceSettingsPayload): VoiceSettings {
  return {
    avatar_id: p.avatar_id,
    voice_sync_mode: p.voice_sync_mode,
    base_voice: p.base_voice ?? null,
    rtc_voice: p.rtc_voice ?? null,
  };
}

async function renderForm(settings: VoiceSettings) {
  mockGetSettings.mockResolvedValue(settings);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<VoiceBindingsForm avatarId="av1" initialBindings={[]} />);
  });
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {});
}

function findRadio(container: HTMLElement, value: string): HTMLInputElement {
  const el = container.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`radio "${value}" not found`);
  return el;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
  if (!el) throw new Error(`button "${label}" not found`);
  return el;
}

function findAllPreviewButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.includes('试听')) as HTMLButtonElement[];
}

/** 基准/RTC 槽位（independent）渲染为自定义手填输入（getTtsVoices 缺省空列表）。index 0=基准，1=RTC。 */
function findVoiceInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[placeholder="手填 voice_type / speaker_id"]')) as HTMLInputElement[];
}

// 契约 fixture（与 server 复现样例一致）：minimax/male-qn-jingying ↔ volcengine_rtc/zh_male_taocheng_uranus_bigtts。
function mappingFixture(overrides: Partial<import('@/shared/types').LogicalVoiceMapping> = {}) {
  return {
    id: 'lv-jingying',
    logical_voice_id: 'lv-jingying',
    base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
    rtc_voice: { provider_id: 'rtc_volc', voice_id: 'zh_male_taocheng_uranus_bigtts' },
    enabled: true,
    ...overrides,
  } as import('@/shared/types').LogicalVoiceMapping;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectOption(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function qTestId<T extends HTMLElement = HTMLElement>(container: HTMLElement, id: string): T {
  const el = container.querySelector(`[data-testid="${id}"]`) as T | null;
  if (!el) throw new Error(`testid "${id}" not found`);
  return el;
}

beforeEach(() => {
  mockGetSettings.mockReset();
  mockPutSettings.mockReset();
  mockListTts.mockReset();
  mockListRtc.mockReset();
  mockGetVoices.mockReset();
  mockPreview.mockReset();
  mockListMappings.mockReset();
  mockPutMapping.mockReset();
  mockDeleteMapping.mockReset();
  mockPutBinding.mockReset();
  mockPutBinding.mockImplementation(async (avatarId: string, scene: string, p: { providerId: string; voiceId: string }) => ({
    avatar_id: avatarId, scene, provider_id: p.providerId, voice_id: p.voiceId,
  }));
  mockListMappings.mockResolvedValue([] as never);
  mockPutMapping.mockResolvedValue({} as never);
  mockDeleteMapping.mockResolvedValue(undefined as never);
  mockListTts.mockResolvedValue(ttsProviders as never);
  mockListRtc.mockResolvedValue(rtcProviders as never);
  mockGetVoices.mockResolvedValue({ official: [], cloned: [] } as never);
  mockPutSettings.mockImplementation(async (p: PutVoiceSettingsPayload) => echoVoiceSettings(p));
  mockPreview.mockResolvedValue({
    audio_url: 'https://cdn.example.com/preview-rtc.mp3',
    duration_ms: 3000,
    expires_at: '2099-01-01T00:00:00Z',
  } as never);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  audioInstances = [];
});

describe('VoiceBindingsForm 同步模式', () => {
  it('独立模式：两侧均可编辑，渲染三个模式单选', async () => {
    const { container, cleanup } = await renderForm(independentSettings());

    expect(findRadio(container, 'independent').checked).toBe(true);
    expect(findRadio(container, 'follow_base').checked).toBe(false);
    expect(findRadio(container, 'follow_rtc').checked).toBe(false);

    expect(container.querySelector('.readonly-banner')).toBeNull();
    cleanup();
  });

  it('follow_base：RTC 侧只读并显示跟随基准音色', async () => {
    const { container, cleanup } = await renderForm({
      ...independentSettings(),
      voice_sync_mode: 'follow_base',
    });

    expect(findRadio(container, 'follow_base').checked).toBe(true);
    const banner = container.querySelector('.readonly-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('跟随基准音色');
    cleanup();
  });

  it('follow_rtc：基准侧只读并显示跟随通话音色', async () => {
    const { container, cleanup } = await renderForm({
      ...independentSettings(),
      voice_sync_mode: 'follow_rtc',
    });

    expect(findRadio(container, 'follow_rtc').checked).toBe(true);
    const banner = container.querySelector('.readonly-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('跟随通话音色');
    cleanup();
  });

  it('初始化加载不触发 PUT（切换即保存不含初始化）', async () => {
    await renderForm(independentSettings());
    expect(mockPutSettings).not.toHaveBeenCalled();
  });

  it('相同值不重复保存：无任何变更时不再发 PUT', async () => {
    const { container, cleanup } = await renderForm(independentSettings());
    // 再次触发同一模式单选（值未变）→ 不应产生新请求
    await act(async () => {
      findRadio(container, 'independent').click();
    });
    expect(mockPutSettings).not.toHaveBeenCalled();
    cleanup();
  });

  it('切换基准音色自动保存独立模式两侧完整音色', async () => {
    const { container, cleanup } = await renderForm(independentSettings());
    expect(mockPutSettings).not.toHaveBeenCalled();

    const baseInput = findVoiceInputs(container)[0];
    act(() => setInputValue(baseInput, 'female-new'));
    await flush();

    expect(mockPutSettings).toHaveBeenCalledWith({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'female-new' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
    });
    expect(container.textContent).toContain('已自动保存');
    cleanup();
  });

  it('切换模式到统一模式（有启用映射）自动保存，只提交源侧', async () => {
    mockListMappings.mockResolvedValue([mappingFixture()] as never);
    const settings: VoiceSettings = {
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
    };
    const { container, cleanup } = await renderForm(settings);

    await act(async () => {
      findRadio(container, 'follow_base').click();
    });

    expect(mockPutSettings).toHaveBeenCalledWith({
      avatar_id: 'av1',
      voice_sync_mode: 'follow_base',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
    });
    cleanup();
  });

  it('统一模式无启用映射：不发送 PUT，显示引导，不静默切换模式', async () => {
    mockListMappings.mockResolvedValue([] as never);
    const { container, cleanup } = await renderForm(independentSettings());

    await act(async () => {
      findRadio(container, 'follow_base').click();
    });

    expect(mockPutSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain('暂无可用映射');
    cleanup();
  });

  it('统一模式有映射但服务端仍拒绝：展示后端错误 code，不伪造成功', async () => {
    mockListMappings.mockResolvedValue([mappingFixture()] as never);
    mockPutSettings.mockRejectedValueOnce(
      new AdminApiError('当前音色没有可用的逻辑音色映射', 400, 'VOICE_MAPPING_NOT_FOUND'),
    );
    const settings: VoiceSettings = {
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
    };
    const { container, cleanup } = await renderForm(settings);

    await act(async () => {
      findRadio(container, 'follow_base').click();
    });
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('当前音色没有可用的逻辑音色映射（VOICE_MAPPING_NOT_FOUND）');
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(container.textContent).toContain('保存失败');
    cleanup();
  });

  it('分别配置只选基准：按场景 PUT chat，不碰 rtc，也不走 voice-settings', async () => {
    const { container, cleanup } = await renderForm({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: null,
    });
    expect(container.textContent).toContain('选齐基准音色');

    const [baseProvider] = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
    act(() => selectOption(baseProvider, 'tts_minimax'));
    await flush();
    // 只选了 provider，音色还空 → 不发请求
    expect(mockPutBinding).not.toHaveBeenCalled();

    const baseInput = findVoiceInputs(container)[0];
    act(() => setInputValue(baseInput, 'female-new'));
    await flush();

    expect(mockPutBinding).toHaveBeenCalledTimes(1);
    expect(mockPutBinding).toHaveBeenCalledWith('av1', 'chat', { providerId: 'tts_minimax', voiceId: 'female-new' });
    expect(mockPutSettings).not.toHaveBeenCalled();
    const status = qTestId(container, 'voice-save-status').textContent ?? '';
    expect(status).toContain('已自动保存 · 基准');
    expect(status).not.toContain('已自动保存 · 通话');
    expect(status).toContain('通话音色可选，需要打电话时再配');
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    cleanup();
  });

  it('分别配置只选通话：按场景 PUT rtc，不碰 chat', async () => {
    const { container, cleanup } = await renderForm({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: null,
    });

    const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
    act(() => selectOption(selects[1], 'rtc_volc'));
    await flush();
    const rtcInput = findVoiceInputs(container)[1];
    act(() => setInputValue(rtcInput, 'S_new'));
    await flush();

    expect(mockPutBinding).toHaveBeenCalledTimes(1);
    expect(mockPutBinding).toHaveBeenCalledWith('av1', 'rtc', { providerId: 'rtc_volc', voiceId: 'S_new' });
    expect(mockPutSettings).not.toHaveBeenCalled();
    const status = qTestId(container, 'voice-save-status').textContent ?? '';
    expect(status).toContain('已自动保存 · 通话');
    expect(status).not.toContain('已自动保存 · 基准');
    cleanup();
  });

  it('分别配置两侧都不选：不发任何请求', async () => {
    const { container, cleanup } = await renderForm({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: null,
    });
    await act(async () => {
      findRadio(container, 'independent').click();
    });
    await flush();
    expect(mockPutBinding).not.toHaveBeenCalled();
    expect(mockPutSettings).not.toHaveBeenCalled();
    cleanup();
  });

  it('刷新后基准已存、通话为空：不重发请求，提示基准已保存', async () => {
    const { container, cleanup } = await renderForm({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' },
      rtc_voice: null,
    });
    expect(mockPutBinding).not.toHaveBeenCalled();
    expect(mockPutSettings).not.toHaveBeenCalled();
    expect(qTestId(container, 'voice-save-status').textContent).toContain('基准音色已保存；通话音色可选');

    // 改基准 → 只重存 chat
    act(() => setInputValue(findVoiceInputs(container)[0], 'female-new'));
    await flush();
    expect(mockPutBinding).toHaveBeenCalledWith('av1', 'chat', { providerId: 'tts_minimax', voiceId: 'female-new' });
    expect(mockPutSettings).not.toHaveBeenCalled();
    cleanup();
  });

  it('分别配置按场景保存失败：展示错误，不伪造成功', async () => {
    mockPutBinding.mockRejectedValueOnce(new AdminApiError('voice not found', 400, 'voice_not_found'));
    const { container, cleanup } = await renderForm({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: null,
    });
    const [baseProvider] = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
    act(() => selectOption(baseProvider, 'tts_minimax'));
    await flush();
    act(() => setInputValue(findVoiceInputs(container)[0], 'bad'));
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('voice not found（voice_not_found）');
    expect(container.textContent).toContain('保存失败');
    expect(container.textContent).not.toContain('已自动保存');
    cleanup();
  });

  it('音色区顶部说明本区自动保存，与左侧保存按钮无关', async () => {
    const { container, cleanup } = await renderForm(independentSettings());
    expect(qTestId(container, 'voice-autosave-note').textContent).toContain('本区改动自动保存');
    cleanup();
  });

  it('统一模式黄字提示补「没有通话需求就选分别配置」', async () => {
    mockListMappings.mockResolvedValue([] as never);
    const { container, cleanup } = await renderForm(independentSettings());
    await act(async () => {
      findRadio(container, 'follow_base').click();
    });
    expect(container.textContent).toContain('没有通话需求就选「分别配置」');
    cleanup();
  });

  it('连续快速切换：旧响应不覆盖新状态，只保留最终值', async () => {
    const calls: PutVoiceSettingsPayload[] = [];
    let resolveFirst!: (v: VoiceSettings) => void;
    mockPutSettings.mockImplementationOnce((p: PutVoiceSettingsPayload) => {
      calls.push(p);
      return new Promise<VoiceSettings>((resolve) => { resolveFirst = resolve; });
    });
    mockPutSettings.mockImplementationOnce((p: PutVoiceSettingsPayload) => {
      calls.push(p);
      return Promise.resolve(echoVoiceSettings(p));
    });

    const { container, cleanup } = await renderForm(independentSettings());
    const baseInput = findVoiceInputs(container)[0];

    act(() => setInputValue(baseInput, 'female-A'));
    await flush(); // 第一次保存处于 in-flight

    act(() => setInputValue(baseInput, 'female-B'));
    await flush(); // 排队第二次保存

    // 旧响应（A）此刻返回，但已有更新的待保存状态，不得写回 UI
    await act(async () => {
      resolveFirst(echoVoiceSettings({
        avatar_id: 'av1',
        voice_sync_mode: 'independent',
        base_voice: { provider_id: 'tts_minimax', voice_id: 'female-A' },
        rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
      }));
    });
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'female-B' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
    });
    expect(findVoiceInputs(container)[0].value).toBe('female-B');
    cleanup();
  });

  it('RTC 音色未选定时试听按钮禁用', async () => {
    const { container, cleanup } = await renderForm({
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: null,
    });

    const previewBtns = findAllPreviewButtons(container);
    expect(previewBtns.length).toBeGreaterThan(0);
    for (const b of previewBtns) expect((b as HTMLButtonElement).disabled).toBe(true);
    cleanup();
  });

  it('RTC 试听：POST /api/voices/preview，body 含 provider/voice_id/scene = rtc，用 audio_url 播放', async () => {
    const settings: VoiceSettings = {
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
    };
    mockAudioFactory();
    const { container, cleanup } = await renderForm(settings);

    const rtcBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('试听') && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    expect(rtcBtn).toBeDefined();

    await act(async () => {
      rtcBtn!.click();
    });

    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview).toHaveBeenCalledWith({
      provider_id: 'rtc_volc',
      voice_id: 'S_cloned',
      scene: 'rtc',
    });
    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].src).toBe('https://cdn.example.com/preview-rtc.mp3');
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    cleanup();
  });

  it('base 槽位试听：scene = base，按 provider/voice_id 发送', async () => {
    mockAudioFactory();
    const { container, cleanup } = await renderForm(independentSettings());

    const baseBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('试听') && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    expect(baseBtn).toBeDefined();

    await act(async () => {
      baseBtn!.click();
    });

    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview).toHaveBeenCalledWith({
      provider_id: 'tts_minimax',
      voice_id: 'female-yujie',
      scene: 'base',
    });
    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('请求失败：展示错误 toast，不播放', async () => {
    mockAudioFactory();
    mockPreview.mockRejectedValue(new Error('上游试听失败'));
    const { container, cleanup } = await renderForm(independentSettings());

    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('试听') && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeDefined();

    await act(async () => {
      btn!.click();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('上游试听失败');
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(audioInstances).toHaveLength(0);
    cleanup();
  });

  it('响应缺少 audio_url：展示错误 toast，不播放、不伪造成功', async () => {
    mockAudioFactory();
    mockPreview.mockResolvedValue({ expires_at: '2099-01-01T00:00:00Z' } as never);
    const { container, cleanup } = await renderForm(independentSettings());

    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('试听') && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeDefined();

    await act(async () => {
      btn!.click();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('试听失败：接口未返回可用的音频地址');
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(audioInstances).toHaveLength(0);
    cleanup();
  });

  it('RTC 选定后可试听，请求期间重复点击只发一次请求', async () => {
    const settings: VoiceSettings = {
      avatar_id: 'av1',
      voice_sync_mode: 'independent',
      base_voice: null,
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_cloned' },
    };
    mockAudioFactory();
    const { container, cleanup } = await renderForm(settings);

    const rtcBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('试听') && !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    expect(rtcBtn).toBeDefined();

    let resolvePreview!: (r: unknown) => void;
    mockPreview.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePreview = resolve; }),
    );
    act(() => {
      rtcBtn!.click();
      rtcBtn!.click();
    });
    expect(mockPreview).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePreview({
        audio_url: 'https://cdn.example.com/preview-rtc.mp3',
        expires_at: '2099-01-01T00:00:00Z',
      });
    });
    cleanup();
  });

  it('管理员在页面创建并启用映射：刷新后仍存在且状态正确', async () => {
    mockListMappings.mockResolvedValue([] as never);
    mockPutMapping.mockResolvedValue(mappingFixture() as never);
    const { container, cleanup } = await renderForm(independentSettings());

    await act(async () => {
      findButton(container, '+ 新建映射').click();
    });

    act(() => {
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-logical-id'), 'lv-jingying');
      selectOption(qTestId<HTMLSelectElement>(container, 'voice-mapping-base-provider'), 'tts_minimax');
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-base-voice'), 'male-qn-jingying');
      selectOption(qTestId<HTMLSelectElement>(container, 'voice-mapping-rtc-provider'), 'rtc_volc');
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-rtc-voice'), 'zh_male_taocheng_uranus_bigtts');
    });

    await act(async () => {
      findButton(container, '保存映射').click();
    });

    expect(mockPutMapping).toHaveBeenCalledWith('lv-jingying', {
      base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'zh_male_taocheng_uranus_bigtts' },
      enabled: true,
    });
    expect(mockListMappings).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('映射音色下拉按 Provider 展示官方/复刻并提交 voice_id（不误用显示名）', async () => {
    mockGetVoices.mockImplementation(async ({ kind }: { providerId?: string; kind?: 'tts' | 'rtc' }) => {
      if (kind === 'rtc') {
        return { official: [{ id: 'zh_male_taocheng_uranus_bigtts', name: '涛承男声' }], cloned: [] };
      }
      return { official: [{ id: 'male-qn-jingying', name: '精英男声' }], cloned: [] };
    });
    mockListMappings.mockResolvedValue([] as never);
    mockPutMapping.mockResolvedValue(mappingFixture() as never);
    const { container, cleanup } = await renderForm(independentSettings());

    await act(async () => {
      findButton(container, '+ 新建映射').click();
    });

    act(() => {
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-logical-id'), 'lv-jingying');
      selectOption(qTestId<HTMLSelectElement>(container, 'voice-mapping-base-provider'), 'tts_minimax');
    });
    await flush();

    const baseVoice = qTestId<HTMLSelectElement>(container, 'voice-mapping-base-voice');
    expect(baseVoice.textContent).toContain('精英男声');
    expect(baseVoice.tagName).toBe('SELECT');
    act(() => { selectOption(baseVoice, 'male-qn-jingying'); });

    act(() => { selectOption(qTestId<HTMLSelectElement>(container, 'voice-mapping-rtc-provider'), 'rtc_volc'); });
    await flush();

    const rtcVoice = qTestId<HTMLSelectElement>(container, 'voice-mapping-rtc-voice');
    expect(rtcVoice.textContent).toContain('涛承男声');
    act(() => { selectOption(rtcVoice, 'zh_male_taocheng_uranus_bigtts'); });

    await act(async () => {
      findButton(container, '保存映射').click();
    });

    expect(mockPutMapping).toHaveBeenCalledWith('lv-jingying', {
      base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'zh_male_taocheng_uranus_bigtts' },
      enabled: true,
    });
    cleanup();
  });

  it('映射保存失败：展示稳定 code 且表单不关闭', async () => {
    mockListMappings.mockResolvedValue([] as never);
    mockPutMapping.mockRejectedValueOnce(new AdminApiError('逻辑音色映射冲突', 400, 'mapping_conflict'));
    const { container, cleanup } = await renderForm(independentSettings());

    await act(async () => {
      findButton(container, '+ 新建映射').click();
    });

    act(() => {
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-logical-id'), 'lv-dup');
      selectOption(qTestId<HTMLSelectElement>(container, 'voice-mapping-base-provider'), 'tts_minimax');
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-base-voice'), 'male-qn-jingying');
      selectOption(qTestId<HTMLSelectElement>(container, 'voice-mapping-rtc-provider'), 'rtc_volc');
      setInputValue(qTestId<HTMLInputElement>(container, 'voice-mapping-rtc-voice'), 'zh_male_taocheng_uranus_bigtts');
    });

    await act(async () => {
      findButton(container, '保存映射').click();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('逻辑音色映射冲突（mapping_conflict）');
    // 失败保留表单（不关闭）
    expect(qTestId(container, 'voice-mapping-form')).not.toBeNull();
    cleanup();
  });

  it('停用/删除映射：调用对应接口且刷新列表', async () => {
    mockListMappings.mockResolvedValue([mappingFixture()] as never);
    mockDeleteMapping.mockResolvedValue(undefined as never);
    const { container, cleanup } = await renderForm(independentSettings());

    expect(container.textContent).toContain('→');

    await act(async () => {
      findButton(container, '删除').click();
    });
    expect(mockDeleteMapping).toHaveBeenCalledWith('lv-jingying');
    expect(mockListMappings).toHaveBeenCalledTimes(2);
    cleanup();
  });
});