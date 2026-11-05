import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireVoice, currentVoiceOwner, isVoiceBusy, releaseVoice, stopCurrentVoice, __resetVoiceChannel,
} from './voiceChannel.ts';

beforeEach(() => __resetVoiceChannel());

describe('voiceChannel', () => {
  it('acquire 后记录占用者，release 后清空', () => {
    acquireVoice('tts', () => {});
    expect(currentVoiceOwner()).toBe('tts');
    expect(isVoiceBusy()).toBe(true);
    releaseVoice('tts');
    expect(currentVoiceOwner()).toBeNull();
    expect(isVoiceBusy()).toBe(false);
  });

  it('新占用者进来会停掉旧的', () => {
    const stopTts = vi.fn();
    acquireVoice('tts', stopTts);
    acquireVoice('singing', () => {});
    expect(stopTts).toHaveBeenCalledTimes(1);
    expect(currentVoiceOwner()).toBe('singing');
  });

  it('同一个 owner 再次 acquire 也停旧的（连播两句要先停上一句）', () => {
    const first = vi.fn();
    acquireVoice('tts', first);
    acquireVoice('tts', () => {});
    expect(first).toHaveBeenCalledTimes(1);
    expect(currentVoiceOwner()).toBe('tts');
  });

  it('★旧占用者的 stop 回调里调 release 不会误清新占用者', () => {
    acquireVoice('tts', () => releaseVoice('tts'));
    acquireVoice('singing', () => {});
    expect(currentVoiceOwner()).toBe('singing');
  });

  // 真实场景（tts.ts）：每次 acquireVoice('tts', stopSpeaking) 传的都是同一个函数引用，
  // 而 stopSpeaking 自己尾部会 releaseVoice('tts')——同名连续 acquire（比如自动播报还没
  // 播完就点了气泡重播）会让旧 stop 回调以「和新占用者相同的名字」调 release。上一条★
  // 测试只验证了不同名字的情况，覆盖不到这个同名自伤的场景。
  it('★同名连续 acquire：旧 stop 回调以同名 release 不会误清刚上任的新占用者', () => {
    const releaseSelf = () => releaseVoice('tts');
    acquireVoice('tts', releaseSelf);
    acquireVoice('tts', releaseSelf);
    expect(currentVoiceOwner()).toBe('tts');
    expect(isVoiceBusy()).toBe(true);
  });

  // 审查 #3：stop 回调里若又发起一次 acquire（嵌套抢占），旧实现会被外层这次 acquire
  // 无条件覆盖——覆盖时不喊停，嵌套占用者永远等不到自己的 stop。
  it('★重入洞：stop 回调里发起的嵌套 acquire 不会被静默覆盖，会被正确喊停', () => {
    const singingStopped = vi.fn();
    acquireVoice('tts', () => acquireVoice('singing', singingStopped));
    acquireVoice('rtc', () => {});
    expect(currentVoiceOwner()).toBe('rtc');
    expect(singingStopped).toHaveBeenCalledTimes(1);
  });

  // 嵌套可以不止一层：每一层被顶替的 entry 都要被喊停，不能只处理第一层
  // （这条测试专门锁住「排空要用循环，不能只判一次」这个设计决定）。
  it('★重入洞可以嵌套多层：每一层被顶替的 stop 都要被喊停', () => {
    const rtcStopped = vi.fn();
    const singingStopped = vi.fn(() => {
      acquireVoice('rtc', rtcStopped);
    });
    const ttsStopped = vi.fn(() => {
      acquireVoice('singing', singingStopped);
    });

    acquireVoice('tts', ttsStopped);
    acquireVoice('tts', () => {});

    expect(currentVoiceOwner()).toBe('tts');
    expect(ttsStopped).toHaveBeenCalledTimes(1);
    expect(singingStopped).toHaveBeenCalledTimes(1);
    expect(rtcStopped).toHaveBeenCalledTimes(1);
  });

  // 审查 #2：owner 名字不是身份，同一个名字会被反复 acquire。旧会话「迟到」的终止回调
  // （比如异步事件晚落地）如果只按名字 release，会误清刚上任、同名的新会话。
  // token 是 acquireVoice 发的身份凭证：release 时带上，必须匹配「当前那个 entry」才生效。
  it('★身份辨识：旧 token 的 release 打不中同名新 entry，只有当前 token 能清', () => {
    const tokenA = acquireVoice('tts', () => {});
    const tokenB = acquireVoice('tts', () => {}); // 同名连续 acquire，B 顶替 A
    expect(currentVoiceOwner()).toBe('tts');

    releaseVoice('tts', tokenA); // A 的 token 已经作废
    expect(currentVoiceOwner()).toBe('tts'); // 打不中，B 还在

    releaseVoice('tts', tokenB); // B 自己的 token
    expect(currentVoiceOwner()).toBeNull(); // 这才真的清空
  });

  it('acquireVoice 返回的 token 每次不同，可用于身份校验', () => {
    const t1 = acquireVoice('tts', () => {});
    const t2 = acquireVoice('tts', () => {});
    expect(t1).not.toBe(t2);
  });

  it('release 只清自己：被顶替后再 release 不影响新占用者', () => {
    acquireVoice('tts', () => {});
    acquireVoice('singing', () => {});
    releaseVoice('tts');
    expect(currentVoiceOwner()).toBe('singing');
  });

  it('stop 抛错不影响新占用者就位', () => {
    acquireVoice('tts', () => { throw new Error('boom'); });
    expect(() => acquireVoice('singing', () => {})).not.toThrow();
    expect(currentVoiceOwner()).toBe('singing');
  });

  it('stopCurrentVoice 停掉并清空', () => {
    const stop = vi.fn();
    acquireVoice('singing', stop);
    stopCurrentVoice();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(currentVoiceOwner()).toBeNull();
  });

  // 铁律 3 的排空循环由外部回调推进：一个「stop 里又 acquire」的占用方就能让它永不收敛。
  // 今天没有这样的占用方（tts/singing 的 stop 都只 release），但模块注释在**鼓励**嵌套
  // acquire，而这个失败模式是同步死循环冻住 UI 线程——比它取代的泄漏严重得多。
  // 本用例在没有上限时会直接挂死（vitest 超时才收），所以它同时是「上限存在」的证明。
  it('★排空循环有上限：stop 回调无限自我复制时告警退出，不冻住主线程', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 每次被喊停就再抢一次麦——外层 acquire 的排空循环因此永远发现有人插队。
    const selfReplicating = () => { acquireVoice('tts', selfReplicating); };
    acquireVoice('tts', selfReplicating);

    expect(() => acquireVoice('singing', () => {})).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('voiceChannel');
    // 封顶退出后，本次 acquire 仍然正常装上新占用者——丢一次交接好过界面卡死。
    expect(currentVoiceOwner()).toBe('singing');
    warn.mockRestore();
  });

  it('正常的一层嵌套 acquire 仍被排空，且不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nestedStop = vi.fn();
    acquireVoice('tts', () => { acquireVoice('rtc', nestedStop); });

    acquireVoice('singing', () => {});

    expect(nestedStop).toHaveBeenCalledTimes(1); // 插队者被喊停，没被静默吃掉
    expect(warn).not.toHaveBeenCalled();
    expect(currentVoiceOwner()).toBe('singing');
    warn.mockRestore();
  });
});
