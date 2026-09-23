'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/db', label: 'カードDB' },
  { href: '/db/price-history', label: '掲載履歴' },
];

export function DbTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-2 mb-6" aria-label="DBメニュー">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
              active
                ? 'bg-text-primary text-white border-text-primary'
                : 'border-border-card text-text-primary hover:bg-warm-100'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
