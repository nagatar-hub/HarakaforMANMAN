'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

type Credential = {
  id: string;
  account_name: string;
  x_user_id: string | null;
  x_username: string | null;
  status: 'active' | 'expired' | 'revoked';
  is_default: boolean;
  last_verified_at: string | null;
  token_expires_at: string | null;
  created_at: string;
};

export default function CredentialsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchCredentials = async () => {
    const res = await fetch(`${API}/api/x/credentials`);
    const data = await res.json();
    setCredentials(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  useEffect(() => {
    // Handle OAuth callback result
    const params = new URLSearchParams(window.location.search);
    if (params.get('success')) {
      const username = params.get('username');
      setMessage({ type: 'success', text: `@${username || '???'} を認証しました` });
      window.history.replaceState({}, '', '/post/credentials');
    }
    if (params.get('error')) {
      setMessage({ type: 'error', text: `認証エラー: ${params.get('error')}` });
      window.history.replaceState({}, '', '/post/credentials');
    }
    fetchCredentials();
  }, []);

  const handleAuth = async () => {
    setAuthLoading(true);
    try {
      const res = await fetch(`${API}/api/x/oauth/authorize`);
      const { url } = await res.json();
      window.location.href = url;
    } catch (e: any) {
      setMessage({ type: 'error', text: `認証開始エラー: ${e.message}` });
      setAuthLoading(false);
    }
  };

  const handleVerify = async (id: string) => {
    setVerifying(id);
    try {
      const res = await fetch(`${API}/api/x/credentials/${id}/verify`, { method: 'POST' });
      const data = await res.json();
      if (data.verified) {
        setMessage({ type: 'success', text: `@${data.user.username} の認証を確認しました` });
      } else {
        setMessage({ type: 'error', text: `認証失敗: ${data.error}` });
      }
      await fetchCredentials();
    } catch (e: any) {
      setMessage({ type: 'error', text: `エラー: ${e.message}` });
    } finally {
      setVerifying(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    setSettingDefault(id);
    try {
      await fetch(`${API}/api/x/credentials/${id}/set-default`, { method: 'POST' });
      await fetchCredentials();
    } finally {
      setSettingDefault(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('この認証情報を削除しますか？')) return;
    await fetch(`${API}/api/x/credentials/${id}`, { method: 'DELETE' });
    await fetchCredentials();
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'active': return <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-600">active</span>;
      case 'expired': return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-600">expired</span>;
      case 'revoked': return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-600">revoked</span>;
      default: return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-600">{status}</span>;
    }
  };

  const tokenStatus = (expiresAt: string | null) => {
    if (!expiresAt) return null;
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff < 0) return <span className="text-xs text-red-500">トークン期限切れ</span>;
    if (diff < 10 * 60 * 1000) return <span className="text-xs text-yellow-500">まもなく期限切れ</span>;
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const mins = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
    return <span className="text-xs text-text-secondary">トークン有効: {hours}h {mins}m</span>;
  };

  const defaultCred = credentials.find(c => c.is_default);

  return (
    <div>
      <Link href="/post" className="text-sm text-text-secondary hover:text-text-primary transition-colors mb-1 inline-block">&larr; X投稿管理</Link>
      <h1 className="text-2xl font-bold mb-2">X認証情報管理</h1>
      <p className="text-text-secondary text-sm mb-4">
        投稿に使用するXアカウントを管理します。
        「Xアカウントを認証」ボタンで、Xにログインして認証するだけでアカウントが追加されます。
      </p>

      {/* Message */}
      {message && (
        <div className={`rounded-xl px-4 py-3 mb-6 text-sm ${
          message.type === 'success'
            ? 'bg-green-500/10 border border-green-500/30 text-green-600'
            : 'bg-red-500/10 border border-red-500/30 text-red-600'
        }`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-2 opacity-60 hover:opacity-100">x</button>
        </div>
      )}

      {/* Current default indicator */}
      {defaultCred && (
        <div className="bg-text-primary/10 border border-text-primary/30 rounded-xl px-4 py-3 mb-6 flex items-center gap-2">
          <span className="text-sm">📌 現在のデフォルト:</span>
          <span className="font-semibold">{defaultCred.account_name}</span>
          {defaultCred.x_username && <span className="text-text-secondary text-sm">(@{defaultCred.x_username})</span>}
          <span className="text-text-secondary text-xs ml-auto">プラン生成時に自動で使用されます</span>
        </div>
      )}

      {/* Auth Button */}
      <div className="mb-8">
        <button
          onClick={handleAuth}
          disabled={authLoading}
          className="px-6 py-3 bg-text-primary text-white rounded-xl text-base font-semibold hover:opacity-80 disabled:opacity-50 transition-opacity"
        >
          {authLoading ? '認証画面に移動中...' : 'Xアカウントを認証'}
        </button>
        <p className="text-xs text-text-secondary mt-2">
          ボタンを押すとXのログイン画面に移動します。認証後、自動的にこの画面に戻ります。
        </p>
      </div>

      {/* Credentials List */}
      {loading ? (
        <p className="text-text-secondary">読み込み中...</p>
      ) : credentials.length === 0 ? (
        <p className="text-text-secondary">認証済みアカウントはまだありません。上のボタンからXアカウントを認証してください。</p>
      ) : (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">認証済みアカウント ({credentials.length})</h2>
          {credentials.map(cred => (
            <div
              key={cred.id}
              className={`bg-card-bg border rounded-xl p-5 ${
                cred.is_default ? 'border-text-primary/50' : 'border-border-card'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-lg">{cred.account_name}</h3>
                    {statusBadge(cred.status)}
                    {cred.is_default && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-text-primary/20 text-text-primary font-semibold">デフォルト</span>
                    )}
                  </div>
                  {cred.x_username && (
                    <p className="text-text-secondary text-sm">@{cred.x_username}</p>
                  )}
                  <div className="mt-2 text-xs text-text-secondary space-y-0.5">
                    {tokenStatus(cred.token_expires_at)}
                    {cred.last_verified_at && (
                      <p>最終確認: {new Date(cred.last_verified_at).toLocaleString('ja-JP')}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {!cred.is_default && (
                    <button
                      onClick={() => handleSetDefault(cred.id)}
                      disabled={settingDefault === cred.id}
                      className="text-sm px-3 py-1.5 rounded-lg border border-border-card hover:border-text-primary/50 transition-colors disabled:opacity-50"
                    >
                      {settingDefault === cred.id ? '設定中...' : 'デフォルトに設定'}
                    </button>
                  )}
                  {cred.status === 'expired' && (
                    <button
                      onClick={handleAuth}
                      className="text-sm px-3 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30"
                    >
                      再認証
                    </button>
                  )}
                  <button
                    onClick={() => handleVerify(cred.id)}
                    disabled={verifying === cred.id}
                    className="text-sm px-3 py-1.5 rounded-lg bg-text-primary text-white hover:opacity-80 disabled:opacity-50"
                  >
                    {verifying === cred.id ? '確認中...' : '疎通確認'}
                  </button>
                  <button
                    onClick={() => handleDelete(cred.id)}
                    className="text-sm px-3 py-1.5 rounded-lg text-red-400 hover:bg-red-500/10"
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
