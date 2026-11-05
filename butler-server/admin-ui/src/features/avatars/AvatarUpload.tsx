// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarUpload.tsx
/** 新建角色：meta 表单（name/summary/persona/transform）+ zip 上传，构造 multipart 提交。 */
import { useState } from 'react';
import { createAvatar } from '@/features/avatars/api';
import { AdminApiError } from '@/shared/api/errors';
import { PersonaForm } from '@/features/avatars/components/PersonaForm';
import { TransformForm } from '@/features/avatars/components/TransformForm';
import { ZipUploader } from '@/shared/components/ZipUploader';
import { toast } from '@/shared/components/toast';
import { useNavigate } from 'react-router-dom';
import { defaultPersona, defaultTransform } from '@/features/avatars/defaults';
import type { CreateAvatarMeta, Persona, Transform } from '@/shared/types';

export function AvatarUpload() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [persona, setPersona] = useState<Persona>(defaultPersona());
  const [transform, setTransform] = useState<Transform>(defaultTransform());
  const [zip, setZip] = useState<File | null>(null);
  const [progress, setProgress] = useState(-1);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    name.trim() !== '' &&
    summary.trim() !== '' &&
    persona.tone.trim() !== '' &&
    zip !== null &&
    !submitting;

  const onSubmit = async () => {
    if (!zip) {
      toast.error('请先选择合法的 zip 包');
      return;
    }
    const meta: CreateAvatarMeta = { name, summary, persona, transform };
    setSubmitting(true);
    setProgress(0);
    try {
      const created = await createAvatar(meta, zip, setProgress);
      toast.success(`已创建草稿角色 ${created.name}（${created.id}）`);
      navigate('/avatars');
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
      setProgress(-1);
    }
  };

  return (
    <div>
      <h2>新建角色</h2>
      <p className="subtitle">填写基础信息与人设，并上传初始 zip（创建后为 draft 状态）</p>

      <div className="card">
        <label>名称 *</label>
        <input type="text" value={name} placeholder="例如：Mika" onChange={(e) => setName(e.target.value)} />
        <label>简介 summary *</label>
        <textarea value={summary} placeholder="一句话介绍这个角色" onChange={(e) => setSummary(e.target.value)} />
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          人设 Persona
        </div>
        <PersonaForm value={persona} onChange={setPersona} />
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          Transform（已填入默认值）
        </div>
        <TransformForm value={transform} onChange={setTransform} />
      </div>

      <div className="card">
        <ZipUploader onFileChange={setZip} progress={progress} />
      </div>

      <div className="actions">
        <button className="btn" onClick={() => navigate('/avatars')}>
          取消
        </button>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void onSubmit()}>
          {submitting ? '上传中…' : '创建角色'}
        </button>
      </div>
    </div>
  );
}
