import { describe, expect, it } from 'vitest';
import { formatFollowUpMessage } from './formatFollowUp.ts';

describe('formatFollowUpMessage', () => {
  it('返回空字符串当模板为空', () => {
    expect(formatFollowUpMessage('')).toBe('');
    expect(formatFollowUpMessage('   ')).toBe('');
  });

  it('保留无占位符的原文', () => {
    expect(formatFollowUpMessage('谢谢你完成这个任务。')).toBe('谢谢你完成这个任务。');
  });

  it('替换存在的 slot 占位符', () => {
    const template = '谢谢你，{slot_user_name}，我已经收到你的{slot_item}了。';
    const slots = { user_name: '小明', item: '照片' };
    expect(formatFollowUpMessage(template, slots)).toBe('谢谢你，小明，我已经收到你的照片了。');
  });

  it('无法替换的占位符保持原样', () => {
    const template = '这是{slot_unknown}的测试。';
    expect(formatFollowUpMessage(template, {})).toBe('这是{slot_unknown}的测试。');
  });

  it('忽略非字符串 slot 值', () => {
    const template = '值：{slot_a}';
    const slots = { a: 123 as unknown as string };
    expect(formatFollowUpMessage(template, slots)).toBe('值：{slot_a}');
  });
});
