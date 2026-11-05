import { useEffect, useState } from 'react';
import { useGeolocation } from '../../../hooks/useGeolocation.ts';
import type { LocationFeedbackValue, TaskEvaluation } from '../types.ts';

type LocationFeedbackInputProps = {
  evaluation?: TaskEvaluation['location'];
  value: LocationFeedbackValue | null;
  onChange: (value: LocationFeedbackValue | null) => void;
  disabled?: boolean;
};

export function LocationFeedbackInput({
  evaluation,
  value,
  onChange,
  disabled,
}: LocationFeedbackInputProps) {
  const { state: geo, request, reset } = useGeolocation();
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');

  useEffect(() => {
    if (
      geo.status === 'ok' &&
      (!value || value.lat !== geo.lat || value.lng !== geo.lng || value.accuracy !== geo.accuracy)
    ) {
      onChange({ kind: 'location', lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy });
    }
  }, [geo, value, onChange]);

  const applyManual = () => {
    const lat = Number.parseFloat(manualLat);
    const lng = Number.parseFloat(manualLng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      onChange({ kind: 'location', lat, lng });
    }
  };

  const lat = value?.lat ?? (geo.status === 'ok' ? geo.lat : undefined);
  const lng = value?.lng ?? (geo.status === 'ok' ? geo.lng : undefined);

  return (
    <div className="task-field">
      <span>位置反馈</span>

      {lat !== undefined && lng !== undefined && (
        <div className="task-location-result">
          已选位置：{lat.toFixed(6)}, {lng.toFixed(6)}
          {evaluation && (
            <span className="task-hint">
              （目标：{evaluation.targetLat}, {evaluation.targetLng}，半径 {evaluation.radiusM}m）
            </span>
          )}
        </div>
      )}

      {geo.status === 'requesting' && <span className="task-hint">正在获取位置…</span>}
      {geo.status === 'error' && <span className="task-input-error-text">{geo.message}</span>}

      <div className="task-location-actions">
        <button
          type="button"
          className="task-media-button"
          onClick={request}
          disabled={disabled || geo.status === 'requesting'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          获取当前位置
        </button>
        {value && (
          <button type="button" className="task-secondary-button" onClick={() => { onChange(null); reset(); }} disabled={disabled}>
            清除
          </button>
        )}
      </div>

      {geo.status === 'error' && (
        <div className="task-manual-fallback">
          <span className="task-hint">手动输入坐标</span>
          <div className="task-manual-coords">
            <input
              type="number"
              step="any"
              placeholder="纬度"
              value={manualLat}
              onChange={(event) => setManualLat(event.target.value)}
              disabled={disabled}
            />
            <input
              type="number"
              step="any"
              placeholder="经度"
              value={manualLng}
              onChange={(event) => setManualLng(event.target.value)}
              disabled={disabled}
            />
            <button type="button" className="task-secondary-button" onClick={applyManual} disabled={disabled}>
              使用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
