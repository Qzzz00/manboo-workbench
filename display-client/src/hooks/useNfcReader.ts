import { useCallback, useEffect, useRef, useState } from 'react';

export type NfcReaderState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'ok'; tagId: string }
  | { status: 'error'; code: 'permission_denied' | 'not_available' | 'abort' | 'unknown'; message: string };

// Web NFC API 目前无完整 DOM 类型定义，这里声明最小可用表面。
interface NDEFReadingEvent extends Event {
  serialNumber?: string;
}

interface NDEFReader {
  scan: (options?: { signal?: AbortSignal }) => Promise<void>;
  addEventListener: (type: 'reading', listener: (event: NDEFReadingEvent) => void) => void;
  removeEventListener: (type: 'reading', listener: (event: NDEFReadingEvent) => void) => void;
}

type NfcWindow = Window & {
  NDEFReader?: new () => NDEFReader;
};

const getReader = (): NDEFReader | null => {
  const w = window as unknown as NfcWindow;
  return w.NDEFReader ? new w.NDEFReader() : null;
};

export function useNfcReader() {
  const [state, setState] = useState<NfcReaderState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<NDEFReader | null>(null);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    readerRef.current = null;
  }, []);

  const read = useCallback(async () => {
    stop();

    const reader = getReader();
    if (!reader) {
      setState({ status: 'error', code: 'not_available', message: '当前设备不支持 NFC，可手动输入标签 ID' });
      return;
    }

    readerRef.current = reader;
    const controller = new AbortController();
    abortRef.current = controller;

    const onReading = (event: NDEFReadingEvent) => {
      stop();
      setState({ status: 'ok', tagId: event.serialNumber ?? 'unknown' });
    };

    reader.addEventListener('reading', onReading);
    setState({ status: 'scanning' });

    try {
      await reader.scan({ signal: controller.signal });
    } catch (err) {
      reader.removeEventListener('reading', onReading);

      if (err instanceof DOMException && err.name === 'AbortError') {
        setState({ status: 'idle' });
        return;
      }

      const msg = err instanceof Error ? err.message : String(err ?? '');
      const isPermission = /permission|not allowed|security/i.test(msg);
      setState({
        status: 'error',
        code: isPermission ? 'permission_denied' : 'unknown',
        message: isPermission ? 'NFC 权限被拒绝，可手动输入标签 ID' : `NFC 读取失败：${msg}`,
      });
    }
  }, [stop]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { state, read, stop };
}
