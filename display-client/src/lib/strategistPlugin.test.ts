import { describe, expect, it } from 'vitest';

import { classifyCaptureError } from './strategistPlugin.ts';

describe('classifyCaptureError', () => {
  it('把无障碍未启用翻成可操作的中文', () => {
    expect(classifyCaptureError('SERVICE_DISABLED')).toContain('无障碍');
  });
  it('限流有专属文案，不诱导用户重试到死', () => {
    expect(classifyCaptureError('INTERVAL_TOO_SHORT')).toContain('太快');
  });
  it('未知 code 也给出兜底文案而不是空串', () => {
    expect(classifyCaptureError('WHATEVER')).not.toBe('');
  });
});
