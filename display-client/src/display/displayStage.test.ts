/**
 * 形象位放什么(2026-09-22)。这一份钉的是 Ben 那句话的两半:
 * 「把 Live2D 形象换成旋转的粒子」=默认粒子球;「后面我再给你对应的 Live2D 模型,再换上去」
 * =Live2D 那条路还在,`?avatar=` 就是那个开关。
 */
import { describe, expect, it } from 'vitest';
import {
  PARTICLE_AVATAR_VALUES,
  STAGE_FALLBACK_SPIN,
  STAGE_CORE_MODE,
  displayOrbSettings,
  isWideScreen,
  stageBackdrop,
  orbSignalsOf,
  particleModeOf,
  particleUnavailableReason,
  resolveDisplayLayout,
  resolveStageKind,
  withStageSpin,
} from './displayStage';

describe('形象位:默认粒子球,?avatar= 才走 Live2D', () => {
  it('★没有 ?avatar= 就是粒子球(这是 09-22 改掉的那个默认值)', () => {
    expect(resolveStageKind('')).toEqual({ kind: 'particles' });
    expect(resolveStageKind('?workbench=ws://127.0.0.1:8791/live&token=T')).toEqual({ kind: 'particles' });
  });
  it('?avatar= 是空串或只有空格也是粒子球', () => {
    expect(resolveStageKind('?avatar=')).toEqual({ kind: 'particles' });
    expect(resolveStageKind('?avatar=%20%20')).toEqual({ kind: 'particles' });
  });
  it('明写 particles / particle / 粒子(不分大小写)= 粒子球', () => {
    for (const value of [...PARTICLE_AVATAR_VALUES, 'Particles', 'PARTICLE']) {
      expect(resolveStageKind(`?avatar=${encodeURIComponent(value)}`)).toEqual({ kind: 'particles' });
    }
  });
  it('★给了形象 id 就还是 Live2D —— 那条路一行没删', () => {
    expect(resolveStageKind('?avatar=hijiki')).toEqual({ kind: 'live2d', avatarId: 'hijiki' });
    expect(resolveStageKind('?workbench=ws://a:1/live&avatar=shuangsheng&token=T'))
      .toEqual({ kind: 'live2d', avatarId: 'shuangsheng' });
  });
  it('前后空格不算 id 的一部分', () => {
    expect(resolveStageKind('?avatar=%20hijiki%20')).toEqual({ kind: 'live2d', avatarId: 'hijiki' });
  });
  it('查询串带不带问号都认', () => {
    expect(resolveStageKind('avatar=hijiki')).toEqual({ kind: 'live2d', avatarId: 'hijiki' });
  });
  it('★指名的形象这台机器上没有 → 粒子球(10-21 仓库不带模型;桌面展示台入口写死的 shuangsheng-p20 落到这里)', () => {
    const none = () => false;
    expect(resolveStageKind('?avatar=shuangsheng-p20&scale=1.9', none)).toEqual({ kind: 'particles' });
    expect(resolveStageKind('?avatar=m1', (id) => id === 'm1')).toEqual({ kind: 'live2d', avatarId: 'm1' });
    expect(resolveStageKind('?avatar=m2', (id) => id === 'm1')).toEqual({ kind: 'particles' });
  });
});

describe('粒子球的态:与手机竖屏首页同一个口径(2026-09-30 横屏补齐)', () => {
  const base = { stale: false, sessions: [] as { status: string }[] };
  it('什么都没有 = 待命(idle 才吃自转,所以默认就是「转着的球」)', () => {
    expect(particleModeOf(orbSignalsOf(base))).toEqual({ mode: 'idle', notice: 'neutral' });
    expect(particleModeOf(orbSignalsOf({ ...base, sessions: [{ status: 'done' }] }))).toEqual({ mode: 'idle', notice: 'neutral' });
  });
  it('有会话在跑 = 在办', () => {
    expect(particleModeOf(orbSignalsOf({ ...base, sessions: [{ status: 'running' }] }))).toEqual({ mode: 'working', notice: 'neutral' });
  });
  it('★快照不新鲜(电脑没连上)时不凭旧数据说在办', () => {
    expect(orbSignalsOf({ ...base, stale: true, sessions: [{ status: 'running' }] }).working).toBe(false);
  });
  it('★会话停在 waiting 本身不算「等你」—— 等你只认事务官问你 / 要你批 / 等你拍板(同手机)', () => {
    expect(orbSignalsOf({ ...base, sessions: [{ status: 'waiting' }] }).attention).toBe(false);
    expect(orbSignalsOf({ ...base, questions: [{}] }).attention).toBe(true);
    expect(orbSignalsOf({ ...base, approvals: [{}] }).attention).toBe(true);
    expect(orbSignalsOf({ ...base, butler_inbox: { items: [{ kind: 'confirm' }] } }).attention).toBe(true);
    expect(orbSignalsOf({ ...base, butler_inbox: { items: [{ kind: 'risk' }] } }).attention).toBe(true);
    expect(orbSignalsOf({ ...base, butler_inbox: { items: [{ kind: 'routine' }, { kind: 'session' }] } }).attention).toBe(false);
    expect(orbSignalsOf({ ...base, materialize: { status: 'proposed' } }).attention).toBe(true);
    expect(orbSignalsOf({ ...base, materialize: { status: 'applied' } }).attention).toBe(false);
  });
  it('★等你 = 琥珀色;没在跑时是球', () => {
    expect(particleModeOf({ working: false, attention: true, failed: false })).toEqual({ mode: 'acknowledging', notice: 'confirmation' });
  });
  /**
   * 2026-10-01 维护者看着横屏:「有运行中的卡片时候,粒子球应该是旋转的莫比乌斯环啊」。
   * 原来「等你」压过「在办」,只要有一条等拍板,形状就从莫比乌斯环退回球。现在形状只看在不在跑,等你 / 出错只换颜色。
   */
  it('★有在跑的:形状一律是莫比乌斯环(working),等你 / 出错只把环染成琥珀 / 红', () => {
    expect(particleModeOf({ working: true, attention: true, failed: false })).toEqual({ mode: 'working', notice: 'confirmation' });
    expect(particleModeOf({ working: true, attention: true, failed: true })).toEqual({ mode: 'working', notice: 'failed' });
  });
  /**
   * 2026-10-01 维护者:「全平台都是一致的,只要有东西在做有卡在运行就是莫比乌斯环」。
   * 「在跑几件」全工作台只有一个数:服务端拼 /state 时算好的 `running.count`(workbench-plugin/src/running.ts,
   * 电脑首页球下「执行 n」、舞台「正在执行 n」同源)。有这一格就只认它;老工作台没有才自己数。
   */
  it('★在办认 /state.running.count(电脑首页同一个数):事项在执行、会话列表里看不出来也算;它说 0 就不算', () => {
    expect(orbSignalsOf({ ...base, running: { count: 1 } }).working).toBe(true);
    expect(orbSignalsOf({ ...base, running: { count: 0 }, sessions: [{ status: 'running' }] }).working).toBe(false);
    expect(orbSignalsOf({ ...base, stale: true, running: { count: 2 } }).working).toBe(false);
    expect(orbSignalsOf({ ...base, running: {}, sessions: [{ status: 'running' }] }).working).toBe(true);
  });
  it('★登记表里在跑的会话(窗口型那几家、新家)也算在办;没接上的那家、快照旧的不算', () => {
    const reg = (status: string, sessions: { status: string }[], gaps: Record<string, string> = {}) =>
      ({ ...base, agent_registry: { entries: [{ status, gaps, sessions, counts: { running: 0, waiting: 0, unread: 0 } }] } });
    expect(orbSignalsOf(reg('running', [{ status: 'running' }])).working).toBe(true);
    expect(orbSignalsOf(reg('unknown', [{ status: 'running' }])).working).toBe(false);
    expect(orbSignalsOf(reg('running', [{ status: 'running' }], { status: '读不到' })).working).toBe(false);
    expect(orbSignalsOf({ ...reg('running', [{ status: 'running' }]), stale: true }).working).toBe(false);
    expect(orbSignalsOf(reg('idle', [{ status: 'done' }])).working).toBe(false);
  });
  it('★一件还开着的事真出错了 = 红,压过「等你」;办完 / 取消 / 他停的不算', () => {
    const failing = { status: 'doing', direction: 'mine', block_reason: 'error' };
    expect(orbSignalsOf({ ...base, tasks: { tasks: [failing] } }).failed).toBe(true);
    expect(orbSignalsOf({ ...base, tasks: { tasks: [{ ...failing, status: 'done' }] } }).failed).toBe(false);
    expect(orbSignalsOf({ ...base, tasks: { tasks: [{ status: 'doing', assignee: 'claude', dispatch: { status: 'failed', stopped: {} } }] } }).failed).toBe(false);
    expect(orbSignalsOf({ ...base, tasks: { tasks: [{ status: 'doing', assignee: 'claude', client_dispatch: { status: 'failed' } }] } }).failed).toBe(true);
    // 不在事项里的(没负责人、也不是交给事务官的)不算
    expect(orbSignalsOf({ ...base, tasks: { tasks: [{ status: 'doing', block_reason: 'error' }] } }).failed).toBe(false);
    expect(particleModeOf({ working: false, attention: true, failed: true })).toEqual({ mode: 'acknowledging', notice: 'failed' });
  });
});

describe('交给核心的参数与态:中心光团一律关、在办是莫比乌斯环(同手机 orbState.ts)', () => {
  it('★光团关掉(cloudSize = 0),其余参数原样;自转兜底照旧', () => {
    const out = displayOrbSettings({ cloudSize: 0.8, count: 3600, spinSpeed: 0.4 });
    expect(out.cloudSize).toBe(0);
    expect(out.count).toBe(3600);
    expect(out.spinSpeed).toBe(0.4);
    expect(displayOrbSettings({ spinSpeed: 0 }).spinSpeed).toBe(STAGE_FALLBACK_SPIN);
  });
  it('★在办交核心的 working(莫比乌斯环),等你 / 出错还是球(交 idle),不变笑脸', () => {
    expect(STAGE_CORE_MODE.working).toBe('working');
    expect(STAGE_CORE_MODE.acknowledging).toBe('idle');
    expect(STAGE_CORE_MODE.idle).toBe('idle');
  });
});

describe('旋转:优先用 Mac 那份外观里的 spinSpeed', () => {
  it('Mac 上调过自转就照它来,别的参数原样带过去', () => {
    const out = withStageSpin({ spinSpeed: 0.7, count: 3600 });
    expect(out.spinSpeed).toBe(0.7);
    expect(out.count).toBe(3600);
  });
  it('负数(反向转)也是转,不覆盖', () => {
    expect(withStageSpin({ spinSpeed: -0.5 }).spinSpeed).toBe(-0.5);
  });
  it('★Mac 上把自转调成 0(或接近 0)时,展示台仍给一档慢速自转 —— Ben 要的是「旋转的粒子」', () => {
    expect(withStageSpin({ spinSpeed: 0 }).spinSpeed).toBe(STAGE_FALLBACK_SPIN);
    expect(withStageSpin({ spinSpeed: 0.005 }).spinSpeed).toBe(STAGE_FALLBACK_SPIN);
    expect(withStageSpin({}).spinSpeed).toBe(STAGE_FALLBACK_SPIN);
  });
  it('不改原对象(外观那份要留着比版本)', () => {
    const settings = { spinSpeed: 0 };
    withStageSpin(settings);
    expect(settings.spinSpeed).toBe(0);
  });
});

describe('粒子核心起不来时:退回占位球,不白屏', () => {
  const ok = { hasNode: true, hasContextClass: true, context: {} };
  it('一切正常 = 不退级', () => {
    expect(particleUnavailableReason(ok)).toBeNull();
  });
  it('★没有 canvas 节点 → 退级,并说得出原因', () => {
    expect(particleUnavailableReason({ ...ok, hasNode: false })).toBe('没有 canvas 节点');
  });
  it('★老 WebView / jsdom 里连 CanvasRenderingContext2D 都没有 → 退级', () => {
    expect(particleUnavailableReason({ ...ok, hasContextClass: false })).toContain('CanvasRenderingContext2D');
  });
  it('★有节点但给不出 2D 上下文(上下文数量到顶、GPU 挂了)→ 退级', () => {
    expect(particleUnavailableReason({ ...ok, context: null })).toBe('这块 canvas 给不出 2D 上下文');
    expect(particleUnavailableReason({ ...ok, context: undefined })).toBe('这块 canvas 给不出 2D 上下文');
  });
  it('退级的原因一定是一句人话,不是空串 —— 它会被写进 console 给真机排错用', () => {
    for (const env of [{ ...ok, hasNode: false }, { ...ok, hasContextClass: false }, { ...ok, context: null }]) {
      const reason = particleUnavailableReason(env);
      expect(reason).not.toBeNull();
      expect(reason!.length).toBeGreaterThan(4);
    }
  });
});

describe('底图与排法(2026-09-30 横屏补齐)', () => {
  it('★粒子那条路:不铺那张动漫房间图,一律中性深色(同手机 #0f0f0f,09-24「一律深色、去蓝」)', () => {
    expect(stageBackdrop({ kind: 'particles' }, 0)).toEqual({ url: null, scheme: 'dark' });
    expect(stageBackdrop({ kind: 'particles' }, 1)).toEqual({ url: null, scheme: 'dark' });
  });
  it('Live2D 那条路(?avatar=)照旧:两张底图双击切换,一字不动', () => {
    expect(stageBackdrop({ kind: 'live2d', avatarId: 'hijiki' }, 0).url).toBe('/backgrounds/display-bg.jpg');
    expect(stageBackdrop({ kind: 'live2d', avatarId: 'hijiki' }, 1)).toEqual({ url: '/backgrounds/display-bg-2.jpg', scheme: 'light' });
  });
  it('★手机横屏(宽高比明显比稿子扁)换三栏排法;1200×800 那台还是 v4 稿子', () => {
    expect(isWideScreen(873, 393)).toBe(true);
    expect(isWideScreen(915, 412)).toBe(true);
    expect(isWideScreen(1200, 800)).toBe(false);
    expect(isWideScreen(788, 493)).toBe(false);
    expect(isWideScreen(0, 0)).toBe(false);
  });
});

describe('横屏展示台用哪一套(2026-10-01,手机 设置 › 声音与形象 › 展示台样式)', () => {
  it('?layout=orbit = 第二套「环绕」;不写 / 写别的 = 原来那套', () => {
    expect(resolveDisplayLayout('?feed=host&layout=orbit')).toBe('orbit');
    expect(resolveDisplayLayout('?feed=host')).toBe('classic');
    expect(resolveDisplayLayout('?layout=whatever')).toBe('classic');
    expect(resolveDisplayLayout('')).toBe('classic');
  });
});
