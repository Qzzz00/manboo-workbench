import { useState, useRef } from 'react';
import { logout, updateProfile, type UserInfo } from '../lib/authStore.ts';
import { showToast } from '../lib/toastStore.ts';
import { BirthdayGateModal } from './BirthdayGateModal.tsx';

type ProfilePageProps = {
  open: boolean;
  user: UserInfo;
  onClose: () => void;
  onLogout: () => void;
  onUserUpdate: (user: UserInfo) => void;
  diaryCount: number;
  favTotal: number;
};

export function ProfilePage({ open, user, onClose, onLogout, onUserUpdate, diaryCount, favTotal }: ProfilePageProps) {
  const [editing, setEditing] = useState<'nickname' | 'gender' | 'signature' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [bdayOpen, setBdayOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  function startEdit(field: 'nickname' | 'gender' | 'signature') {
    setEditing(field);
    setEditValue(field === 'nickname' ? user.nickname : field === 'signature' ? user.signature : user.gender);
  }

  async function confirmEdit() {
    if (!editing) return;
    try {
      const updated = await updateProfile({ [editing]: editValue.trim() });
      onUserUpdate(updated);
      showToast('保存成功', 'info', 2000);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : '保存失败';
      showToast(message, 'error', 4000);
    }
    setEditing(null);
  }

  function handleLogout() {
    logout();
    onLogout();
  }

  function handleAvatarClick() {
    avatarInputRef.current?.click();
  }

  async function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const resized = await resizeImage(dataUrl, 200, 200);
      try {
        const updated = await updateProfile({ avatar: resized });
        onUserUpdate(updated);
        showToast('头像更新成功', 'info', 2000);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : '头像更新失败';
        showToast(message, 'error', 4000);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function resizeImage(dataUrl: string, maxW: number, maxH: number): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > maxW || height > maxH) {
          const ratio = Math.min(maxW / width, maxH / height);
          width *= ratio;
          height *= ratio;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = dataUrl;
    });
  }

  const isEmojiAvatar = !user.avatar || !user.avatar.startsWith('data:');

  return (
    <div className="profile-overlay">
      <div className="profile-backdrop" onClick={onClose} />
      <div className="profile-sheet">
        <div className="profile-nav">
          <button className="profile-nav-back" onClick={onClose}>‹</button>
          <span className="profile-nav-title">个人主页</span>
          <div className="profile-nav-right" />
        </div>

        <div className="profile-body">
          <div className="profile-user-row">
            <div className="profile-avatar-wrap" onClick={handleAvatarClick}>
              {isEmojiAvatar ? (
                <span className="profile-avatar-emoji">{user.avatar || '🌸'}</span>
              ) : (
                <img className="profile-avatar-img" src={user.avatar} alt="头像" />
              )}
            </div>
            <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
            <div>
              <div className="profile-name">{user.nickname || user.username}</div>
              <div className="profile-id">ID: {user.id}</div>
            </div>
          </div>

          <div className="profile-card">
            <div className="profile-stat-row">
              <div className="profile-stat">
                <div className="profile-stat-num">{favTotal}</div>
                <div className="profile-stat-label">好感度</div>
              </div>
              <div className="profile-stat">
                <div className="profile-stat-num">{diaryCount}</div>
                <div className="profile-stat-label">日志</div>
              </div>
            </div>
          </div>

          <div className="profile-card">
            {(['nickname', 'gender', 'signature'] as const).map(field => (
              <div key={field} className="profile-info-row" onClick={() => startEdit(field)}>
                <span className="profile-info-label">{field === 'nickname' ? '昵称' : field === 'gender' ? '性别' : '个性签名'}</span>
                <span className="profile-info-val">{user[field] || '未设置'}</span>
              </div>
            ))}
            <div className="profile-info-row" onClick={() => setBdayOpen(true)}>
              <span className="profile-info-label">出生日期</span>
              <span className="profile-info-val">{user.birth_date || '未设置'}</span>
            </div>
          </div>

          <button className="profile-logout-btn" onClick={handleLogout}>退出登录</button>
        </div>
      </div>

      {editing && (
        <div className="profile-edit-mask" onClick={() => setEditing(null)}>
          <div className="profile-edit-sheet" onClick={e => e.stopPropagation()}>
            <div className="profile-edit-title">
              {editing === 'nickname' ? '修改昵称' : editing === 'gender' ? '修改性别' : '修改个性签名'}
            </div>
            {editing === 'gender' ? (
              <div className="profile-edit-gender">
                {['男', '女', '保密'].map(g => (
                  <button key={g} className={`profile-edit-gender-btn ${editValue === g ? 'selected' : ''}`}
                    onClick={() => setEditValue(g)}>{g}</button>
                ))}
              </div>
            ) : (
              <input className="profile-edit-input" type="text" value={editValue}
                onChange={e => setEditValue(e.target.value)} placeholder="请输入" />
            )}
            <div className="profile-edit-actions">
              <button className="profile-edit-cancel" onClick={() => setEditing(null)}>取消</button>
              <button className="profile-edit-confirm" onClick={confirmEdit}>确定</button>
            </div>
          </div>
        </div>
      )}

      <BirthdayGateModal
        open={bdayOpen}
        title="设置出生日期"
        subtitle="部分功能（如剧情旅程）仅向年满 18 周岁的用户开放。"
        initial={user.birth_date}
        onClose={() => setBdayOpen(false)}
        onSaved={(u) => { onUserUpdate(u); showToast('已保存', 'info', 2000); setBdayOpen(false); }}
      />
    </div>
  );
}
