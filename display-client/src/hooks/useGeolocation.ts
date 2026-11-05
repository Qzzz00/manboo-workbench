import { useCallback, useRef, useState } from 'react';

export type GeolocationState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'ok'; lat: number; lng: number; accuracy?: number }
  | { status: 'error'; code: 'permission_denied' | 'position_unavailable' | 'timeout' | 'unsupported'; message: string };

const isSupported = typeof navigator !== 'undefined' && 'geolocation' in navigator;

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({ status: 'idle' });
  const watchIdRef = useRef<number | null>(null);

  const clearWatch = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const request = useCallback(() => {
    if (!isSupported) {
      setState({
        status: 'error',
        code: 'unsupported',
        message: '当前环境不支持定位，可手动输入坐标',
      });
      return;
    }

    setState({ status: 'requesting' });

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        clearWatch();
        setState({
          status: 'ok',
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (error) => {
        clearWatch();
        if (error.code === error.PERMISSION_DENIED) {
          setState({
            status: 'error',
            code: 'permission_denied',
            message: '位置权限被拒绝，请手动输入坐标或到设置中开启权限',
          });
        } else if (error.code === error.TIMEOUT) {
          setState({ status: 'error', code: 'timeout', message: '定位超时，请重试' });
        } else {
          setState({
            status: 'error',
            code: 'position_unavailable',
            message: '无法获取位置，请检查定位服务',
          });
        }
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 },
    );
  }, [clearWatch]);

  const reset = useCallback(() => {
    clearWatch();
    setState({ status: 'idle' });
  }, [clearWatch]);

  return { state, request, reset };
}
