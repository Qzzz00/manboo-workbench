/**
 * 引导流程的入口(材料第 3 节;本体 2026-09-16 接上,见 OnboardingPage.tsx)。
 * 第一次配对成功 → settings.onboarding = 'pending' → 对话页顶部亮一条「第一次见面」;
 * 工作台说引导做完了(/state.onboarding.done)→ 卡消失,本机标记也置 done。
 */
import type { Settings } from '../settings/settingsStore';
import type { WorkbenchState } from '../api/protocol';

export function onboardingEntryVisible(settings: Settings, state?: Pick<WorkbenchState, 'onboarding'>): boolean {
  if (state?.onboarding?.done === true) return false;
  return settings.onboarding === 'pending';
}

/**
 * 入口那一行字:没开始过 / 做到一半 两种。2026-09-16 Ben 反馈聊天流里那张卡「很诡异」,改成对话页顶部一条细横幅,
 * 只有一句话(banner),点它进引导页;title / text / button 留给别处(设置页)用。
 */
export function onboardingEntryText(state?: Pick<WorkbenchState, 'onboarding'>): { title: string; text: string; button: string; banner: string } {
  if (state?.onboarding?.askedAt !== undefined && !state.onboarding.done) {
    return { title: '引导做到一半', text: '请回电脑上的工作台接着完成引导，已保存的进度会保留。', button: '接着引导', banner: '引导还没做完 · 回电脑继续' };
  }
  return { title: '第一次见面', text: '配对成功了。首次引导请在电脑上的工作台完成。', button: '开始引导', banner: '首次引导 · 在电脑上继续' };
}

/** 横幅「稍后」:本次启动不再显示(sessionStorage,App 被杀重开就回来);不改 settings.onboarding。 */
export const ONBOARDING_BANNER_DISMISSED_KEY = 'butler.onboardingBannerDismissed';

export function onboardingBannerDismissed(): boolean {
  try { return sessionStorage.getItem(ONBOARDING_BANNER_DISMISSED_KEY) === '1'; } catch { return false; }
}

export function dismissOnboardingBanner(): void {
  try { sessionStorage.setItem(ONBOARDING_BANNER_DISMISSED_KEY, '1'); } catch { /* 存不了就只在内存里 */ }
}

/** 配对成功那一刻调用:第一次配对才把入口点亮,重配不重跑。 */
export function afterPaired(settings: Settings): Partial<Settings> {
  return settings.onboarding === 'none' ? { onboarding: 'pending' } : {};
}
