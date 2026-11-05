// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/api/voiceSettings.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getVoiceSettings,
  putVoiceSettings,
  listVoiceMappings,
  putVoiceMapping,
  deleteVoiceMapping,
  resolveVoiceMapping,
  previewVoice,
} from './voiceSettings';
import { request } from '@/shared/api/client';
import type { VoiceSettings } from '@/shared/types';

vi.mock('@/shared/api/client', () => ({ request: vi.fn() }));

const mockRequest = vi.mocked(request);

const sample: VoiceSettings = {
  avatar_id: 'av1',
  voice_sync_mode: 'follow_base',
  base_voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' },
  rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_mapped' },
};

beforeEach(() => {
  mockRequest.mockReset();
});

describe('voiceSettings API', () => {
  it('getVoiceSettings 解包 voice_settings 并携带角色 id', async () => {
    mockRequest.mockResolvedValue({ voice_settings: sample });
    await expect(getVoiceSettings('av1')).resolves.toEqual(sample);
    expect(mockRequest).toHaveBeenCalledWith('/api/voice-settings/av1');
  });

  it('putVoiceSettings 发送同步模式与源音色', async () => {
    mockRequest.mockResolvedValue({ voice_settings: sample });
    await putVoiceSettings({
      avatar_id: 'av1',
      voice_sync_mode: 'follow_base',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' },
    });
    expect(mockRequest).toHaveBeenCalledWith('/api/voice-settings', {
      method: 'PUT',
      json: {
        avatar_id: 'av1',
        voice_sync_mode: 'follow_base',
        base_voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' },
      },
    });
  });

  it('listVoiceMappings 解包 mappings', async () => {
    mockRequest.mockResolvedValue({ mappings: [] });
    await expect(listVoiceMappings()).resolves.toEqual([]);
    expect(mockRequest).toHaveBeenCalledWith('/api/voice-mappings');
  });

  it('putVoiceMapping 发送两端音色与 enabled 到 PUT /api/voice-mappings/:id', async () => {
    const mapping = {
      id: 'lv-jingying',
      logical_voice_id: 'lv-jingying',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'zh_male_taocheng_uranus_bigtts' },
      enabled: true,
    };
    mockRequest.mockResolvedValue({ mapping });
    await expect(
      putVoiceMapping('lv-jingying', {
        base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
        rtc_voice: { provider_id: 'rtc_volc', voice_id: 'zh_male_taocheng_uranus_bigtts' },
        enabled: true,
      }),
    ).resolves.toEqual(mapping);
    expect(mockRequest).toHaveBeenCalledWith('/api/voice-mappings/lv-jingying', {
      method: 'PUT',
      json: {
        base_voice: { provider_id: 'tts_minimax', voice_id: 'male-qn-jingying' },
        rtc_voice: { provider_id: 'rtc_volc', voice_id: 'zh_male_taocheng_uranus_bigtts' },
        enabled: true,
      },
    });
  });

  it('deleteVoiceMapping 命中 DELETE /api/voice-mappings/:id', async () => {
    mockRequest.mockResolvedValue(undefined);
    await deleteVoiceMapping('lv-jingying');
    expect(mockRequest).toHaveBeenCalledWith('/api/voice-mappings/lv-jingying', { method: 'DELETE' });
  });

  it('resolveVoiceMapping 按一侧反查', async () => {
    const mapping = {
      logical_voice_id: 'lv-yujie',
      base_voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' },
      rtc_voice: { provider_id: 'rtc_volc', voice_id: 'S_mapped' },
      enabled: true,
    };
    mockRequest.mockResolvedValue({ mapping });
    await expect(
      resolveVoiceMapping('base', { provider_id: 'tts_minimax', voice_id: 'female-yujie' }),
    ).resolves.toEqual(mapping);
    expect(mockRequest).toHaveBeenCalledWith('/api/voice-mappings/resolve', {
      method: 'POST',
      json: { side: 'base', voice: { provider_id: 'tts_minimax', voice_id: 'female-yujie' } },
    });
  });

  it('previewVoice 发送 provider_id/voice_id/scene 到 POST /api/voices/preview', async () => {
    const result = {
      audio_url: '/api/voices/preview-audio/abc/def',
      duration_ms: 1250,
      expires_at: '2099-01-01T00:00:00Z',
    };
    mockRequest.mockResolvedValue(result);
    await expect(
      previewVoice({ provider_id: 'rtc_volc', voice_id: 'S_cloned', scene: 'rtc' }),
    ).resolves.toEqual(result);
    expect(mockRequest).toHaveBeenCalledWith('/api/voices/preview', {
      method: 'POST',
      json: { provider_id: 'rtc_volc', voice_id: 'S_cloned', scene: 'rtc' },
    });
  });

  it('previewVoice 支持 base 场景与自定义文本透传', async () => {
    mockRequest.mockResolvedValue({ audio_url: '/a', expires_at: '2099-01-01T00:00:00Z' });
    await previewVoice({ provider_id: 'tts_minimax', voice_id: 'female-yujie', scene: 'base' });
    expect(mockRequest).toHaveBeenCalledWith('/api/voices/preview', {
      method: 'POST',
      json: { provider_id: 'tts_minimax', voice_id: 'female-yujie', scene: 'base' },
    });
  });
});
