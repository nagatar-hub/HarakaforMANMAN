import { STORE_NAME } from '@/lib/store';
import { DbTabs } from './db-tabs';

// 店舗はビルド時ではなく実行時の STORE_NAME で判定する
export const dynamic = 'force-dynamic';

export default function DbLayout({ children }: { children: React.ReactNode }) {
  if (STORE_NAME !== 'manman-akihabara') return children;
  return (
    <>
      <DbTabs />
      {children}
    </>
  );
}
