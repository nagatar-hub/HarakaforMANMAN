'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';

type Variable = {
  id: string;
  key: string;
  label: string;
  source: 'system' | 'custom';
};

type Template = {
  id: string;
  name: string;
  franchise: string | null;
  header_template: string;
  item_template: string | null;
  is_default: boolean;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

function resolvePreview(template: string, variables: Variable[]): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = now.getFullYear();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const sampleValues: Record<string, string> = {
    date: `${yyyy}/${mm}/${dd}`,
    date_short: `${mm}/${dd}`,
    franchise: 'ポケモン',
    franchise_en: 'Pokemon',
    page_count: '5',
    page_no: '1',
    page_title: 'TOP①',
    card_count: '12',
    weekday: weekdays[now.getDay()],
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return sampleValues[key] ?? `[${key}]`;
  });
}

export default function TemplateEditorPage() {
  const params = useParams();
  const router = useRouter();
  const templateId = params.id as string;

  const [template, setTemplate] = useState<Template | null>(null);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [headerTemplate, setHeaderTemplate] = useState('');
  const [itemTemplate, setItemTemplate] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [tRes, vRes] = await Promise.all([
        fetch(`${API_URL}/api/post/templates/${templateId}`),
        fetch(`${API_URL}/api/post/variables`),
      ]);
      const t = await tRes.json();
      const v = await vRes.json();
      setTemplate(t);
      setName(t.name);
      setHeaderTemplate(t.header_template);
      setItemTemplate(t.item_template || '');
      setVariables(v);
    } catch (e) {
      console.error('Failed to fetch:', e);
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const insertVariable = (key: string, target: 'header' | 'item') => {
    const tag = `{{${key}}}`;
    if (target === 'header') {
      setHeaderTemplate(prev => prev + tag);
    } else {
      setItemTemplate(prev => prev + tag);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/post/templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          header_template: headerTemplate,
          item_template: itemTemplate || null,
        }),
      });
      if (res.ok) {
        alert('保存しました');
      } else {
        const err = await res.json();
        alert(err.error || '保存に失敗しました');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-center py-10 text-text-secondary">読み込み中...</div>;
  if (!template) return <div className="text-center py-10 text-text-secondary">テンプレートが見つかりません</div>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => router.back()} className="text-text-secondary hover:text-text-primary">← 戻る</button>
        <h1 className="text-2xl font-bold">テンプレート編集</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Editor */}
        <div className="space-y-4">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">テンプレート名</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-card-bg border border-border-card rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {/* Variable chips */}
          <div>
            <label className="text-xs text-text-secondary mb-1 block">変数を挿入（クリックでヘッダーに追加）</label>
            <div className="flex flex-wrap gap-1.5">
              {variables.map(v => (
                <button
                  key={v.id}
                  onClick={() => insertVariable(v.key, 'header')}
                  className="text-xs bg-card-bg border border-border-card hover:border-text-primary/50 px-2 py-1 rounded-lg transition-colors"
                  title={`{{${v.key}}}`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-text-secondary mb-1 block">ヘッダーテンプレート</label>
            <textarea
              value={headerTemplate}
              onChange={e => setHeaderTemplate(e.target.value)}
              rows={12}
              className="w-full bg-card-bg border border-border-card rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label className="text-xs text-text-secondary mb-1 block">アイテムテンプレート（オプション）</label>
            <textarea
              value={itemTemplate}
              onChange={e => setItemTemplate(e.target.value)}
              rows={4}
              placeholder="{{page_no}}/{{page_count}} ページ"
              className="w-full bg-card-bg border border-border-card rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-text-primary text-white px-6 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {saving ? '保存中...' : '保存する'}
          </button>
        </div>

        {/* Preview */}
        <div>
          <label className="text-xs text-text-secondary mb-1 block">プレビュー（サンプル値で展開）</label>
          <div className="bg-card-bg border border-border-card rounded-xl p-4">
            <div className="bg-background rounded-lg p-4">
              <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed">
                {resolvePreview(headerTemplate, variables)}
              </pre>
            </div>
            {itemTemplate && (
              <div className="mt-3 bg-background rounded-lg p-4">
                <p className="text-xs text-text-secondary mb-1">アイテム（ページごと）</p>
                <pre className="text-sm whitespace-pre-wrap font-sans">
                  {resolvePreview(itemTemplate, variables)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
