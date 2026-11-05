import { routeTouch, type TouchAction, type TouchContext, type TouchEvent } from './touchRouter.ts';

export interface CoordinatorSinks {
  perform(e: TouchEvent): void;
  showBanner(e: TouchEvent): void;
  startInplaceCall(e: TouchEvent): void;
  startFullscreenCall(e: TouchEvent): void;
  reportMissed(e: TouchEvent): void; // 调 call-result(timeout)
  markUnread(e: TouchEvent): void; // silent/banner 都调，红点用
}

export function createTouchCoordinator(
  sinks: CoordinatorSinks,
  getCtx: () => TouchContext,
) {
  let ringing = false;

  // ALL-439：返回路由动作，让补拉链路知道这条消息到底是演出了、只上了横幅、还是被静默
  // （通话中）——只有「用户可感知」的处置才允许 markSeen，被静默的保留补演机会。
  function push(e: TouchEvent): TouchAction {
    const ctx = getCtx();
    const action = routeTouch(e, { ...ctx, inCall: ctx.inCall || ringing });

    switch (action.type) {
      case 'perform':
        sinks.perform(e);
        break;
      case 'banner':
        sinks.showBanner(e);
        sinks.markUnread(e);
        break;
      case 'call-inplace':
        ringing = true;
        sinks.startInplaceCall(e);
        break;
      case 'call-fullscreen':
        ringing = true;
        sinks.startFullscreenCall(e);
        break;
      case 'report-missed':
        sinks.reportMissed(e);
        break;
      case 'silent':
        sinks.markUnread(e);
        break;
    }
    return action;
  }

  function callResolved(): void {
    ringing = false;
  }

  function dispose(): void {
    ringing = false;
  }

  return { push, callResolved, dispose };
}
