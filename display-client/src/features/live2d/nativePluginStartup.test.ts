import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pluginSource = readFileSync(
  new URL('../../../android/app/src/main/java/com/llm/live2d/nativelive2d/NativeLive2DPlugin.java', import.meta.url),
  'utf8',
);
const sceneSource = readFileSync(new URL('../../screensaver/Live2DScene.tsx', import.meta.url), 'utf8');

function pluginMethod(name: string): string {
  const start = pluginSource.indexOf(`public void ${name}(PluginCall call)`);
  const end = pluginSource.indexOf('@PluginMethod', start);
  return pluginSource.slice(start, end < 0 ? undefined : end);
}

describe('原生 Live2D 启动交接', () => {
  it('在模型首帧回调成功后才透明化 WebView', () => {
    const attachLayer = pluginSource.indexOf('c.attachUnderOnUiThread(parent, 0, params);');
    const successfulFrame = pluginSource.indexOf('if (result == null) {');
    const transparencyHandoff = pluginSource.indexOf('makeStageTransparentOnUiThread();', successfulFrame);

    expect(attachLayer).toBeGreaterThanOrEqual(0);
    expect(transparencyHandoff).toBeGreaterThan(successfulFrame);
  });

  it('show 和 hide 只在原生帧/暂停回调内 resolve', () => {
    expect(pluginMethod('show')).toContain(
      'controller().showAfterFrame(call.getLong("lifecycleTraceId"), null, call::resolve);',
    );
    expect(pluginMethod('hide')).toContain('controller().hideAfterPause(call::resolve);');
    expect(pluginMethod('show')).not.toContain('controller().show();');
    expect(pluginMethod('hide')).not.toContain('controller().hide();');
  });

  it('屏保最终布局和底栏下发后再等待合成帧并通知 onReady', () => {
    const finalRefit = sceneSource.indexOf('await refitNativeStage(container);');
    const bottomBar = sceneSource.indexOf('setNativeBottomBar(bottomBar ?? null);', finalRefit);
    const compositeFrame = sceneSource.indexOf('await waitNativeScreensaverCompositeFrame(3000);', bottomBar);
    const ready = sceneSource.indexOf('onReady?.(nativeController);', compositeFrame);

    expect(finalRefit).toBeGreaterThanOrEqual(0);
    expect(bottomBar).toBeGreaterThan(finalRefit);
    expect(compositeFrame).toBeGreaterThan(bottomBar);
    expect(ready).toBeGreaterThan(compositeFrame);
  });
});
