'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';

type Asset = {
  id: string;
  slot_index: number;
  image_url: string;
  asset_type: string;
  media_id: string | null;
};

type PostItem = {
  id: string;
  position: number;
  tweet_text: string | null;
  is_header: boolean;
  tweet_id: string | null;
  status: string;
  error_message: string | null;
  assets: Asset[];
};

type PostPlan = {
  id: string;
  franchise: string;
  status: string;
  header_text: string | null;
  thread_head_tweet_id: string | null;
  items: PostItem[];
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-gray-800', text: 'text-gray-400', label: '待機' },
  posting: { bg: 'bg-yellow-900/30', text: 'text-yellow-400', label: '投稿中' },
  posted: { bg: 'bg-green-900/30', text: 'text-green-400', label: '完了' },
  failed: { bg: 'bg-red-900/30', text: 'text-red-400', label: '失敗' },
  unknown: { bg: 'bg-orange-900/30', text: 'text-orange-400', label: '不明' },
};

const PLAN_STATUS_STYLES: Record<string, { label: string; color: string }> = {
  draft: { label: '下書き', color: 'text-gray-400' },
  posting: { label: '投稿中...', color: 'text-yellow-400' },
  completed: { label: '完了', color: 'text-green-400' },
  partial: { label: '一部失敗', color: 'text-orange-400' },
  failed: { label: '失敗', color: 'text-red-400' },
};

export default function PlanDetailPage() {
  const params = useParams();
  const router = useRouter();
  const planId = params.planId as string;

  const [plan, setPlan] = useState<PostPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const fetchPlan = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/post/plan/${planId}`);
      const data = await res.json();
      setPlan(data);
    } catch (e) {
      console.error('Failed to fetch plan:', e);
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);

  // Polling during posting
  useEffect(() => {
    if (plan?.status !== 'posting') return;
    const interval = setInterval(fetchPlan, 3000);
    return () => clearInterval(interval);
  }, [plan?.status, fetchPlan]);

  const handleExecute = async () => {
    if (!confirm('Xに投稿を開始しますか？')) return;
    setExecuting(true);
    try {
      const res = await fetch(`${API_URL}/api/post/plan/${planId}/execute`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || '投稿に失敗しました');
        return;
      }
      await fetchPlan();
    } finally {
      setExecuting(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`${API_URL}/api/post/plan/${planId}/retry`, { method: 'POST' });
      if (res.ok) await fetchPlan();
    } finally {
      setRetrying(false);
    }
  };

  const handleSaveItemText = async (itemId: string) => {
    await fetch(`${API_URL}/api/post/item/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweet_text: editText }),
    });
    setEditingItem(null);
    await fetchPlan();
  };

  const handleResolveUnknown = async (itemId: string, status: 'posted' | 'failed') => {
    await fetch(`${API_URL}/api/post/item/${itemId}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await fetchPlan();
  };

  if (loading) return <div className="text-center py-10 text-text-secondary">読み込み中...</div>;
  if (!plan) return <div className="text-center py-10 text-text-secondary">プランが見つかりません</div>;

  const planStyle = PLAN_STATUS_STYLES[plan.status] || PLAN_STATUS_STYLES.draft;
  const hasFailedItems = plan.items.some(i => i.status === 'failed');
  const hasUnknownItems = plan.items.some(i => i.status === 'unknown');

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => router.back()} className="text-text-secondary hover:text-text-primary">
          ← 戻る
        </button>
        <h1 className="text-2xl font-bold">{plan.franchise} 投稿プラン</h1>
        <span className={`text-sm font-medium ${planStyle.color}`}>{planStyle.label}</span>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 mb-6">
        {plan.status === 'draft' && (
          <button
            onClick={handleExecute}
            disabled={executing}
            className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {executing ? '投稿開始中...' : '投稿する'}
          </button>
        )}
        {(plan.status === 'partial' || hasFailedItems) && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="bg-orange-600 hover:bg-orange-500 text-white px-6 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {retrying ? 'リトライ中...' : '失敗をリトライ'}
          </button>
        )}
        {plan.thread_head_tweet_id && (
          <a
            href={`https://x.com/i/status/${plan.thread_head_tweet_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-card-bg border border-border-card hover:border-text-primary/50 px-4 py-2.5 rounded-lg text-sm transition-colors"
          >
            Xで確認 →
          </a>
        )}
      </div>

      {/* Thread preview */}
      <div className="space-y-3">
        {plan.items.map((item, idx) => {
          const statusStyle = STATUS_STYLES[item.status] || STATUS_STYLES.pending;
          const isEditing = editingItem === item.id;

          return (
            <div key={item.id} className="bg-card-bg border border-border-card rounded-xl p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">#{item.position}</span>
                  {item.is_header && (
                    <span className="text-xs bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded">ヘッダー</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded ${statusStyle.bg} ${statusStyle.text}`}>
                    {statusStyle.label}
                  </span>
                </div>
                <div className="flex gap-2">
                  {plan.status === 'draft' && !isEditing && (
                    <button
                      onClick={() => { setEditingItem(item.id); setEditText(item.tweet_text || ''); }}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      編集
                    </button>
                  )}
                  {item.status === 'unknown' && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleResolveUnknown(item.id, 'posted')}
                        className="text-xs bg-green-900/30 text-green-400 px-2 py-0.5 rounded hover:bg-green-900/50"
                      >
                        投稿済み
                      </button>
                      <button
                        onClick={() => handleResolveUnknown(item.id, 'failed')}
                        className="text-xs bg-red-900/30 text-red-400 px-2 py-0.5 rounded hover:bg-red-900/50"
                      >
                        失敗
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Tweet text */}
              {isEditing ? (
                <div className="mb-2">
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    rows={4}
                    className="w-full bg-background border border-border-card rounded-lg px-3 py-2 text-sm"
                  />
                  <div className="flex gap-2 mt-1">
                    <button
                      onClick={() => handleSaveItemText(item.id)}
                      className="text-xs bg-text-primary text-white px-3 py-1 rounded"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingItem(null)}
                      className="text-xs text-text-secondary"
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : item.tweet_text ? (
                <pre className="text-sm whitespace-pre-wrap font-sans text-text-secondary mb-2 line-clamp-6">
                  {item.tweet_text}
                </pre>
              ) : null}

              {/* Assets (images) */}
              {item.assets.length > 0 && (
                <div className="flex gap-2 mt-2">
                  {item.assets.map(asset => (
                    <div key={asset.id} className="w-20 h-20 bg-background rounded-lg overflow-hidden flex-shrink-0">
                      <img
                        src={asset.image_url}
                        alt={`slot ${asset.slot_index}`}
                        className="w-full h-full object-cover"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Error message */}
              {item.error_message && (
                <p className="text-xs text-red-400 mt-2 bg-red-900/10 px-2 py-1 rounded">
                  {item.error_message}
                </p>
              )}

              {/* Tweet link */}
              {item.tweet_id && (
                <a
                  href={`https://x.com/i/status/${item.tweet_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-block"
                >
                  ツイートを見る →
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
