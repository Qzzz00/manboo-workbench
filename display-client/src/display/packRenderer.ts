/**
 * 形象包的 Live2D 渲染器(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 2.4)。不碰 React。
 *
 *   · 取景:avatarFraming.ts 的 `frameAvatar`(维护者四轮调出来的规则);
 *   · 待机:目录里的 `idle.loop` 交给 pixi-live2d-display 的「空闲动作组」自动循环,`idle.beats` 每 12–30 秒随机插一段
 *     (avatarIdle.ts);碧蓝那批的台词段播时把嘴压住;
 *   · 换模型:新模型**加载完、摆好位置**才替换旧的(加载期间旧画面留着,组件那边压暗 + 转圈),旧的随即销毁 ——
 *     同一时刻只占一个模型的内存;加载被新的请求顶掉时,载好的那个直接销毁不上屏。
 */
import * as PIXI from 'pixi.js';
import { Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4';
import { backdropFor, frameAvatar } from './avatarFraming';
import { beatDelayMs, nextBeat } from './avatarIdle';
import { createTextureLedger, isSameAvatar } from './renderGuard';
import type { HostAvatarItem } from './hostFeed';

export interface View { w: number; h: number }

export interface PackRenderer {
  /** 加载并换上这个形象。被更晚的 load 顶掉时 resolve(false),出错 reject。 */
  load(item: HostAvatarItem): Promise<boolean>;
  /** 卸掉模型(换成粒子球时)。 */
  clear(): void;
  resize(view: View): void;
  destroy(): void;
  /** 自检(renderGuard.isStalled 用):最后一次成功画出一帧的时刻、上下文丢了没有。 */
  health(): { lastFrameAt: number; lost: boolean };
}

import { LOOP, BEAT, joinUrl, withPackMotions } from './packModel';

// 一个窗口一本账:PIXI 的贴图缓存是全窗口共用的,看门狗重建画布后,旧渲染器上还在载的那份也得记在同一本账上。
const ledger = createTextureLedger<PIXI.BaseTexture>();

export function createPackRenderer(canvas: HTMLCanvasElement, initial: View, crop: 'full' | 'bust' = 'full'): PackRenderer {
  (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
  const app = new PIXI.Application({
    view: canvas, backgroundAlpha: 0, antialias: true, autoStart: true,
    width: initial.w, height: initial.h, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true,
  });
  let view = initial;
  let current: { model: Live2DModel; item: HostAvatarItem; timer: number | undefined } | null = null;
  let generation = 0;
  app.ticker.add(() => {
    if (current === null) return;
    try { current.model.update(app.ticker.deltaMS); } catch { /* 一帧坏了不让整条循环死掉 */ }
  });
  // 渲染也包一层:PIXI 的 ticker 在回调里抛错就不再排下一帧,整条循环停死(10-01 真机「转屏才恢复」)。
  let lastFrameAt = performance.now();
  let lost = false;
  app.ticker.remove(app.render, app);
  app.ticker.add(() => {
    try { app.render(); lastFrameAt = performance.now(); } catch (e) { console.warn('[packRenderer] render failed', e); }
  }, undefined, PIXI.UPDATE_PRIORITY.LOW);
  const onLost = () => { lost = true; };
  canvas.addEventListener('webglcontextlost', onLost);

  const place = (model: Live2DModel, item: HostAvatarItem) => {
    model.scale.set(1);
    model.position.set(0, 0);
    const b = model.getLocalBounds();
    const f = frameAvatar({
      view: { w: view.w, h: view.h },
      model: { w: b.width, h: b.height },
      subject: item.subject,
      backdrop: backdropFor(item.backdrop, view),
      crop,
      ...(item.zoom === undefined ? {} : { zoom: item.zoom }),
      ...(item.nudge === undefined ? {} : { nudge: item.nudge }),
      ...(item.legCrop === undefined ? {} : { legCrop: item.legCrop }),
    });
    model.scale.set(f.scale);
    model.position.set(f.x - b.x * f.scale, f.y - b.y * f.scale);
  };

  const scheduleBeat = (holder: NonNullable<typeof current>, last: string | null) => {
    holder.timer = window.setTimeout(() => {
      if (current !== holder) return;
      const beat = nextBeat(holder.item.idle.beats, last, Math.random);
      if (beat !== null) void holder.model.motion(BEAT, holder.item.idle.beats.indexOf(beat), MotionPriority.NORMAL);
      scheduleBeat(holder, beat);
    }, beatDelayMs(Math.random));
  };

  // 贴图记账(renderGuard.createTextureLedger):同一地址的贴图被 PIXI 缓存成同一份,同一个模型同时载两份时两份共用,
  // 谁放手都只减一次账,没人用了才销毁(10-01 真机黑影的根因:作废的那份把正在上屏那份的贴图销毁了)。
  // 销毁走 texture.destroy(true),顺带从 PIXI 的贴图缓存里摘掉,下次再载同一个模型会重新取图。
  const disposeModel = (model: Live2DModel) => {
    const free = new Set(ledger.release(model.textures.map((t) => t.baseTexture)));
    const textures = model.textures.filter((t) => free.has(t.baseTexture));
    model.destroy({ children: true });
    for (const t of textures) t.destroy(true);
  };

  const drop = () => {
    if (current === null) return;
    window.clearTimeout(current.timer);
    app.stage.removeChild(current.model);
    disposeModel(current.model);
    current = null;
  };

  // 排错用(同 djClient 的 window.__djTrace):真机上 devtools 里读 window.__packRenderer 看模型摆在哪、多大。
  (window as unknown as { __packRenderer?: unknown }).__packRenderer = {
    app,
    get current() { return current === null ? null : { id: current.item.id, x: current.model.x, y: current.model.y, scale: current.model.scale.x, w: current.model.width, h: current.model.height, view }; },
  };

  return {
    async load(item) {
      const mine = ++generation;
      // 来回快滑回到正在显示的那个:不再载一份(顶掉在载的那个就够了)。
      if (current !== null && isSameAvatar(current.item, item)) return true;
      const url = joinUrl(item.base, item.entry);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`模型设置取不到(${res.status})`);
      const settings = withPackMotions(await res.json() as Record<string, unknown>, item, url);
      // 自动更新关掉、在 app.ticker 里手动 update(同 live2dEngine.ts:自动更新要先注册全局 Ticker,
      // 不注册模型永远不更新,画出来是一团黑影 —— 10-01 浏览器里就是这样)。
      const model = await Live2DModel.from(settings, { autoInteract: false, autoUpdate: false, idleMotionGroup: LOOP, crossOrigin: '' });
      ledger.retain(model.textures.map((t) => t.baseTexture));
      if (mine !== generation) {
        disposeModel(model);
        return false;
      }
      if (item.idle.muteMouth) {
        model.internalModel.on('beforeModelUpdate', () => {
          try { (model.internalModel.coreModel as { setParameterValueById(id: string, v: number): void }).setParameterValueById('ParamMouthOpenY', 0); } catch { /* 没这个参数就算了 */ }
        });
      }
      model.update(16);
      place(model, item);
      drop();
      app.stage.addChild(model);
      const holder = { model, item, timer: undefined as number | undefined };
      current = holder;
      scheduleBeat(holder, null);
      return true;
    },
    clear() { generation++; drop(); },
    resize(next) {
      view = next;
      app.renderer.resize(next.w, next.h);
      if (current !== null) place(current.model, current.item);
    },
    destroy() {
      generation++;
      drop();
      canvas.removeEventListener('webglcontextlost', onLost);
      try { app.destroy(false, { children: true, texture: true, baseTexture: true }); } catch { /* 上下文丢了时销毁也可能抛 */ }
    },
    health() { return { lastFrameAt, lost }; },
  };
}
