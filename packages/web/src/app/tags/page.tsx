'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

const FRANCHISES = [
  { key: 'Pokemon', label: 'ポケモン' },
  { key: 'ONE PIECE', label: 'ワンピース' },
  { key: 'YU-GI-OH!', label: '遊戯王' },
] as const;

type TagStat = {
  tag: string;
  avg_count: number;
  min_count: number;
  max_count: number;
  appeared_in: number;
};

type Rule = {
  id: string;
  franchise: string;
  tag_pattern: string;
  match_type: string;
  behavior: string;
  priority: number;
  notes: string | null;
  group_key: string | null;
  created_at: string;
};

export default function TagsPage() {
  const [franchise, setFranchise] = useState('Pokemon');
  const [stats, setStats] = useState<TagStat[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingRules, setLoadingRules] = useState(false);

  // グループ作成
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const res = await fetch(`${API_URL}/api/tag-stats?franchise=${encodeURIComponent(franchise)}&runs=5`);
      if (res.ok) {
        const data = await res.json();
        setStats(data.tags || []);
      }
    } catch { /* */ }
    setLoadingStats(false);
  }, [franchise]);

  const fetchRules = useCallback(async () => {
    setLoadingRules(true);
    try {
      const res = await fetch(`${API_URL}/api/rules`);
      if (res.ok) {
        const data: Rule[] = await res.json();
        setRules(data.filter(r => r.franchise === franchise));
      }
    } catch { /* */ }
    setLoadingRules(false);
  }, [franchise]);

  useEffect(() => {
    fetchStats();
    fetchRules();
    setSelectedTags(new Set());
  }, [fetchStats, fetchRules]);

  const toggleTag = (tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const selectedTotal = stats
    .filter(s => selectedTags.has(s.tag))
    .reduce((sum, s) => sum + s.avg_count, 0);

  const handleCreateGroup = async () => {
    if (selectedTags.size === 0 || !groupName.trim()) return;
    setCreating(true);
    try {
      // 各タグに対して rule を作成（同じ group_key）
      for (const tag of selectedTags) {
        await fetch(`${API_URL}/api/rules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            franchise,
            tag_pattern: tag,
            match_type: 'contains',
            behavior: 'group',
            priority: 50,
            group_key: groupName.trim(),
          }),
        });
      }
      setSelectedTags(new Set());
      setGroupName('');
      fetchRules();
    } catch { /* */ }
    setCreating(false);
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm('このルールを削除しますか？')) return;
    await fetch(`${API_URL}/api/rules/${id}`, { method: 'DELETE' });
    fetchRules();
  };

  // グループ化されたルール
  const groupedRules = new Map<string, Rule[]>();
  const standaloneRules: Rule[] = [];
  // 既にルールに使われているタグ → 選択モード時にグレーアウト用
  const usedTagToLabel = new Map<string, string>();
  for (const rule of rules) {
    if (rule.behavior === 'group' && rule.group_key) {
      if (!groupedRules.has(rule.group_key)) groupedRules.set(rule.group_key, []);
      groupedRules.get(rule.group_key)!.push(rule);
      usedTagToLabel.set(rule.tag_pattern, rule.group_key);
    } else {
      standaloneRules.push(rule);
      usedTagToLabel.set(rule.tag_pattern, rule.behavior);
    }
  }
  const isSelectMode = selectedTags.size > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10 pb-32">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs text-text-secondary">
            <Link href="/db" className="hover:underline">← DB管理</Link>
          </p>
          <h1 className="text-2xl sm:text-3xl font-black text-text-primary">タグ管理</h1>
        </div>
      </div>

      {/* Franchise tabs */}
      <div className="flex gap-1 bg-card-bg border border-border-card p-1.5 rounded-full mb-6 w-fit">
        {FRANCHISES.map(f => (
          <button
            key={f.key}
            onClick={() => setFranchise(f.key)}
            className={`px-5 py-2 rounded-full text-sm transition-all ${
              franchise === f.key
                ? 'bg-text-primary text-white font-medium shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* タグ統計 + グループ作成 */}
      <section className="bg-card-bg border border-border-card rounded-2xl p-5 mb-6">
        <h2 className="text-base font-bold text-text-primary mb-3">タグ統計（過去5回平均）</h2>
        {loadingStats ? (
          <p className="text-text-secondary text-sm">読み込み中...</p>
        ) : stats.length === 0 ? (
          <p className="text-text-secondary text-sm">データがありません</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
              {stats.map(s => {
                const isSelected = selectedTags.has(s.tag);
                const belongsTo = usedTagToLabel.get(s.tag);
                // 選択モード中のみ、既にルールに使われているタグをグレーアウト
                const isDisabled = isSelectMode && !!belongsTo && !isSelected;
                return (
                  <button
                    key={s.tag}
                    onClick={() => !isDisabled && toggleTag(s.tag)}
                    disabled={isDisabled}
                    className={`flex items-center justify-between px-4 py-2.5 rounded-xl border text-left transition-all ${
                      isDisabled
                        ? 'border-border-card opacity-40 cursor-not-allowed'
                        : isSelected
                          ? 'border-text-primary bg-warm-100 ring-1 ring-text-primary'
                          : 'border-border-card hover:bg-warm-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-text-primary">{s.tag}</span>
                      {isDisabled && belongsTo && (
                        <span className="text-[10px] text-text-secondary ml-1.5">← {belongsTo}</span>
                      )}
                    </div>
                    <span className="text-sm text-text-secondary flex-shrink-0">
                      平均 <span className="font-bold text-text-primary">{s.avg_count}</span>枚
                      <span className="text-xs ml-1">({s.min_count}-{s.max_count})</span>
                    </span>
                  </button>
                );
              })}
            </div>

            {/* グループ作成パネル */}
            {selectedTags.size > 0 && (
              <div className="border-t border-border-card pt-4">
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-sm text-text-secondary">合計:</span>
                  <span className={`text-lg font-bold ${
                    selectedTotal <= 45 ? 'text-green-600' :
                    selectedTotal <= 50 ? 'text-yellow-600' : 'text-red-600'
                  }`}>
                    {Math.round(selectedTotal * 10) / 10}枚
                  </span>
                  <span className="text-sm text-text-secondary">/ 40枚</span>
                  <div className="flex-1 bg-warm-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        selectedTotal <= 40 ? 'bg-green-500' :
                        selectedTotal <= 45 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${Math.min(100, (selectedTotal / 40) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={groupName}
                    onChange={e => setGroupName(e.target.value)}
                    placeholder="グループ名（例: ピカチュウ+イーブイ）"
                    className="flex-1 px-4 py-2 rounded-xl border border-border-card bg-background text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-text-primary"
                  />
                  <button
                    onClick={handleCreateGroup}
                    disabled={creating || !groupName.trim()}
                    className="px-6 py-2 rounded-xl bg-text-primary text-white text-sm font-medium hover:bg-warm-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {creating ? '作成中...' : 'グループ作成'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* グループ一覧 */}
      {groupedRules.size > 0 && (
        <section className="bg-card-bg border border-border-card rounded-2xl p-5 mb-6">
          <h2 className="text-base font-bold text-text-primary mb-3">ページグループ</h2>
          <div className="space-y-3">
            {Array.from(groupedRules.entries()).map(([groupKey, gRules]) => (
              <div key={groupKey} className="border border-border-card rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-text-primary">{groupKey}</span>
                  <button
                    onClick={async () => {
                      if (!confirm(`グループ「${groupKey}」のルールを全て削除しますか？`)) return;
                      for (const r of gRules) {
                        await fetch(`${API_URL}/api/rules/${r.id}`, { method: 'DELETE' });
                      }
                      fetchRules();
                    }}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    グループ削除
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {gRules.map(r => (
                    <span key={r.id} className="text-xs px-3 py-1 rounded-full bg-warm-100 text-text-primary">
                      {r.tag_pattern}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 個別ルール一覧 */}
      <section className="bg-card-bg border border-border-card rounded-2xl p-5">
        <h2 className="text-base font-bold text-text-primary mb-3">個別ルール</h2>
        {loadingRules ? (
          <p className="text-text-secondary text-sm">読み込み中...</p>
        ) : standaloneRules.length === 0 ? (
          <p className="text-text-secondary text-sm">ルールがありません</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-secondary border-b border-border-card">
                <th className="pb-2 pr-2">優先度</th>
                <th className="pb-2 pr-2">パターン</th>
                <th className="pb-2 pr-2">タイプ</th>
                <th className="pb-2 pr-2">動作</th>
                <th className="pb-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {standaloneRules.map(rule => (
                <tr key={rule.id} className="border-b border-border-card/50 last:border-0">
                  <td className="py-2 pr-2 text-text-secondary">{rule.priority}</td>
                  <td className="py-2 pr-2 font-medium text-text-primary">{rule.tag_pattern}</td>
                  <td className="py-2 pr-2 text-text-secondary">{rule.match_type}</td>
                  <td className="py-2 pr-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      rule.behavior === 'isolate' ? 'bg-blue-100 text-blue-700' :
                      rule.behavior === 'exclude' ? 'bg-red-100 text-red-700' :
                      'bg-warm-100 text-text-secondary'
                    }`}>
                      {rule.behavior}
                    </span>
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className="text-red-400 hover:text-red-600 text-xs"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
