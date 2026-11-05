/**
 * 手机主界面的粒子事务官(2026-09-16):与电脑端 ParticleOrb 等价的薄壳,跑的是**同一份**核心
 * (src/swarm/core.js 由 workbench-plugin/scripts/sync-swarm-core.mjs 生成,与电脑端逐字相同)。
 * 五态:待命 / 聆听 / 在办 / 说话 / 需要你;外加说话准备 preparing(事务官在想)。data-mode 照原样给样式与测试认。
 * 交给核心的态见 orbState.ts `CORE_MODE`:在办交核心原版的 working 形(莫比乌斯环,2026-09-24 傍晚恢复);
 * 在想不用核心的 speaking 形,而是待命 + 更快的自转与漂移;中心光团在手机上一律关(`phoneOrbSettings`)。
 * 参数(数量、大小、亮度…)由外面传进来——来自 Mac 的那一份(appearance.ts),这里不调参。
 *
 * 帧率:每秒把实际帧数写到 canvas 的 data-fps(真机用 DevTools / adb 读),给「跑不跑得动」留证据。
 * 画不了 canvas(jsdom / 老 WebView)就退回原来的声纹球,不白屏 ——
 * **2026-09-22 起退级会说出原因**(`onDegraded` + 一行 console.warn),
 * 不再是「球看起来不一样」这一个哑症状。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Orb } from '../live2d/Orb';
import type { Tuning } from './core.js';
import { SwarmRenderer, SwarmV4 } from './core.js';
import { CORE_MODE, phoneOrbSettings, type ParticleSceneKind, type StageMode, type StageNotice } from './orbState';
import { afterHandoffLaunch, handoffLaunching } from '../brand/blackhole.js';

export interface ParticleStageProps {
  mode: StageMode;
  notice?: StageNotice;
  settings: Tuning;
  paused?: boolean;
  /** 每秒一次的实际帧率。 */
  onFps?: (fps: number) => void;
  /**
   * **退回声纹球了,原因是这一句**(2026-09-22)。同一次挂载只报一次。
   *
   * 以前这里 `catch { setFailed(true) }` 把原因整个吞掉,于是真机上只剩
   * 「球看起来不一样」这一个症状 —— Ben 09-22 那句「中间的来电显示不是粒子球」
   * 花了不少工夫才排除掉「是不是降级了」。不管接没接这个回调,都会往 console 写一行。
   */
  onDegraded?: (reason: string) => void;
  note?: string;
  /**
   * 在哪儿露面(2026-09-23)。**已不影响画法**:中心光团在手机上一律关(orbState.ts sceneSettings),
   * 留着这一格是让老调用方照传不报错。
   */
  scene?: ParticleSceneKind;
}

/** 退回声纹球时写进 console 的那一行的前缀。真机上 adb logcat / DevTools 按它找。 */
export const PARTICLE_DEGRADED_PREFIX = '[粒子球] 起不来,退回声纹球:';

const MAX_DT = 0.05;

export function ParticleStage(props: ParticleStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  // 光团关、在想提节奏(orbState.ts phoneOrbSettings)。useMemo 保住引用,免得每次渲染都 configure 一遍。
  const settings = useMemo(() => phoneOrbSettings(props.settings, props.mode), [props.settings, props.mode]);
  const current = useRef({ ...props, settings });
  current.current = { ...props, settings };
  const refresh = useRef<(() => void) | null>(null);
  /** 只报一次:每一帧都报的话真机日志会被刷满,而原因只有第一条有用。 */
  const told = useRef(false);
  const degrade = (reason: string): void => {
    setFailed(true);
    if (told.current) return;
    told.current = true;
    // eslint-disable-next-line no-console
    try { console.warn(`${PARTICLE_DEGRADED_PREFIX}${reason}`); } catch { /* 连 console 都没有就算了 */ }
    try { current.current.onDegraded?.(reason); } catch { /* 一个监听者抛不该把球也带走 */ }
  };

  /**
   * 登录 → 粒子球的串联起步那 0.6 秒里不初始化渲染器(2026-09-24 去卡顿):WebView 上造 SwarmRenderer + 光团
   * 要几十上百毫秒,原来正好压在串联头几帧上。画布照常挂着(串联靠它的位置找终点),晚一点开画;
   * 球在成形段才淡入,这之前早画上了。不在串联里:当场就画,与以前一样。
   */
  const [armed, setArmed] = useState(() => !handoffLaunching());
  useEffect(() => (armed ? undefined : afterHandoffLaunch(() => setArmed(true))), [armed]);
  useEffect(() => {
    if (!armed) return;
    const element = canvasRef.current;
    if (element === null || typeof CanvasRenderingContext2D === 'undefined') {
      degrade(element === null ? '没有 canvas 节点' : '这个环境里没有 CanvasRenderingContext2D(jsdom / 很老的 WebView)');
      return;
    }
    let dead = false;
    let frame: number | undefined;
    let last: number | undefined;
    let renderer: SwarmRenderer | undefined;
    let frames = 0;
    /** 帧率按墙上时间算(rAF 的 at),不用被截断的 dt——慢的时候 dt 封顶 50ms 会把帧率虚报高。 */
    let fpsStart: number | undefined;
    const cleanups: (() => void)[] = [];
    try {
      if (!element.getContext('2d')) throw new Error('Canvas unavailable');
      const swarm = new SwarmV4(current.current.settings.count);
      renderer = new SwarmRenderer(element, swarm);
      const painter = renderer;
      let lastMode = '';
      let lastColor = '';
      let lastSettings: Tuning | undefined;
      let version = 0;

      const tick = (at: number) => {
        frame = undefined;
        if (dead) return;
        const p = current.current;
        const active = !document.hidden && !p.paused;
        if (!active) return;
        const dt = last === undefined ? 0 : Math.max(0, Math.min(MAX_DT, (at - last) / 1000));
        last = at;
        try { swarm.step(dt, false); painter.paint(dt, false); }
        catch (error) { if (!dead) degrade(`画这一帧时抛了:${error instanceof Error ? error.message : String(error)}`); return; }
        frames += 1;
        if (fpsStart === undefined) fpsStart = at;
        else if (at - fpsStart >= 1000) {
          const fps = Math.round((frames * 1000) / (at - fpsStart));
          element.dataset.fps = String(fps);
          p.onFps?.(fps);
          frames = 0; fpsStart = at;
        }
        frame = requestAnimationFrame(tick);
      };

      const update = () => {
        if (dead) return;
        const p = current.current;
        const notice = p.notice ?? 'neutral';
        if (p.settings !== lastSettings) { swarm.configure(p.settings); lastSettings = p.settings; }
        // 手机端是深色底(styles.css 的 --ba-bg),粒子用亮色。
        if (`dark:${notice}` !== lastColor) { painter.setColor('dark', notice); lastColor = `dark:${notice}`; }
        if (p.mode !== lastMode) {
          const mine = ++version;
          swarm.setMode(CORE_MODE[p.mode]);
          lastMode = p.mode;
          void mine;
        }
        const active = !document.hidden && !p.paused;
        element.dataset.running = String(active);
        element.dataset.mode = p.mode;
        if (!active) {
          if (frame !== undefined) cancelAnimationFrame(frame);
          frame = undefined; last = undefined; fpsStart = undefined; frames = 0;
          try { swarm.step(0, true); painter.paint(0, true); } catch { /* 停着的时候画不出来也不算错 */ }
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
  }, [armed]);

  useEffect(() => { refresh.current?.(); }, [props.mode, props.notice, settings, props.paused]);

  if (failed) {
    const orbMode = props.mode === 'listening' || props.mode === 'speaking' ? 'listening' : props.mode === 'working' ? 'working' : props.mode === 'preparing' ? 'preparing' : props.mode === 'acknowledging' ? 'attention' : 'idle';
    return <Orb mode={orbMode} note={props.note} />;
  }
  return (
    <div className="ba-particles" data-mode={props.mode} data-notice={props.notice ?? 'neutral'}>
      <canvas ref={canvasRef} className="ba-particles__canvas" aria-hidden="true" />
      <span className="ba-particles__a11y" role="img" aria-label={`事务官:${LABELS[props.mode]}`} />
      {props.note !== undefined && <p className="ba-orb__note">{props.note}</p>}
    </div>
  );
}

const LABELS: Record<StageMode, string> = { idle: '待命', listening: '聆听', working: '在办', speaking: '说话', acknowledging: '需要你', preparing: '准备说话' };
