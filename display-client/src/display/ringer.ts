/**
 * 铃声开关接线：盯着 liveStore 的响铃集合，空↔非空的沿上开/关铃。
 *
 * 展示台不判断（C2）：谁该响、响多久全是工作台推的消息说了算——
 * ring 起铃、call/offhook|missed 停铃、60 秒退场兜底都在 liveStore 里，
 * 这里只把「集合是否非空」翻译成「铃响不响」。铃只有一口：
 * 多个会话同时响铃也只 start 一次，全停光才 stop。
 *
 * **免打扰时段不出声**(2026-09-26,卡 QH)。维护者的规矩:晚上 9 点以后不想被打扰。
 * 时段判断照样不在这里 —— 工作台算好摆在 `/state.quiet`(`server/quietHours.ts`),
 * 这一层只多读一格:`quiet.active` 为真就**不起铃**,起着的也停掉(21:00 到点了不该继续吵)。
 *
 * 刻意分清的两件事:**响铃那一格照旧亮着**(`store.get().ringing` 一个字没改) ——
 * 屏上看得见谁在等他,只是屋里没声。免打扰是不出声,不是不告诉他。
 */
import type { LiveStore } from './liveStore';

/** 铃的开关面。原生桥（nativeRingtone.ts）与测试假铃都实现它。 */
export interface RingerLike {
  start: () => void;
  stop: () => void;
}

export function attachRinger(store: Pick<LiveStore, 'get' | 'subscribe'>, ringer: RingerLike): () => void {
  /**
   * 铃此刻该不该出声 = 有会话在响 **且** 不在免打扰时段里。
   * `quiet` 缺席(老工作台)按能出声算 —— 宁可多响一次,也不替他把铃关掉让他以为座机坏了。
   */
  const audibleNow = (): boolean => {
    const snapshot = store.get();
    return snapshot.ringing.size > 0 && snapshot.state.quiet?.active !== true;
  };

  let audible = audibleNow();
  if (audible) ringer.start();

  const unsubscribe = store.subscribe(() => {
    const next = audibleNow();
    if (next === audible) return;
    audible = next;
    if (next) ringer.start();
    else ringer.stop();
  });

  return () => {
    unsubscribe();
    // 铃在响时被拆线（如 React 卸载）必须先停：原生层没人再管它，不停就响到天荒地老。
    if (audible) {
      audible = false;
      ringer.stop();
    }
  };
}
