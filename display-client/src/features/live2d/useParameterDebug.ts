import { useEffect, useState } from 'react';
import {
  discoverAllLive2DParameters,
} from './parameterDiscovery.ts';
import { type Live2DParameterDiscoveryResult } from './avatarManifest.ts';

const DEBUG_MODE_KEY = 'aiboo.debugMode';

export interface UseParameterDebugResult {
  debugMode: boolean;
  setDebugMode: (on: boolean) => void;
  parameterDiscoveryResults: Live2DParameterDiscoveryResult[];
  parameterDiscoveryRunning: boolean;
  parameterDiscoveryStatus: string;
  /** 串行扫描所有内置角色的可调参数（调试面板「抓取参数」）。 */
  handleDiscoverParameters: () => Promise<void>;
}

/**
 * Live2D 模型参数调试工具：debugMode 开关(持久化) + 参数发现扫描。
 * 从 App.tsx 抽出，行为不变。注意 handleParameterCall(把调试调用桥接到渲染
 * 状态)仍留在 App.tsx，因为它要写 mouthOpen / parameterOverrides 等共享状态。
 */
export function useParameterDebug(): UseParameterDebugResult {
  const [debugMode, setDebugMode] = useState(() => {
    try {
      return localStorage.getItem(DEBUG_MODE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [parameterDiscoveryResults, setParameterDiscoveryResults] = useState<Live2DParameterDiscoveryResult[]>([]);
  const [parameterDiscoveryRunning, setParameterDiscoveryRunning] = useState(false);
  const [parameterDiscoveryStatus, setParameterDiscoveryStatus] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(DEBUG_MODE_KEY, String(debugMode));
    } catch {
      // ignore persistence failures
    }
  }, [debugMode]);

  async function handleDiscoverParameters() {
    if (parameterDiscoveryRunning) return;
    setParameterDiscoveryRunning(true);
    setParameterDiscoveryResults([]);
    setParameterDiscoveryStatus('开始串行扫描内置角色');

    try {
      const results = await discoverAllLive2DParameters((result) => {
        setParameterDiscoveryResults((current) => [...current, result]);
        setParameterDiscoveryStatus(
          `${result.avatarName}: ${result.parameters.length} params${result.error ? ' (fallback)' : ''}`,
        );
      });
      setParameterDiscoveryStatus(`扫描完成：${results.length} 个角色`);
    } catch (error) {
      setParameterDiscoveryStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setParameterDiscoveryRunning(false);
    }
  }

  return {
    debugMode,
    setDebugMode,
    parameterDiscoveryResults,
    parameterDiscoveryRunning,
    parameterDiscoveryStatus,
    handleDiscoverParameters,
  };
}
