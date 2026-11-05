import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AvatarParameterControl,
  AvatarExpression,
  DiscoveredLive2DParameter,
  Live2DParameterDiscoveryResult,
  ParameterCall,
  MouthSyncState,
} from '../features/live2d/avatarManifest.ts';
import { avatarList } from '../features/live2d/avatarManifest.ts';
import { applyParameterCall } from '../features/live2d/live2dEngine.ts';

type ParameterCallResult = {
  ok: boolean;
  message: string;
};

type ControlDrawerProps = {
  open: boolean;
  onToggle: () => void;
  selectedAvatarId: string;
  onAvatarChange: (id: string) => void;
  visibleExpressions: AvatarExpression[];
  activeExpressionKeys: Set<string>;
  onExpressionClick: (key: string) => void;
  parameterControls: AvatarParameterControl[] | undefined;
  activeParameterMap: Map<string, number>;
  mouthSyncState?: MouthSyncState;
  paramOverridesCount: number;
  discoveryResults: Live2DParameterDiscoveryResult[];
  discoveryRunning: boolean;
  discoveryStatus: string;
  onDiscoverParameters: () => void;
  onParameterCall: (
    call: ParameterCall,
    parameter: DiscoveredLive2DParameter,
  ) => ParameterCallResult;
  scrollToParameterDebug?: boolean;
};

export function ControlDrawer({
  open,
  onToggle,
  selectedAvatarId,
  onAvatarChange,
  visibleExpressions,
  activeExpressionKeys,
  onExpressionClick,
  parameterControls,
  activeParameterMap,
  mouthSyncState,
  paramOverridesCount,
  discoveryResults,
  discoveryRunning,
  discoveryStatus,
  onDiscoverParameters,
  onParameterCall,
  scrollToParameterDebug,
}: ControlDrawerProps) {
  const [expandedAvatarId, setExpandedAvatarId] = useState(selectedAvatarId);
  const [search, setSearch] = useState('');
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [callMessage, setCallMessage] = useState('');
  const mouthLevel = mouthSyncState?.level ?? 0;
  const [displayMouthOpen, setDisplayMouthOpen] = useState(mouthLevel.toFixed(2));

  useEffect(() => {
    const id = setInterval(() => {
      setDisplayMouthOpen(mouthLevel.toFixed(2));
    }, 100);
    return () => clearInterval(id);
  }, [mouthLevel]);

  const drawerRef = useRef<HTMLElement>(null);
  const shouldScrollRef = useRef(false);

  useEffect(() => {
    shouldScrollRef.current = !!scrollToParameterDebug;
  }, [scrollToParameterDebug]);

  useEffect(() => {
    if (open && shouldScrollRef.current && drawerRef.current) {
      const el = drawerRef.current.querySelector('.parameter-debug-panel');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      shouldScrollRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!discoveryResults.some((result) => result.avatarId === expandedAvatarId)) {
      setExpandedAvatarId(discoveryResults[0]?.avatarId ?? selectedAvatarId);
    }
  }, [discoveryResults, expandedAvatarId, selectedAvatarId]);

  const expandedResult = discoveryResults.find((result) => result.avatarId === expandedAvatarId);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredParameters = useMemo(() => {
    const parameters = expandedResult?.parameters ?? [];
    if (!normalizedSearch) return parameters;
    return parameters.filter((parameter) => {
      const label = parameter.label?.toLowerCase() ?? '';
      return parameter.id.toLowerCase().includes(normalizedSearch) || label.includes(normalizedSearch);
    });
  }, [expandedResult, normalizedSearch]);

  function formatNumber(value: number | undefined) {
    return typeof value === 'number' ? Number(value.toFixed(4)).toString() : '未知';
  }

  function getMetadataSupplementCount(result: Live2DParameterDiscoveryResult) {
    return result.parameters.filter((parameter) => {
      const hasRuntime = parameter.source.includes('runtime');
      const hasMetadata = parameter.source.some((source) => source === 'cdi3' || source === 'vtube' || source === 'exp3');
      return hasMetadata && !hasRuntime;
    }).length;
  }

  function handleCall(parameter: DiscoveredLive2DParameter) {
    const key = `${parameter.avatarId}:${parameter.id}`;
    const rawValue = parameterValues[key] ?? String(parameter.currentValue ?? parameter.defaultValue ?? parameter.min ?? 0);
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed)) {
      setCallMessage(`${parameter.id} 调用失败：请输入数字`);
      return;
    }

    let normalizedCall: ParameterCall;
    try {
      normalizedCall = applyParameterCall(
        { avatarId: parameter.avatarId, id: parameter.id, value: parsed },
        parameter,
      );
    } catch (error) {
      setCallMessage(`${parameter.id} 调用失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const result = onParameterCall(normalizedCall, parameter);
    setCallMessage(result.message);
    if (result.ok) {
      setParameterValues((current) => ({ ...current, [key]: String(normalizedCall.value) }));
    }
  }

  return (
    <>
      {open ? (
        // 点击空白处关闭抽屉（移动端长按呼出后需要可关闭）。
        <div className="control-drawer-backdrop" onClick={onToggle} aria-hidden="true" />
      ) : null}
      <section ref={drawerRef} className={`control-drawer ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="control-drawer-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>模型控制</span>
        <span className="control-drawer-toggle-meta">
          {visibleExpressions.length} 个表情
          {paramOverridesCount ? ` · ${paramOverridesCount} 个参数` : ''}
        </span>
      </button>
      {open ? (
        <div className="control-drawer-body">
          <div className="control-drawer-section">
            <p className="control-drawer-label">角色</p>
            <label className="field">
              <select
                value={selectedAvatarId}
                onChange={(event) => onAvatarChange(event.target.value)}
              >
                {avatarList.map((avatar) => (
                  <option key={avatar.id} value={avatar.id}>
                    {avatar.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="control-drawer-section">
            <p className="control-drawer-label">Expressions</p>
            <div className="chip-row">
              {visibleExpressions.map((expression) => (
                <button
                  key={expression.id}
                  type="button"
                  className={activeExpressionKeys.has(expression.id) ? 'chip active' : 'chip'}
                  onClick={() => onExpressionClick(expression.id)}
                >
                  {expression.label}
                </button>
              ))}
            </div>
          </div>
          <div className="control-drawer-section">
            <p className="control-drawer-label">Params</p>
            <div className="chip-row">
              {(parameterControls?.length ?? 0) > 0 ? (
                parameterControls!.map((pc) => {
                  const isMouthParam = pc.id === (mouthSyncState?.target?.parameterId ?? 'ParamMouthOpenY');
                  const activeValue =
                    isMouthParam && mouthSyncState?.active
                      ? mouthSyncState.appliedValue
                      : activeParameterMap.get(pc.id);
                  return (
                    <span
                      key={pc.id}
                      className={activeValue !== undefined ? 'chip active readonly' : 'chip readonly'}
                    >
                      {pc.label}
                      {activeValue !== undefined ? ` ${activeValue.toFixed(2)}` : ''}
                    </span>
                  );
                })
              ) : (
                <span className="chip readonly">No discovered params</span>
              )}
            </div>
            {mouthSyncState?.active ? (
              <p className="parameter-debug-status">
                口型同步: {mouthSyncState.target?.parameterId} level={mouthSyncState.level.toFixed(2)} value={mouthSyncState.appliedValue.toFixed(2)}
              </p>
            ) : mouthSyncState?.target && !mouthSyncState.active ? (
              <p className="parameter-debug-status">
                口型参数: {mouthSyncState.target.parameterId}（未激活）
              </p>
            ) : null}
          </div>
          <div className="control-drawer-section parameter-debug-panel">
            <div className="parameter-debug-header">
              <p className="control-drawer-label">Parameter Debug</p>
              <button
                type="button"
                className="reset-button parameter-debug-scan"
                disabled={discoveryRunning}
                onClick={onDiscoverParameters}
              >
                {discoveryRunning ? '发现中' : '发现参数'}
              </button>
            </div>
            <p className="parameter-debug-status">
              {discoveryStatus || '尚未扫描'}
              {' · mouthOpen: '}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{displayMouthOpen}</span>
            </p>
            {discoveryResults.length > 0 ? (
              <>
                <div className="parameter-summary-grid">
                  {discoveryResults.map((result) => {
                    const runtimeCount = result.parameters.filter((parameter) => parameter.source.includes('runtime')).length;
                    const callableCount = result.parameters.filter((parameter) => parameter.callable).length;
                    return (
                      <button
                        key={result.avatarId}
                        type="button"
                        className={`parameter-summary-row ${expandedAvatarId === result.avatarId ? 'is-active' : ''}`}
                        onClick={() => setExpandedAvatarId(result.avatarId)}
                      >
                        <span>{result.avatarId}</span>
                        <span>{result.avatarName}</span>
                        <span>{result.parameters.length} total</span>
                        <span>{runtimeCount} runtime</span>
                        <span>{getMetadataSupplementCount(result)} extra</span>
                        <span>{callableCount} callable</span>
                      </button>
                    );
                  })}
                </div>
                <label className="field parameter-search-field">
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search id or label"
                  />
                </label>
                {expandedResult?.error ? (
                  <p className="parameter-debug-error">{expandedResult.error}</p>
                ) : null}
                <div className="parameter-table-wrap">
                  <table className="parameter-table">
                    <thead>
                      <tr>
                        <th>id</th>
                        <th>label</th>
                        <th>min</th>
                        <th>max</th>
                        <th>default</th>
                        <th>current</th>
                        <th>source</th>
                        <th>call</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredParameters.map((parameter) => {
                        const key = `${parameter.avatarId}:${parameter.id}`;
                        const canCall = parameter.callable && parameter.avatarId === selectedAvatarId;
                        const rangeKnown = typeof parameter.min === 'number' || typeof parameter.max === 'number';
                        return (
                          <tr key={key}>
                            <td title={parameter.id}>{parameter.id}</td>
                            <td>{parameter.label ?? '-'}</td>
                            <td>{formatNumber(parameter.min)}</td>
                            <td>{formatNumber(parameter.max)}</td>
                            <td>{formatNumber(parameter.defaultValue)}</td>
                            <td>{formatNumber(parameter.currentValue)}</td>
                            <td>{parameter.source.join(', ')}</td>
                            <td>
                              <div className="parameter-call-cell">
                                <input
                                  type="number"
                                  step="0.01"
                                  min={parameter.min}
                                  max={parameter.max}
                                  value={parameterValues[key] ?? ''}
                                  placeholder={rangeKnown ? 'value' : '未知范围'}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setParameterValues((current) => ({ ...current, [key]: value }));
                                  }}
                                />
                                <button
                                  type="button"
                                  className="reset-button parameter-call-button"
                                  disabled={!canCall}
                                  title={canCall ? '调用参数' : '仅当前已选角色的 runtime 参数可调用'}
                                  onClick={() => handleCall(parameter)}
                                >
                                  调用
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {callMessage ? <p className="parameter-debug-status">{callMessage}</p> : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      </section>
    </>
  );
}
