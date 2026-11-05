import { describe, expect, it } from 'vitest';
import {
  ALARM_TIMEOUT_SECONDS,
  applyPomodoroCommand,
  initialPomodoro,
  REST_SECONDS,
  tickPomodoro,
  type PomodoroState,
} from './holoPomodoro';

function run(s: PomodoroState, work: number, ticks: number, acked = false) {
  let cur = s;
  const fires: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = tickPomodoro(cur, work, acked);
    cur = r.state;
    if (r.fire) fires.push(r.fire);
  }
  return { state: cur, fires };
}

describe('tickPomodoro 状态机', () => {
  it('work 倒数到 0 → 进 alarm 并 fire alarm（只一次）', () => {
    const { state, fires } = run(initialPomodoro(3), 3, 3);
    expect(state.phase).toBe('alarm');
    expect(fires).toEqual(['alarm']);
  });

  it('alarm 收到摸头 ack → 立即进 rest(10 分钟)', () => {
    const alarm: PomodoroState = { phase: 'alarm', remain: 0, alarmElapsed: 5, paused: false };
    const { state } = run(alarm, 25 * 60, 1, true);
    expect(state.phase).toBe('rest');
    expect(state.remain).toBe(REST_SECONDS);
    expect(REST_SECONDS).toBe(600); // Ben：休息 10 分钟
  });

  it('alarm 无人应答 120s → 自动进 rest（兜底不卡死）', () => {
    const alarm: PomodoroState = { phase: 'alarm', remain: 0, alarmElapsed: 0, paused: false };
    const { state } = run(alarm, 25 * 60, ALARM_TIMEOUT_SECONDS);
    expect(state.phase).toBe('rest');
  });

  it('rest 倒数完 → 回 work(时长取配置) 并 fire workStart(开工口播)', () => {
    const rest: PomodoroState = { phase: 'rest', remain: 2, alarmElapsed: 0, paused: false };
    const { state, fires } = run(rest, 25 * 60, 2);
    expect(state.phase).toBe('work');
    expect(state.remain).toBe(25 * 60);
    expect(fires).toEqual(['workStart']);
  });

  it('work 相位的 ack 不产生任何跳变（摸头只在闹钟时有意义）', () => {
    const { state } = run(initialPomodoro(100), 100, 5, true);
    expect(state.phase).toBe('work');
    expect(state.remain).toBe(95);
  });
});

describe('语音暂停/继续专注（paused 旗标）', () => {
  it('pause 后 work 倒计时冻结，resume 恢复', () => {
    let s = initialPomodoro(100);
    s = applyPomodoroCommand(s, 'pause');
    const frozen = run(s, 100, 5);
    expect(frozen.state.remain).toBe(100); // 冻结不减
    s = applyPomodoroCommand(frozen.state, 'resume');
    const moving = run(s, 100, 5);
    expect(moving.state.remain).toBe(95);
  });

  it('rest 同样可暂停；alarm 相位不受 paused 影响（物理闹钟照摇）', () => {
    const rest: PomodoroState = { phase: 'rest', remain: 50, alarmElapsed: 0, paused: true };
    expect(run(rest, 100, 5).state.remain).toBe(50);
    const alarm: PomodoroState = { phase: 'alarm', remain: 0, alarmElapsed: 0, paused: true };
    expect(run(alarm, 100, 1, true).state.phase).toBe('rest'); // 摸头照样进休息
  });
});

describe('闹钟补发（防命令丢失）', () => {
  it('alarm 相位每 20s fire alarmAgain（不触发口播型 alarm）', () => {
    const alarm: PomodoroState = { phase: 'alarm', remain: 0, alarmElapsed: 0, paused: false };
    const { fires } = run(alarm, 100, 45);
    expect(fires.filter((f) => f === 'alarmAgain').length).toBe(2); // 20s、40s 两次
    expect(fires.filter((f) => f === 'alarm').length).toBe(0);
  });
});
