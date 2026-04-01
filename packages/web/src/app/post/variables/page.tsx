'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Variable = {
  id: string;
  key: string;
  label: string;
  source: 'system' | 'custom';
  resolve_type: 'auto' | 'static';
  default_value: string | null;
  description: string | null;
  is_deletable: boolean;
  created_at: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export default function VariablesPage() {
  const [variables, setVariables] = useState<Variable[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newDefault, setNewDefault] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchVariables = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/post/variables`);
      const data = await res.json();
      setVariables(data);
    } catch (e) {
      console.error('Failed to fetch variables:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchVariables(); }, [fetchVariables]);

  const handleAdd = async () => {
    if (!newKey.trim() || !newLabel.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/post/variables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: newKey.trim(),
          label: newLabel.trim(),
          default_value: newDefault.trim() || null,
          description: newDesc.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || '追加に失敗しました');
        return;
      }
      setNewKey('');
      setNewLabel('');
      setNewDefault('');
      setNewDesc('');
      await fetchVariables();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (v: Variable) => {
    if (!confirm(`変数「${v.key}」を削除しますか？`)) return;
    try {
      const res = await fetch(`${API_URL}/api/post/variables/${v.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || '削除に失敗しました');
        return;
      }
      await fetchVariables();
    } catch (e) {
      console.error('Failed to delete:', e);
    }
  };

  const systemVars = variables.filter(v => v.source === 'system');
  const customVars = variables.filter(v => v.source === 'custom');

  return (
    <div>
      <Link href="/post" className="text-sm text-text-secondary hover:text-text-primary transition-colors mb-1 inline-block">&larr; X投稿管理</Link>
      <h1 className="text-2xl font-bold mb-6">テンプレート変数管理</h1>

      {/* System Variables */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3 text-text-secondary">システム変数（自動解決）</h2>
        <div className="bg-card-bg border border-border-card rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-card text-text-secondary">
                <th className="text-left px-4 py-2.5 font-medium">変数名</th>
                <th className="text-left px-4 py-2.5 font-medium">ラベル</th>
                <th className="text-left px-4 py-2.5 font-medium">説明</th>
                <th className="text-left px-4 py-2.5 font-medium w-40">使い方</th>
              </tr>
            </thead>
            <tbody>
              {systemVars.map(v => (
                <tr key={v.id} className="border-b border-border-card/50 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">{v.key}</td>
                  <td className="px-4 py-2.5">{v.label}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{v.description}</td>
                  <td className="px-4 py-2.5">
                    <code className="bg-border-card/50 px-2 py-0.5 rounded text-xs">{`{{${v.key}}}`}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Custom Variables */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3 text-text-secondary">カスタム変数（手動設定）</h2>
        {customVars.length > 0 && (
          <div className="bg-card-bg border border-border-card rounded-xl overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-card text-text-secondary">
                  <th className="text-left px-4 py-2.5 font-medium">変数名</th>
                  <th className="text-left px-4 py-2.5 font-medium">ラベル</th>
                  <th className="text-left px-4 py-2.5 font-medium">デフォルト値</th>
                  <th className="text-left px-4 py-2.5 font-medium">説明</th>
                  <th className="text-right px-4 py-2.5 font-medium w-20">操作</th>
                </tr>
              </thead>
              <tbody>
                {customVars.map(v => (
                  <tr key={v.id} className="border-b border-border-card/50 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs">{v.key}</td>
                    <td className="px-4 py-2.5">{v.label}</td>
                    <td className="px-4 py-2.5 text-text-secondary">{v.default_value || '—'}</td>
                    <td className="px-4 py-2.5 text-text-secondary">{v.description || '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => handleDelete(v)}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {customVars.length === 0 && !loading && (
          <p className="text-text-secondary text-sm mb-4">カスタム変数はまだありません。</p>
        )}
      </section>

      {/* Add Custom Variable */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-text-secondary">カスタム変数を追加</h2>
        <div className="bg-card-bg border border-border-card rounded-xl p-4">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs text-text-secondary mb-1 block">変数名（英数字）</label>
              <input
                type="text"
                value={newKey}
                onChange={e => setNewKey(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                placeholder="shop_name"
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">ラベル（日本語）</label>
              <input
                type="text"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="店舗名"
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">デフォルト値</label>
              <input
                type="text"
                value={newDefault}
                onChange={e => setNewDefault(e.target.value)}
                placeholder="オリパーク秋葉原"
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">説明</label>
              <input
                type="text"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder="投稿に含める店舗名"
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>
          <button
            onClick={handleAdd}
            disabled={saving || !newKey.trim() || !newLabel.trim()}
            className="bg-text-primary text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {saving ? '追加中...' : '追加する'}
          </button>
        </div>
      </section>

      {loading && (
        <div className="text-center py-10 text-text-secondary">読み込み中...</div>
      )}
    </div>
  );
}
