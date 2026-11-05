import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiClient', () => ({ apiPost: vi.fn() }));
import { apiPost } from './apiClient';
import { transcribeBlob, pickRecorderMimeType } from './asr';

// Mock FileReader for Node.js test environment
class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  readAsDataURL(_blob: Blob) {
    // Simulate FileReader converting blob to data URL with base64
    const bytes = new Uint8Array(3);
    bytes[0] = 1;
    bytes[1] = 2;
    bytes[2] = 3;
    this.result = 'data:audio/mp4;base64,AQID';
    if (this.onloadend) setTimeout(this.onloadend, 0);
  }
}

if (typeof global.FileReader === 'undefined') {
  // @ts-expect-error Mock for testing
  global.FileReader = MockFileReader;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('pickRecorderMimeType', () => {
  it('mp4 受支持时优先 mp4', () => {
    // @ts-expect-error 测试桩
    global.MediaRecorder = { isTypeSupported: (t: string) => t === 'audio/mp4' };
    expect(pickRecorderMimeType()).toBe('audio/mp4');
  });
  it('都不支持时返回 undefined', () => {
    // @ts-expect-error 测试桩
    global.MediaRecorder = { isTypeSupported: () => false };
    expect(pickRecorderMimeType()).toBeUndefined();
  });
});

describe('transcribeBlob', () => {
  it('把 base64 与 mimeType 发给 /ai/asr 并返回 text', async () => {
    (apiPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ text: '你好' });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' });
    const text = await transcribeBlob(blob);
    expect(text).toBe('你好');
    expect(apiPost).toHaveBeenCalledWith('/ai/asr', expect.objectContaining({ mimeType: 'audio/mp4' }));
    const arg = (apiPost as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(typeof arg.audio).toBe('string');
    expect(arg.audio.length).toBeGreaterThan(0);
  });
});
