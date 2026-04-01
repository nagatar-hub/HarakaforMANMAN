'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Banner = {
  id: string;
  franchise: string | null;
  name: string;
  image_url: string;
  position_type: 'first' | 'last' | 'none';
  is_default: boolean;
  created_at: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

export default function BannersPage() {
  const [banners, setBanners] = useState<Banner[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFranchise, setNewFranchise] = useState('');
  const [newImageUrl, setNewImageUrl] = useState('');
  const [newPosition, setNewPosition] = useState<'first' | 'last' | 'none'>('last');

  const fetchBanners = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/post/banners`);
      const data = await res.json();
      setBanners(data);
    } catch (e) {
      console.error('Failed to fetch banners:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBanners(); }, [fetchBanners]);

  const handleCreate = async () => {
    if (!newName.trim() || !newImageUrl.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/api/post/banners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          franchise: newFranchise || null,
          image_url: newImageUrl.trim(),
          position_type: newPosition,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || '作成に失敗しました');
        return;
      }
      setNewName('');
      setNewFranchise('');
      setNewImageUrl('');
      setNewPosition('last');
      await fetchBanners();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (b: Banner) => {
    if (!confirm(`バナー「${b.name}」を削除しますか？`)) return;
    const res = await fetch(`${API_URL}/api/post/banners/${b.id}`, { method: 'DELETE' });
    if (res.ok) await fetchBanners();
  };

  const POSITION_LABELS: Record<string, string> = {
    first: '先頭',
    last: '末尾',
    none: 'なし',
  };

  return (
    <div>
      <Link href="/post" className="text-sm text-text-secondary hover:text-text-primary transition-colors mb-1 inline-block">&larr; X投稿管理</Link>
      <h1 className="text-2xl font-bold mb-6">バナー画像管理</h1>

      {/* Banner List */}
      <section className="mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {banners.map(b => (
            <div key={b.id} className="bg-card-bg border border-border-card rounded-xl overflow-hidden">
              <div className="aspect-video bg-background flex items-center justify-center">
                <img
                  src={b.image_url}
                  alt={b.name}
                  className="w-full h-full object-contain"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
              <div className="p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium text-sm">{b.name}</h3>
                    <div className="flex gap-2 mt-1">
                      {b.franchise && (
                        <span className="text-xs bg-border-card/50 px-1.5 py-0.5 rounded">
                          {FRANCHISE_JA[b.franchise] || b.franchise}
                        </span>
                      )}
                      <span className="text-xs text-text-secondary">
                        位置: {POSITION_LABELS[b.position_type]}
                      </span>
                      {b.is_default && (
                        <span className="text-xs bg-green-900/30 text-green-400 px-1.5 py-0.5 rounded">
                          デフォルト
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(b)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {banners.length === 0 && !loading && (
          <p className="text-text-secondary text-sm">バナーはまだありません。</p>
        )}
      </section>

      {/* Create Banner */}
      <section>
        <h2 className="text-lg font-semibold mb-3 text-text-secondary">バナー追加</h2>
        <div className="bg-card-bg border border-border-card rounded-xl p-4">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs text-text-secondary mb-1 block">バナー名</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="ポケモン用フッターバナー"
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
            <div>
              <label className="text-xs text-text-secondary mb-1 block">画像URL</label>
              <input
                type="text"
                value={newImageUrl}
                onChange={e => setNewImageUrl(e.target.value)}
                placeholder="https://..."
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">挿入位置</label>
              <select
                value={newPosition}
                onChange={e => setNewPosition(e.target.value as 'first' | 'last' | 'none')}
                className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
              >
                <option value="last">末尾</option>
                <option value="first">先頭</option>
                <option value="none">なし</option>
              </select>
            </div>
          </div>
          {newImageUrl && (
            <div className="mb-3 p-2 bg-background rounded-lg">
              <p className="text-xs text-text-secondary mb-1">プレビュー</p>
              <img
                src={newImageUrl}
                alt="Preview"
                className="max-h-32 object-contain rounded"
                onError={e => { (e.target as HTMLImageElement).alt = '画像を読み込めません'; }}
              />
            </div>
          )}
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim() || !newImageUrl.trim()}
            className="bg-text-primary text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {creating ? '追加中...' : '追加する'}
          </button>
        </div>
      </section>

      {loading && (
        <div className="text-center py-10 text-text-secondary">読み込み中...</div>
      )}
    </div>
  );
}
