import { useCallback, useEffect, useRef, useState } from 'react';

// 专注模式番茄钟：倒计时(默认 25min，用户可改)，到点提醒起来走走/喝口水，可再来一轮。
// 音乐是背景板，这里只管「专注节奏」，不干预播放。
export function FocusTimer({
  pomodoroMin,
  onChangeMin,
}: {
  pomodoroMin: number;
  onChangeMin: (min: number) => void;
}) {
  const [remainingSec, setRemainingSec] = useState(pomodoroMin * 60);
  const [running, setRunning] = useState(false);
  const [onBreak, setOnBreak] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // 开始后收起成小气泡，点击再展开
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 时长变化(用户改设置)且未在跑 → 重置倒计时到新时长。
  useEffect(() => {
    if (!running && !onBreak) setRemainingSec(pomodoroMin * 60);
  }, [pomodoroMin, running, onBreak]);

  const stopTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!running) {
      stopTick();
      return;
    }
    tickRef.current = setInterval(() => {
      setRemainingSec((s) => {
        if (s <= 1) {
          setRunning(false);
          setOnBreak(true); // 到点 → 进入休息提醒
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return stopTick;
  }, [running, stopTick]);

  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  const ss = String(remainingSec % 60).padStart(2, '0');

  const adjustMin = (delta: number) => {
    const next = Math.min(180, Math.max(1, pomodoroMin + delta));
    onChangeMin(next);
  };

  const startAnother = () => {
    setOnBreak(false);
    setRemainingSec(pomodoroMin * 60);
    setRunning(true);
    setCollapsed(true); // 再来一轮直接收起
  };

  const reset = () => {
    setRunning(false);
    setOnBreak(false);
    setCollapsed(false); // 重置回到完整设置态
    setRemainingSec(pomodoroMin * 60);
  };

  // 开始/继续 → 收起成小气泡；暂停保持展开。
  const toggleRun = () => {
    setRunning((r) => {
      const next = !r;
      if (next) setCollapsed(true);
      return next;
    });
  };

  if (onBreak) {
    return (
      <div className="dj-focus-timer dj-focus-timer--break">
        <div className="dj-focus-break-title">这一轮专注完成 🎉</div>
        <div className="dj-focus-break-tip">起来走一走，喝口水，让眼睛歇一会儿～</div>
        <button type="button" className="dj-focus-btn dj-focus-btn--primary" onClick={startAnother}>
          再来一轮（{pomodoroMin} 分钟）
        </button>
      </div>
    );
  }

  // 收起态：只露一个能看到时间的小气泡，点击展开完整控制。
  if (collapsed) {
    return (
      <button
        type="button"
        className="dj-focus-bubble"
        onClick={() => setCollapsed(false)}
        aria-label="展开专注计时"
      >
        <span className={`dj-focus-bubble-dot${running ? ' dj-focus-bubble-dot--run' : ''}`} />
        <span className="dj-focus-bubble-time">
          {mm}:{ss}
        </span>
      </button>
    );
  }

  return (
    <div className="dj-focus-timer">
      <div className="dj-focus-time" aria-label="专注倒计时">
        {mm}:{ss}
      </div>
      <div className="dj-focus-controls">
        {!running && (
          <div className="dj-focus-set" aria-label="设置时长">
            <button type="button" className="dj-focus-step" onClick={() => adjustMin(-5)} aria-label="减 5 分钟">
              −
            </button>
            <span className="dj-focus-min">{pomodoroMin} 分钟</span>
            <button type="button" className="dj-focus-step" onClick={() => adjustMin(5)} aria-label="加 5 分钟">
              ＋
            </button>
          </div>
        )}
        <button type="button" className="dj-focus-btn dj-focus-btn--primary" onClick={toggleRun}>
          {running ? '暂停' : remainingSec === pomodoroMin * 60 ? '开始专注' : '继续'}
        </button>
        <button type="button" className="dj-focus-btn" onClick={reset}>
          重置
        </button>
        {/* 已开始过(非满计时或运行中) → 可手动收起成小气泡。 */}
        {(running || remainingSec !== pomodoroMin * 60) && (
          <button type="button" className="dj-focus-btn" onClick={() => setCollapsed(true)}>
            收起
          </button>
        )}
      </div>
    </div>
  );
}
