import Link from 'next/link';

export function GalleryTabs({ active }: { active: 'standard' | 'custom' }) {
  return <nav aria-label="ギャラリー種別" className="inline-flex rounded-full border border-border-card bg-card-bg p-1">
    <Link href="/gallery" aria-current={active === 'standard' ? 'page' : undefined} className={`rounded-full px-5 py-2 text-sm font-bold transition ${active === 'standard' ? 'bg-text-primary text-white' : 'text-text-secondary hover:bg-white'}`}>通常の買取表</Link>
    <Link href="/gallery/custom" aria-current={active === 'custom' ? 'page' : undefined} className={`rounded-full px-5 py-2 text-sm font-bold transition ${active === 'custom' ? 'bg-text-primary text-white' : 'text-text-secondary hover:bg-white'}`}>カスタム買取表</Link>
  </nav>;
}
