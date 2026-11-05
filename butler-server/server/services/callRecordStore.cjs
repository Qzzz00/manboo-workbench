'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/services/callRecordStore.cjs
// 本机版:Aiboo 的 user_id 换成 device_id(手机的设备 id,由工作台 8791 转发时经 X-Workbench-Device 头给出;
// 本机回环调用记 'local')。字段只留通话记录的最小集:谁(设备)、哪个形象、房间、任务、起止、时长、结束原因。
// 旅程/行为账/互动计数一律不搬。
//
// /api/rtc/start 成功插入一条(started_at=now),/api/rtc/stop 凭 task_id 找回并结算 ended_at / duration_seconds /
// end_reason(normal|error)。重复 stop 幂等:已结算的记录不再改、直接返回 already_settled。
// start 后没有 stop(崩溃)允许记录悬置,本期不做兜底结算。

const { nanoid } = require('nanoid');

const ID_LENGTH = 12;

function createCallRecord(db, { deviceId, avatarId, roomId, taskId, startedAt }) {
  const id = `call_${nanoid(ID_LENGTH)}`;
  db.prepare(
    `INSERT INTO call_records (id, device_id, avatar_id, room_id, task_id, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, deviceId || 'local', avatarId || '', roomId, taskId, startedAt);
  return id;
}

function getByTaskId(db, taskId) {
  if (!taskId) return null;
  return db.prepare('SELECT * FROM call_records WHERE task_id = ?').get(taskId) || null;
}

// 结算:返回 'settled'(本次写入)/ 'already_settled'(幂等命中)/ 'not_found'。
// 只在未结算行上更新,并发/重复 stop 只有第一次生效。
function settleByTaskId(db, taskId, { endedAt, endReason }) {
  const row = getByTaskId(db, taskId);
  if (!row) return { status: 'not_found', record: null };
  if (row.ended_at != null) return { status: 'already_settled', record: row };
  const duration = Math.max(0, endedAt - row.started_at);
  const res = db.prepare(
    'UPDATE call_records SET ended_at = ?, duration_seconds = ?, end_reason = ? WHERE task_id = ? AND ended_at IS NULL',
  ).run(endedAt, duration, endReason, taskId);
  if (res.changes === 0) return { status: 'already_settled', record: getByTaskId(db, taskId) };
  return { status: 'settled', record: getByTaskId(db, taskId) };
}

module.exports = { createCallRecord, getByTaskId, settleByTaskId };
