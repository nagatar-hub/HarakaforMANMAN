import type { Metadata } from 'next';
import { BottomNav } from '@/components/bottom-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Haraka',
  description: '買取表自動生成システム',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@500;700;900&display=swap" rel="stylesheet" />
      </head>
      <body className="text-text-primary min-h-screen pb-28">
        <main className="mx-auto max-w-6xl px-3 sm:px-6 pt-6 sm:pt-10 md:px-10">{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
