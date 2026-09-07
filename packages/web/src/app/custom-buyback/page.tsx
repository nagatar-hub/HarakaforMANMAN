import type { Metadata } from 'next';
import { CustomBuybackClient } from './custom-buyback-client';
import { STORE_NAME } from '@/lib/store';

export const metadata: Metadata = {
  title: 'カスタム買取表 | Haraka',
  description: '当日価格を使ってPSA・BOXの買取表を自由に作成します',
};

export default async function CustomBuybackPage({
  searchParams,
}: {
  searchParams: Promise<{ sheet?: string }>;
}) {
  const { sheet } = await searchParams;
  return <CustomBuybackClient initialSheetId={sheet} enableTokyoFranchises={STORE_NAME === 'manman-akihabara'} />;
}
