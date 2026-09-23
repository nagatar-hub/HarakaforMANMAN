import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { STORE_NAME } from '@/lib/store';
import { PriceHistoryClient } from './price-history-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '掲載履歴 | Haraka',
  description: '商品名・型番から買取表への掲載日と価格を検索します',
};

export default function PriceHistoryPage() {
  if (STORE_NAME !== 'manman-akihabara') notFound();
  return <PriceHistoryClient />;
}
