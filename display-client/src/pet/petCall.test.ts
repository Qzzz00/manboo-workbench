import { describe, it, expect, vi } from 'vitest';
import { createPetCallStage } from './petCall';

function fakeCtl() {
  return { setMouth: vi.fn(), setEmotion: vi.fn(), setCostume: vi.fn(), setFocus: vi.fn() };
}

describe('petCall stage', () => {
  it('onBotAudioLevel 驱动 setMouth（夹取 0-1）', () => {
    const ctl = fakeCtl();
    const stage = createPetCallStage(ctl);
    stage.onBotAudioLevel(0.5);
    stage.onBotAudioLevel(1.7);
    expect(ctl.setMouth).toHaveBeenNthCalledWith(1, 0.5);
    expect(ctl.setMouth).toHaveBeenNthCalledWith(2, 1); // 夹取
  });

  it('onBotUtterance 更新字幕 + 情绪映射', () => {
    const ctl = fakeCtl();
    const stage = createPetCallStage(ctl);
    const seen: string[] = [];
    stage.subscribe((s) => seen.push(s));
    // classifyCallEmotion 命中「哈哈」+「开心」→ happy（见 src/lib/callEmotion.ts LEXICON）
    stage.onBotUtterance('哈哈哈太开心了');
    expect(stage.subtitle).toBe('哈哈哈太开心了');
    expect(seen).toContain('哈哈哈太开心了');
    expect(ctl.setEmotion).toHaveBeenCalledWith('happy');
  });

  it('stop 归零口型与表情', () => {
    const ctl = fakeCtl();
    const stage = createPetCallStage(ctl);
    stage.stop();
    expect(ctl.setMouth).toHaveBeenLastCalledWith(0);
    expect(ctl.setEmotion).toHaveBeenLastCalledWith(null);
  });
});
