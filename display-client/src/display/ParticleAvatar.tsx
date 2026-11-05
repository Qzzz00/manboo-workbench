/**
 * 展示台形象位上的粒子球(2026-09-22,Ben:「把 Live2D 形象换成旋转的粒子吧」)。
 *
 * ★跑的是**同一份**核心:`src/swarm/core.js` 与手机端(butler-app/src/swarm/)、
 * Mac 事务官档(workbench-plugin/src/client/swarm/)逐字相同,由
 * `workbench-plugin/scripts/sync-swarm-core.mjs` 生成。`swarmSource.test.ts` 守着这件事。
 * 这个组件是**薄壳**,与手机端 `ParticleStage.tsx` 同一套写法(rAF 循环、configure/setMode、
 * ResizeObserver、visibilitychange 暂停),参数从外面传进来,这里一个都不调。
 *
 * 起不来就退回一个占位球(`.dp-avatar__orb`,纯 CSS),**不白屏**——展示台是一块没人看管的屏幕,
 * 一次 canvas 失败不该让形象位变成一块黑。退级会往 console 写一行原因
 * (照抄手机端 09-22 那次教训:原因被吞掉,真机上只剩「球看起来不一样」一个哑症状)。
 */
import { useEffect, useRef, useState } from 'react';
import type { Tuning } from '../swarm/core.js';
import { SwarmRenderer, SwarmV4 } from '../swarm/core.js';
import { STAGE_CORE_MODE, particleUnavailableReason, type StageParticleMode, type StageParticleNotice } from './displayStage';

export interface ParticleAvatarProps {
  mode: StageParticleMode;
  notice: StageParticleNotice;
  settings: Tuning;
  /**
   * 粒子的明暗:跟着底图走(展示台双击换底图,`data-display-scheme` 也是这么翻的)。
   * 暗底图配亮粒子、亮底图配暗粒子——照 display.css 里那条实测结论
   * (底图平均亮度 02=64 暗 / 01=209 亮)。写错这一项球会**看不见**,不是不好看。
   */
  theme: 'dark' | 'light';
  /** 退回占位球时报一句原因(默认只写 console)。 */
  onDegraded?: (reason: string) => void;
}

/** 退回占位球时写进 console 的那一行的前缀。真机上按它找。 */
export const PARTICLE_DEGRADED_PREFIX = '[展示台粒子球] 起不来,退回占位球:';

/** 单帧最大步长:切回前台/长时间卡顿时别让粒子一步跳飞。 */
const MAX_DT = 0.05;

export function ParticleAvatar(props: ParticleAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const current = useRef(props);
  current.current = props;
  const refresh = useRef<(() => void) | null>(null);
  const told = useRef(false);

  const degrade = (reason: string): void => {
    setFailed(true);
    if (told.current) return;
    told.current = true;
    try { console.warn(`${PARTICLE_DEGRADED_PREFIX}${reason}`); } catch { /* 连 console 都没有就算了 */ }
    try { current.current.onDegraded?.(reason); } catch { /* 一个监听者抛不该把球也带走 */ }
  };

  useEffect(() => {
    const element = canvasRef.current;
    // 能不能跑的判断在 displayStage.ts(纯函数,有测试);这里只负责照它做。
    const blocked = particleUnavailableReason({
      hasNode: element !== null,
      hasContextClass: typeof CanvasRenderingContext2D !== 'undefined',
      // 没有节点时不去碰 getContext;这一项只在前两项都过了之后才被看。
      context: element === null ? null : safeContext(element),
    });
    if (blocked !== null || element === null) { degrade(blocked ?? '没有 canvas 节点'); return; }
    let dead = false;
    let frame: number | undefined;
    let last: number | undefined;
    let renderer: SwarmRenderer | undefined;
    const cleanups: (() => void)[] = [];
    try {
      const swarm = new SwarmV4(current.current.settings.count);
      renderer = new SwarmRenderer(element, swarm);
      const painter = renderer;
      let lastMode = '';
      let lastColor = '';
      let lastSettings: Tuning | undefined;

      const tick = (at: number) => {
        frame = undefined;
        if (dead) return;
        if (document.hidden) return;
        const dt = last === undefined ? 0 : Math.max(0, Math.min(MAX_DT, (at - last) / 1000));
        last = at;
        try { swarm.step(dt, false); painter.paint(dt, false); }
        catch (error) { if (!dead) degrade(`画这一帧时抛了:${error instanceof Error ? error.message : String(error)}`); return; }
        frame = requestAnimationFrame(tick);
      };

      const update = () => {
        if (dead) return;
        const p = current.current;
        if (p.settings !== lastSettings) { swarm.configure(p.settings); lastSettings = p.settings; }
        if (`${p.theme}:${p.notice}` !== lastColor) { painter.setColor(p.theme, p.notice); lastColor = `${p.theme}:${p.notice}`; }
        if (p.mode !== lastMode) { swarm.setMode(STAGE_CORE_MODE[p.mode]); lastMode = p.mode; }
        element.dataset.mode = p.mode;
        element.dataset.notice = p.notice;
        const active = !document.hidden;
        element.dataset.running = String(active);
        if (!active) {
          if (frame !== undefined) cancelAnimationFrame(frame);
          frame = undefined; last = undefined;
          try { swarm.step(0, true); painter.paint(0, true); } catch { /* 停着画不出来不算错 */ }
        } else if (frame === undefined) {
          frame = requestAnimationFrame(tick);
        }
      };
      refresh.current = update;
      const resize = () => { if (dead) return; painter.resize(); update(); };
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        cleanups.push(() => observer.disconnect());
      }
      document.addEventListener('visibilitychange', update);
      cleanups.push(() => document.removeEventListener('visibilitychange', update));
      painter.resize();
      update();
    } catch (error) {
      degrade(error instanceof Error ? error.message : String(error));
    }
    return () => {
      dead = true;
      refresh.current = null;
      if (frame !== undefined) cancelAnimationFrame(frame);
      cleanups.forEach((c) => c());
      renderer?.cloud.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // 只挂一次(空依赖是故意的):参数变化走下面那个 effect 里的 update(),不重建粒子群 ——
    // 重建一次要重新撒 3600~8000 颗、重新建 WebGL 光团,拖一次滑杆就闪一下。
  }, []);

  useEffect(() => { refresh.current?.(); }, [props.mode, props.notice, props.settings, props.theme]);

  if (failed) {
    // 占位球:一个会呼吸的圆,CSS 画的,什么都不依赖。
    return <div className="dp-avatar__orb" data-mode={props.mode} role="img" aria-label={`事务官:${LABELS[props.mode]}`} />;
  }
  return (
    <div className="dp-avatar__wrap" data-mode={props.mode} data-notice={props.notice}>
      <canvas ref={canvasRef} className="dp-avatar__canvas" aria-hidden="true" />
      <span className="dp-avatar__a11y" role="img" aria-label={`事务官:${LABELS[props.mode]}`} />
    </div>
  );
}

/** getContext 本身也可能抛(某些 WebView 在 WebGL 上下文冲突时会)。抛了就当拿不到。 */
function safeContext(element: HTMLCanvasElement): unknown {
  try { return element.getContext('2d'); } catch { return null; }
}

const LABELS: Record<StageParticleMode, string> = { idle: '待命', working: '在办', acknowledging: '有事等你' };
