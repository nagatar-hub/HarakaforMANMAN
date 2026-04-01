'use client';

const BASE_TABS = [
  { key: 'all', label: 'すべて' },
  { key: 'Pokemon', label: 'ポケモン' },
  { key: 'ONE PIECE', label: 'ワンピース' },
  { key: 'YU-GI-OH!', label: '遊戯王' },
] as const;

type TabItem = { key: string; label: string; badge?: number };

type Props = {
  active: string;
  onChange: (key: string) => void;
  /** 基本タブの後に追加するタブ */
  extraTabs?: TabItem[];
};

export function FranchiseTabs({ active, onChange, extraTabs }: Props) {
  const tabs: TabItem[] = [...BASE_TABS, ...(extraTabs ?? [])];

  return (
    <div className="flex gap-0.5 sm:gap-1 bg-card-bg border border-border-card p-1 sm:p-1.5 rounded-full flex-wrap">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`px-3 sm:px-5 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm whitespace-nowrap transition-all duration-200 flex items-center gap-1 sm:gap-1.5 ${
            active === tab.key
              ? 'bg-text-primary text-white font-medium shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {tab.label}
          {tab.badge != null && tab.badge > 0 && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
              active === tab.key
                ? 'bg-white/20 text-white'
                : 'bg-red-100 text-red-600'
            }`}>
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
