/** 手机端自己的几个开关。与令牌分开存(解除配对不清这些)。 */
import type { KeyValueStore } from '../api/tokenStore';

export interface Settings {
  voiceEnabled: boolean;
  /** 当前形象;null = 用列表里第一个已发布的。 */
  avatarId: string | null;
  /** 引导流程:none=没到过 / pending=配对成功还没跑(入口亮着)/ done=跑过或跳过。 */
  onboarding: 'none' | 'pending' | 'done';
  /**
   * 主界面上半那一层(2026-09-16,Ben:「和主机保持一致,都是粒子状态」):
   * particles = 与 Mac 同一份粒子核心 + 同一份外观配置(默认);live2d = 本机后端有已发布形象时可切。
   */
  stage: 'particles' | 'live2d';
  /**
   * 通话走哪条链路(2026-09-17,决策记录「手机通道层改 LiveKit」):
   * livekit = 进 LiveKit 房间,接话的是我们自己的模型(**缺省**);
   * volc    = 原来那条火山 RTC 智能体链路。代码留着当退路,只在设置页里能切回去。
   */
  callProvider: 'livekit' | 'volc';
  /**
   * 后台 / 锁屏也能来电(2026-10-03,维护者拍板默认开)。开着时原生起一个前台服务、
   * 状态栏常驻一条通知,系统就不冻结、不断网;关掉就回到「只有 App 在前台才收得到电话」。
   */
  ringStandby: boolean;
  /*
   * 2026-09-25(卡 feat/first-look-orb-top,维护者:「手机的不要这个什么所谓的座机页面,就显示首页就好了...多此一举」):
   * 「座机模式(自动 / 始终 / 从不)/ 放上无线充就进座机页 / 拿下来 5 分钟后回到舞台」三格**一并去掉**。
   * 充电(插电脑 USB 或充电器)照样是首页。老手机上存着的这三格读进来时直接丢掉(sanitize 不认它们),不迁移、不报错。
   * 座机主动打来的电话(call/useIncoming.ts)与实体话筒(添加座机 / 换网络)不受影响 —— 那是通话,不是这块屏。
   */
}

export const DEFAULT_SETTINGS: Settings = {
  voiceEnabled: true, avatarId: null, onboarding: 'none', stage: 'particles', callProvider: 'livekit', ringStandby: true,
};
export const SETTINGS_KEY = 'butler.settings';

export interface SettingsStore {
  load(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
}

function sanitize(raw: unknown): Settings {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    voiceEnabled: typeof v.voiceEnabled === 'boolean' ? v.voiceEnabled : DEFAULT_SETTINGS.voiceEnabled,
    avatarId: typeof v.avatarId === 'string' && v.avatarId !== '' ? v.avatarId : null,
    onboarding: v.onboarding === 'pending' || v.onboarding === 'done' ? v.onboarding : 'none',
    stage: v.stage === 'live2d' ? 'live2d' : 'particles',
    // 认不出来的值一律回缺省:存着一个手写坏了的值会让通话键点下去什么都不发生。
    callProvider: v.callProvider === 'volc' ? 'volc' : 'livekit',
    ringStandby: typeof v.ringStandby === 'boolean' ? v.ringStandby : DEFAULT_SETTINGS.ringStandby,
    // 座机页那三格(deskPhone / deskPhoneOnCharge / deskPhoneLeaveOnUnplug)2026-09-25 去掉了:老存档里有也不读。
  };
}

export function createSettingsStore(kv: KeyValueStore): SettingsStore {
  async function load(): Promise<Settings> {
    try {
      const raw = await kv.get(SETTINGS_KEY);
      return raw === null ? { ...DEFAULT_SETTINGS } : sanitize(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  return {
    load,
    async update(patch) {
      // 先按新口径读一遍再写回:老存档里那三格座机设置在第一次写的时候顺手被丢掉,不会一直跟着存。
      const next = { ...(await load()), ...patch };
      try { await kv.set(SETTINGS_KEY, JSON.stringify(next)); } catch { /* 存不了就只在内存里 */ }
      return next;
    },
  };
}
