import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCollabDraft, saveCollabDraft } from '../src/collab/collabDrafts';
afterEach(() => window.localStorage.clear());
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() } });
});
describe('协作草稿按设备与事项保存', () => {
  it('重读保留文字、意图和准确收件名片,别的事项或设备不串用', () => {
    saveCollabDraft('device:a', 'task:a', { text: '@同名 检查资料', intent: 'ask', pickedIds: ['agent:second'] });
    expect(readCollabDraft('device:a', 'task:a')).toEqual({ text: '@同名 检查资料', intent: 'ask', pickedIds: ['agent:second'] });
    expect(readCollabDraft('device:a', 'task:b').text).toBe('');
    expect(readCollabDraft('device:b', 'task:a').text).toBe('');
    saveCollabDraft('device:a', 'task:a', { text: '', intent: 'ask', pickedIds: [] });
    expect(readCollabDraft('device:a', 'task:a').text).toBe('');
  });
});
