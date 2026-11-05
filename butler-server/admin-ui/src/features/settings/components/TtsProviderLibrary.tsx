// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/settings/components/TtsProviderLibrary.tsx
/**
 * 类型化 TTS provider 库（dashscope | volcengine）。比通用 ProviderLibrary 复杂：
 * 字段随 provider_type 变化；密钥脱敏（preview + 留空不改）。
 */
import { useEffect, useState } from 'react';
import {
  createTtsProvider,
  deleteTtsProvider,
  listTtsProviders,
  patchTtsProvider,
} from '@/features/settings/api/ttsProviders';
import type { TtsProvider, TtsProviderType } from '@/shared/types';
import { AdminApiError } from '@/shared/api/errors';
import { toast } from '@/shared/components/toast';

type FieldSpec = { key: string; label: string; secret: boolean; placeholder?: string };

// 与服务端 ttsProviderStore.TYPES 对应。
const TYPE_FIELDS: Record<TtsProviderType, FieldSpec[]> = {
  dashscope: [
    { key: 'apiUrl', label: '接口地址', secret: false, placeholder: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' },
    { key: 'apiKey', label: 'API Key', secret: true },
    { key: 'model', label: '模型名', secret: false, placeholder: 'qwen3-tts-instruct-flash' },
  ],
  volcengine: [
    { key: 'appid', label: 'App ID', secret: false },
    { key: 'accessToken', label: 'Access Token', secret: true },
    { key: 'cluster', label: 'Cluster', secret: false, placeholder: 'volcano_tts（复刻音色自动用 volcano_icl）' },
    { key: 'ak', label: 'AccessKey AK（查复刻音色用，可选）', secret: false },
    { key: 'sk', label: 'SecretKey SK（查复刻音色用，可选）', secret: true },
  ],
  minimax: [
    { key: 'apiKey', label: 'API Key', secret: true },
    { key: 'groupId', label: 'Group ID', secret: false },
    { key: 'model', label: '模型名（可选）', secret: false, placeholder: 'speech-2.8-hd（便宜可填 speech-2.8-turbo）' },
    { key: 'apiUrl', label: '接口地址（可选）', secret: false, placeholder: 'https://api.minimaxi.com/v1/t2a_v2' },
    { key: 'defaultVoice', label: '默认音色（可选）', secret: false, placeholder: 'male-qn-jingying' },
  ],
};

const TYPE_LABELS: Record<TtsProviderType, string> = {
  dashscope: 'DashScope (Qwen)',
  volcengine: '火山引擎(豆包语音)',
  minimax: 'MiniMax',
};

function emptyConfig(type: TtsProviderType): Record<string, string> {
  return Object.fromEntries(TYPE_FIELDS[type].map((f) => [f.key, '']));
}

export function TtsProviderLibrary() {
  const [items, setItems] = useState<TtsProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 新增草稿
  const [draftType, setDraftType] = useState<TtsProviderType>('volcengine');
  const [draftName, setDraftName] = useState('');
  const [draftConfig, setDraftConfig] = useState<Record<string, string>>(emptyConfig('volcengine'));
  const [draftDefault, setDraftDefault] = useState(false);

  // 编辑缓冲：id -> config（非密钥预填 / 密钥留空）+ name
  const [edits, setEdits] = useState<Record<string, { name: string; config: Record<string, string> }>>({});

  function load() {
    setLoading(true);
    listTtsProviders()
      .then(setItems)
      .catch((e) => toast.error(e instanceof AdminApiError ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  function onChangeDraftType(type: TtsProviderType) {
    setDraftType(type);
    setDraftConfig(emptyConfig(type));
  }

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      load();
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function onCreate() {
    if (!draftName.trim()) {
      toast.error('名称必填');
      return;
    }
    // 只发非空字段；server 校验必填项。
    const config: Record<string, string> = {};
    for (const f of TYPE_FIELDS[draftType]) {
      const v = (draftConfig[f.key] || '').trim();
      if (v) config[f.key] = v;
    }
    void run(
      () => createTtsProvider({ name: draftName.trim(), provider_type: draftType, config, isDefault: draftDefault }),
      '已新增',
    ).then(() => {
      setDraftName('');
      setDraftConfig(emptyConfig(draftType));
      setDraftDefault(false);
    });
  }

  function editBuf(p: TtsProvider) {
    return edits[p.id] ?? { name: p.name, config: { ...p.config } };
  }
  function setEditName(p: TtsProvider, name: string) {
    setEdits((prev) => ({ ...prev, [p.id]: { ...editBuf(p), ...prev[p.id], name } }));
  }
  function setEditField(p: TtsProvider, key: string, value: string) {
    setEdits((prev) => {
      const cur = prev[p.id] ?? { name: p.name, config: { ...p.config } };
      return { ...prev, [p.id]: { ...cur, config: { ...cur.config, [key]: value } } };
    });
  }

  function onSave(p: TtsProvider) {
    const b = editBuf(p);
    // config: 非密钥发当前值；密钥仅在用户填了才发（空=不改）。
    const config: Record<string, string> = {};
    for (const f of TYPE_FIELDS[p.provider_type]) {
      const v = (b.config[f.key] ?? '').trim();
      if (f.secret) {
        if (v) config[f.key] = v;
      } else {
        config[f.key] = v;
      }
    }
    void run(() => patchTtsProvider(p.id, { name: b.name, config }), '已保存').then(() =>
      setEdits((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      }),
    );
  }

  function onDelete(p: TtsProvider) {
    if (!window.confirm(`删除 TTS provider「${p.name}」？`)) return;
    void run(() => deleteTtsProvider(p.id), '已删除');
  }
  function onSetDefault(p: TtsProvider) {
    void run(() => patchTtsProvider(p.id, { isDefault: true }), '已设为默认');
  }

  if (loading) return <p className="loading">加载中…</p>;

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        语音合成服务。音色在角色编辑页按角色配（来源：此处默认 provider 的官方精选 + 账号复刻音色）。火山复刻音色需填
        AK/SK 才能自动查询。
      </p>

      {/* 新增 */}
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          新增 TTS provider
        </div>
        <label>类型</label>
        <select value={draftType} onChange={(e) => onChangeDraftType(e.target.value as TtsProviderType)}>
          {(Object.keys(TYPE_FIELDS) as TtsProviderType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <label>名称 *</label>
        <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="如 火山-豆包" />
        {TYPE_FIELDS[draftType].map((f) => (
          <div key={f.key}>
            <label>{f.label}</label>
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              value={draftConfig[f.key] || ''}
              onChange={(e) => setDraftConfig((c) => ({ ...c, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
            />
          </div>
        ))}
        <label className="field-row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={draftDefault} onChange={(e) => setDraftDefault(e.target.checked)} style={{ width: 'auto' }} />
          <span>设为默认</span>
        </label>
        <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={onCreate}>
          新增
        </button>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <p className="empty">暂无，先新增一个。</p>
      ) : (
        items.map((p) => {
          const b = editBuf(p);
          return (
            <div className="card" key={p.id}>
              <div className="section-title" style={{ marginTop: 0 }}>
                {p.name} <span className="mono" style={{ color: 'var(--muted)' }}>· {TYPE_LABELS[p.provider_type]}{p.is_default ? ' · 默认' : ''}</span>
              </div>
              <label>名称</label>
              <input value={b.name} onChange={(e) => setEditName(p, e.target.value)} />
              {TYPE_FIELDS[p.provider_type].map((f) => (
                <div key={f.key}>
                  <label>
                    {f.label}
                    {f.secret && p.secrets[f.key]?.preview && (
                      <span className="mono"> · {p.secrets[f.key].preview}</span>
                    )}
                  </label>
                  <input
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={b.config[f.key] ?? ''}
                    onChange={(e) => setEditField(p, f.key, e.target.value)}
                    placeholder={f.secret ? '留空则不修改' : f.placeholder}
                  />
                </div>
              ))}
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => onSave(p)}>
                  保存
                </button>
                {!p.is_default && (
                  <button className="btn" disabled={busy} onClick={() => onSetDefault(p)}>
                    设为默认
                  </button>
                )}
                <button className="btn btn-danger" disabled={busy} onClick={() => onDelete(p)}>
                  删除
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
