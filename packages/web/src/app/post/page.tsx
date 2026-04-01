'use client';

import Link from 'next/link';

const MENU_ITEMS = [
  {
    href: '/post/variables',
    title: 'テンプレート変数',
    description: 'システム変数・カスタム変数の管理',
    icon: '📝',
  },
  {
    href: '/post/templates',
    title: '投稿テンプレート',
    description: 'ツイートテンプレートの作成・編集',
    icon: '📋',
  },
  {
    href: '/post/banners',
    title: 'バナー画像',
    description: 'バナー画像の管理・アップロード',
    icon: '🖼️',
  },
  {
    href: '/post/credentials',
    title: 'X認証情報',
    description: '投稿に使うXアカウントの管理',
    icon: '🔑',
  },
];

export default function PostPage() {
  return (
    <div>
      <h1 className="page-title text-2xl text-text-primary mb-2">X投稿管理</h1>
      <p className="text-text-secondary text-sm mb-8">
        買取表画像をXにスレッド形式で投稿します。
      </p>

      {/* Settings Menu */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-4 text-text-secondary">設定</h2>
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {MENU_ITEMS.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="bg-card-bg border border-border-card rounded-xl p-5 hover:border-text-primary/50 transition-colors"
            >
              <div className="text-2xl mb-2">{item.icon}</div>
              <h3 className="font-semibold mb-1">{item.title}</h3>
              <p className="text-text-secondary text-sm">{item.description}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Post Plans - placeholder for F11 */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-text-secondary">投稿プラン</h2>
        <div className="bg-card-bg border border-border-card rounded-xl p-8 text-center">
          <p className="text-text-secondary text-sm">
            実行（Run）完了後にプランを生成できます。
          </p>
          <p className="text-text-secondary text-xs mt-2">
            Runs ページから実行を選択して「投稿プラン生成」をクリックしてください。
          </p>
        </div>
      </section>
    </div>
  );
}
