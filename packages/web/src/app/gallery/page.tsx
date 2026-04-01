import Link from 'next/link';

export const dynamic = 'force-dynamic';

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

type DateEntry = {
  date: string;
  franchises: Record<string, number>;
};

export default async function GalleryPage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
  let dates: DateEntry[] = [];

  try {
    const res = await fetch(`${apiUrl}/api/gallery/dates`, { cache: 'no-store' });
    if (res.ok) dates = await res.json();
  } catch {
    // API unreachable
  }

  return (
    <div>
      <div className="mb-14">
        <h1 className="page-title text-2xl sm:text-4xl text-text-primary">ギャラリー</h1>
      </div>

      {dates.length === 0 ? (
        <p className="text-text-secondary">生成画像がありません</p>
      ) : (
        <div className="grid gap-6">
          {dates.map((entry) => {
            const total = Object.values(entry.franchises).reduce((a, b) => a + b, 0);
            return (
              <Link
                key={entry.date}
                href={`/gallery/${entry.date}`}
                className="bg-card-bg border border-border-card rounded-2xl p-5 sm:p-8 hover:scale-[1.02] transition-transform duration-300 flex items-center justify-between"
              >
                <div>
                  <p className="text-xl font-bold text-text-primary">{entry.date}</p>
                  <div className="flex gap-4 mt-2">
                    {Object.entries(entry.franchises).map(([franchise, count]) => (
                      <span key={franchise} className="text-base text-text-secondary">
                        {FRANCHISE_JA[franchise] || franchise}: {count}枚
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-black text-text-primary">{total}</p>
                  <p className="text-sm text-text-secondary tracking-wider">ページ</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
