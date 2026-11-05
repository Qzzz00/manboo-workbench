import { useState, type CSSProperties } from 'react';
import { updateProfile, type UserInfo } from '../lib/authStore.ts';
import { ApiError } from '../lib/apiClient.ts';

const THIS_YEAR = new Date().getFullYear();
// 年份列表：最小 18 岁（今年-18）到 100 岁（今年-100），倒序，便于快速选到出生年。
const YEARS: number[] = [];
for (let y = THIS_YEAR - 18; y >= THIS_YEAR - 100; y -= 1) YEARS.push(y);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function daysInMonth(year: number, month: number): number {
  if (!year || !month) return 31;
  return new Date(year, month, 0).getDate(); // month 1-based → 当月最后一天
}
function pad(n: number): string { return String(n).padStart(2, '0'); }

/** 客户端粗算周岁（仅即时 UX；最终以服务端为准）。 */
function ageOf(y: number, m: number, d: number): number {
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age;
}

interface Props {
  open: boolean;
  title?: string;
  subtitle?: string;
  initial?: string | null;
  /** 强制模式：入口年龄门，禁止取消/点外部关闭，必须填写年满 18 才放行。 */
  mandatory?: boolean;
  onClose: () => void;
  onSaved: (user: UserInfo) => void;
}

export function BirthdayGateModal({ open, title, subtitle, initial, mandatory, onClose, onSaved }: Props) {
  const im = /^(\d{4})-(\d{2})-(\d{2})$/.exec(initial || '');
  const [year, setYear] = useState<number | ''>(im ? Number(im[1]) : '');
  const [month, setMonth] = useState<number | ''>(im ? Number(im[2]) : '');
  const [day, setDay] = useState<number | ''>(im ? Number(im[3]) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const maxDay = daysInMonth(Number(year), Number(month));
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);

  async function confirm() {
    setError('');
    if (year === '' || month === '' || day === '') { setError('请选择完整的出生年月日'); return; }
    const d = Math.min(Number(day), daysInMonth(Number(year), Number(month)));
    if (ageOf(Number(year), Number(month), d) < 18) { setError('未满 18 周岁，暂未开放此功能'); return; }
    const birth = `${year}-${pad(Number(month))}-${pad(d)}`;
    setSaving(true);
    try {
      const user = await updateProfile({ birth_date: birth });
      onSaved(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError('未满 18 周岁，暂未开放此功能');
      else if (err instanceof ApiError && err.status === 400) setError('日期不正确，请重新选择');
      else setError('保存失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  const selStyle: CSSProperties = {
    flex: 1, padding: '10px 8px', fontSize: 16, borderRadius: 10,
    border: '1px solid #ddd', background: '#fff', color: '#333',
  };

  return (
    <div className="profile-edit-mask" onClick={mandatory ? undefined : onClose}>
      <div className="profile-edit-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="profile-edit-title">{title || '填写出生日期'}</div>
        <div style={{ fontSize: 13, color: '#888', margin: '4px 0 14px', lineHeight: 1.5 }}>
          {subtitle || '该功能仅向年满 18 周岁的用户开放，需要确认你的年龄。'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select style={selStyle} value={year} onChange={(e) => { setYear(e.target.value === '' ? '' : Number(e.target.value)); setError(''); }}>
            <option value="">年</option>
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select style={selStyle} value={month} onChange={(e) => { setMonth(e.target.value === '' ? '' : Number(e.target.value)); setError(''); }}>
            <option value="">月</option>
            {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select style={selStyle} value={day} onChange={(e) => { setDay(e.target.value === '' ? '' : Number(e.target.value)); setError(''); }}>
            <option value="">日</option>
            {days.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        {error && <div style={{ color: '#e0526b', fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div className="profile-edit-actions">
          {mandatory ? null : (
            <button className="profile-edit-cancel" onClick={onClose} disabled={saving}>取消</button>
          )}
          <button className="profile-edit-confirm" onClick={confirm} disabled={saving}>
            {saving ? '保存中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BirthdayGateModal;
