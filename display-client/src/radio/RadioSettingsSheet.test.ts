// RadioSettingsSheet 渲染逻辑验证：直接调用组件函数取 React 元素树（无 hooks，纯展示组件，
// 同 TrackListSheet.test.ts 模式）。mock 掉 radioLauncherPlugin 的默认导出，逐按钮断言
// openSystemSettings 收到的 section 参数是否与 brief 的映射表（wifi/bluetooth/home/settings）一致——
// 这是本任务 self-review 要求的“五个按钮都接了真实调用”的最硬验证。
// U3 设备离线（Ben 拿在手里），真机点击后 dumpsys topResumedActivity 验证 pending。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// vi.mock 工厂被提升到文件顶部（早于下面的静态 import）；工厂内不能直接引用普通顶层变量
// （会因提升顺序炸 ReferenceError），必须经 vi.hoisted 声明同样被提升的 mock fn。
// 效果：RadioSettingsSheet.tsx 内部 `import RadioLauncher from '../lib/radioLauncherPlugin.ts'`
// 拿到的就是这个 stub（同 radioLauncherPlugin.test.ts mock @capacitor/core 的写法）。
const { openSystemSettings, requestBatteryExemption } = vi.hoisted(() => ({
  openSystemSettings: vi.fn().mockResolvedValue(undefined),
  requestBatteryExemption: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/radioLauncherPlugin.ts', () => ({
  default: { openSystemSettings, requestBatteryExemption },
}));

import { RadioSettingsSheet } from './RadioSettingsSheet.tsx';

type AnyEl = ReactElement<Record<string, unknown>>;

function collect(node: unknown, pred: (el: AnyEl) => boolean, out: AnyEl[] = []): AnyEl[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out; }
  const el = node as AnyEl;
  if ('props' in el) {
    if (pred(el)) out.push(el);
    collect(el.props.children, pred, out);
  }
  return out;
}

const noop = () => {};
const byText = (el: AnyEl, text: string) =>
  collect(el, (e) => e.type === 'button' && e.props.children === text)[0];

// 必填 props 的默认值：各用例只覆写自己关心的那个回调。
const props = (over: Partial<Parameters<typeof RadioSettingsSheet>[0]> = {}) => ({
  onRescan: noop,
  onClose: noop,
  djId: 'hijiki',
  onSelectDj: noop,
  voiceVolume: 0.45,
  onVoiceVolume: noop,
  ...over,
});

beforeEach(() => { openSystemSettings.mockClear(); requestBatteryExemption.mockClear(); });

describe('RadioSettingsSheet 结构', () => {
  it('五个操作按钮 + 关于文案齐全', () => {
    const el = RadioSettingsSheet(props());
    const html = renderToStaticMarkup(el);
    expect(html).toContain('Wi-Fi 设置');
    expect(html).toContain('蓝牙设置');
    expect(html).toContain('更换默认桌面');
    expect(html).toContain('系统设置');
    expect(html).toContain('重新扫描音乐');
    expect(html).toContain('后台播放保护');
    expect(html).toContain('com.aiboo.radio');
  });
});

// careai ROM app-idle 杀服务的根治入口之二：首启弹窗被拒后，用户可在设置页手动重新发起豁免申请。
describe('RadioSettingsSheet 后台播放保护 → requestBatteryExemption', () => {
  it('点击「后台播放保护」→ 拉起电池优化豁免弹窗，不触碰 openSystemSettings', () => {
    const el = RadioSettingsSheet(props());
    const btn = byText(el, '后台播放保护');
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(requestBatteryExemption).toHaveBeenCalledTimes(1);
    expect(openSystemSettings).not.toHaveBeenCalled();
  });
});

describe('RadioSettingsSheet 系统设置直达按钮 → openSystemSettings({ section })', () => {
  it.each([
    ['Wi-Fi 设置', 'wifi'],
    ['蓝牙设置', 'bluetooth'],
    ['更换默认桌面', 'home'],
    ['系统设置', 'settings'],
  ] as const)('点击“%s” → section=%s', (label, section) => {
    const el = RadioSettingsSheet(props());
    const btn = byText(el, label);
    expect(btn).toBeDefined();
    (btn!.props.onClick as () => void)();
    expect(openSystemSettings).toHaveBeenCalledTimes(1);
    expect(openSystemSettings).toHaveBeenCalledWith({ section });
  });

  it('四个按钮互不串线：只点“蓝牙设置”时其余 section 不触发', () => {
    const el = RadioSettingsSheet(props());
    (byText(el, '蓝牙设置')!.props.onClick as () => void)();
    expect(openSystemSettings).toHaveBeenCalledTimes(1);
    expect(openSystemSettings).toHaveBeenCalledWith({ section: 'bluetooth' });
  });
});

describe('RadioSettingsSheet DJ 角色切换', () => {
  it('三只角色都列出，当前选中的那只带 --on 类', () => {
    const html = renderToStaticMarkup(RadioSettingsSheet(props({ djId: 'ghostie' })));
    expect(html).toContain('小黑猫');
    expect(html).toContain('幽灵狗');
    expect(html).toContain('小幽灵');
    // 选中态只有一个：class 里出现且仅出现一次 radio-dj-chip--on
    expect(html.match(/radio-dj-chip--on/g)).toHaveLength(1);
  });

  it('点击某只 → onSelectDj 收到它的 id，不触碰系统设置', () => {
    const onSelectDj = vi.fn();
    const el = RadioSettingsSheet(props({ onSelectDj }));
    (byText(el, '幽灵狗')!.props.onClick as () => void)();
    expect(onSelectDj).toHaveBeenCalledWith('ghostpuppy');
    expect(openSystemSettings).not.toHaveBeenCalled();
  });
});

describe('RadioSettingsSheet 重扫 + 关闭', () => {
  it('“重新扫描音乐”→ onRescan，不触碰 openSystemSettings', () => {
    const onRescan = vi.fn();
    const el = RadioSettingsSheet(props({ onRescan }));
    (byText(el, '重新扫描音乐')!.props.onClick as () => void)();
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(openSystemSettings).not.toHaveBeenCalled();
  });

  it('叫声音量滑块：显示当前百分比，拖动 → onVoiceVolume 收到 0..1', () => {
    const onVoiceVolume = vi.fn();
    const el = RadioSettingsSheet(props({ voiceVolume: 0.45, onVoiceVolume }));
    // 百分比要显示出来，否则用户不知道自己调到哪了
    expect(renderToStaticMarkup(el)).toContain('45%');
    const range = collect(el, (e) => e.props.className === 'radio-voice-vol-range')[0];
    expect(range, '找不到音量滑块').toBeTruthy();
    expect(range!.props.value).toBe(45);
    // 滑块是 0-100 的整数，组件负责换算回 0..1
    (range!.props.onChange as (e: { currentTarget: { value: string } }) => void)(
      { currentTarget: { value: '80' } },
    );
    expect(onVoiceVolume).toHaveBeenCalledWith(0.8);
  });

  it('关闭按钮 → onClose，不触碰 onRescan', () => {
    const onRescan = vi.fn();
    const onClose = vi.fn();
    const el = RadioSettingsSheet(props({ onRescan, onClose }));
    const closeBtn = collect(el, (e) => e.type === 'button' && e.props.children === '✕')[0];
    (closeBtn!.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRescan).not.toHaveBeenCalled();
  });
});
