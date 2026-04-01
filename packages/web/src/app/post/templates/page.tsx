'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Template = {
  id: string;
  name: string;
  franchise: string | null;
  header_template: string;
  item_template: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFranchise, setNewFranchise] = useState('');
  const [newHeader, setNewHeader] = useState('');

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/post/templates`);
      const data = await res.json();
      setTemplates(data);
    } catch (e) {
      console.error('Failed to fetch templates:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleCreate = async () => {
    if (!newName.trim() || !newHeader.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/api/post/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          franchise: newFranchise || null,
          header_template: newHeader,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || '作成に失敗しました');
        return;
      }
      setNewName('');
      setNewFranchise('');
      setNewHeader('');
      await fetchTemplates();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (t: Template) => {
    if (!confirm(`テンプレート「${t.name}」を削除しますか？`)) return;
    const res = await fetch(`${API_URL}/api/post/templates/${t.id}`, { method: 'DELETE' });
    if (res.ok) await fetchTemplates();
  };

  return (
    <div>
      <Link href="/post" className="text-sm text-text-secondary hover:text-text-primary transition-colors mb-1 inline-block">&larr; X投稿管理</Link>
      <h1 className="text-2xl font-bold mb-6">投稿テンプレート管理</h1>

      {/* Template List */}
      <section className="mb-8">
        <div className="grid gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-card-bg border border-border-card rounded-xl p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold">{t.name}</h3>
                  <div className="flex gap-2 mt-1">
                    {t.franchise && (
                      <span className="text-xs bg-border-card/50 px-2 py-0.5 rounded">
                        {FRANCHISE_JA[t.franchise] || t.franchise}
                      </span>
                    )}
                    {t.is_default && (
                      <span className="text-xs bg-green-900/30 text-green-400 px-2 py-0.5 rounded">
                        デフォルト
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/post/templates/${t.id}`}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    編集
                  </Link>
                  <button
                    onClick={() => handleDelete(t)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    削除
                  </button>
                </div>
              </div>
              <pre className="text-xs text-text-secondary mt-2 whitespace-pre-wrap line-clamp-4 font-sans">
                {t.header_template}
              </pre>
            </div>
          ))}
        </div>
        {templates.length === 0 && !loading && (
          <p className="text-text-secondary text-sm">テンプレートはまだありません。</p>
        )}
      </section>

      {/* Create Template */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-text-secondary">新規テンプレート作成</h2>
        <div className="bg-card-bg border border-border-card rounded-xl p-4">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs text-text-secondary mb-1 block">テンプレート名</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="通常買取表（ポケモン）"
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">商材（空欄=全商材共通）</label>
              <select
                value={newFranchise}
                onChange={e => setNewFranchise(e.target.value)}
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              >
                <option value="">全商材共通</option>
                <option value="Pokemon">ポケモン</option>
                <option value="ONE PIECE">ワンピース</option>
                <option value="YU-GI-OH!">遊戯王</option>
              </select>
            </div>
          </div>
          <div className="mb-3">
            <label className="text-xs text-text-secondary mb-1 block">
              ヘッダーテンプレート（{`{{変数名}}`} で変数埋め込み可能）
            </label>
            <textarea
              value={newHeader}
              onChange={e => setNewHeader(e.target.value)}
              rows={8}
              placeholder={`🚩{{date_short}} #ポケカ PSA10 買取表🚩\n⚡本日もポケカPSA10高額買い取り対応中⚡\n\n買取詳細\n...`}
              className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim() || !newHeader.trim()}
            className="bg-text-primary text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {creating ? '作成中...' : '作成する'}
          </button>
        </div>
      </section>

      {loading && (
        <div className="text-center py-10 text-text-secondary">読み込み中...</div>
      )}
    </div>
  );
}
