import { GalleryTabs } from '../gallery-tabs';
import { CustomGalleryClient } from './custom-gallery-client';

export default function CustomGalleryPage() {
  return <div>
    <header className="mb-8 sm:mb-12"><h1 className="page-title text-2xl text-text-primary sm:text-4xl">ギャラリー</h1><p className="mt-2 text-sm text-text-secondary">作成したカスタム買取表を、表に表示する日付ごとに確認・保存できます。</p><div className="mt-5"><GalleryTabs active="custom" /></div></header>
    <CustomGalleryClient />
  </div>;
}
