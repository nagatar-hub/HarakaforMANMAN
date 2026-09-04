'use client';

import Image, { type ImageLoaderProps } from 'next/image';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CustomBuybackItemRow, CustomBuybackProductType } from '@haraka/shared';

export const passthroughImageLoader = ({ src }: ImageLoaderProps) => src;

type Props = {
  item: CustomBuybackItemRow;
  productType: CustomBuybackProductType;
  selected: boolean;
  compact?: boolean;
  disabled?: boolean;
  onToggle: (id: string) => void;
  onValueChange: (id: string, field: 'final_price_high' | 'demand', value: number | null) => void;
  onSave: (item: CustomBuybackItemRow) => void;
  onResetPrice: (id: string) => void;
  onDelete?: (id: string) => void;
};

export function SortableBuybackCard({
  item, productType, selected, compact = false, disabled = false, onToggle, onValueChange, onSave, onResetPrice, onDelete,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  const imageUrl = item.image_url || item.alt_image_url;
  const overridden = item.override_reason != null
    || item.final_price_high !== item.source_price_high;

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative rounded-xl border bg-white p-2 shadow-sm transition-shadow ${selected ? 'border-accent ring-2 ring-accent/20' : 'border-border-card'} ${isDragging ? 'z-30 shadow-xl opacity-80' : ''} ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-2">
        <label className="mt-0.5 flex cursor-pointer items-center" aria-label={`${item.card_name}を選択`}>
          <input type="checkbox" disabled={disabled} checked={selected} onChange={() => onToggle(item.id)} className="size-4 accent-[#8f4d2e]" />
        </label>
        <div className={`${compact ? 'h-20 w-14' : 'h-24 w-16'} relative shrink-0 overflow-hidden rounded-lg bg-warm-100`}>
          {imageUrl ? (
            <Image loader={passthroughImageLoader} unoptimized fill sizes="64px" src={imageUrl} alt={item.card_name} className="object-contain" />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-[10px] text-text-secondary">NO IMG</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <div className="min-w-0">
              <p className="line-clamp-2 text-xs font-bold leading-snug text-text-primary">{item.card_name}</p>
              <p className="mt-0.5 truncate text-[10px] text-text-secondary">{[item.grade, item.list_no, item.rarity].filter(Boolean).join(' · ')}</p>
              <p className="mt-0.5 truncate text-[9px] text-text-secondary">最高価格: ¥{item.source_price_high?.toLocaleString() ?? '-'} · {item.source_shop_name ?? '店舗不明'} · {item.grade ?? item.tag ?? '状態不明'}</p>
            </div>
            <button
              type="button"
              className="touch-none rounded-md p-1 text-text-secondary hover:bg-warm-100 hover:text-text-primary"
              aria-label={`${item.card_name}をドラッグして並べ替え`}
              disabled={disabled}
              {...attributes}
              {...listeners}
            >
              <span aria-hidden className="text-base leading-none">⠿</span>
            </button>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-1">
            <PriceInput
              label="表示価格"
              value={item.final_price_high}
              source={item.source_price_high}
              onChange={(value) => onValueChange(item.id, 'final_price_high', value)}
              onBlur={() => onSave(item)}
              disabled={disabled}
            />
            <NumberInput
              label={`募集数（${productType === 'psa' ? '枚' : '個'}）`}
              value={item.demand}
              onChange={(value) => onValueChange(item.id, 'demand', value)}
              onBlur={() => onSave(item)}
              disabled={disabled}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-1">
            <span className={`text-[9px] ${overridden ? 'font-bold text-accent' : 'text-text-secondary'}`}>
              {overridden ? '手修正あり' : '当日DB価格'}
            </span>
            <div className="flex gap-1">
              {overridden && (
                <button type="button" disabled={disabled} onClick={() => onResetPrice(item.id)} className="text-[9px] font-semibold text-accent hover:underline">元に戻す</button>
              )}
              {onDelete && (
                <button type="button" disabled={disabled} onClick={() => onDelete(item.id)} className="text-[9px] text-text-secondary hover:text-red-700">削除</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function NumberInput({ label, value, onChange, onBlur, disabled = false }: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  onBlur: () => void;
  disabled?: boolean;
}) {
  return <label className="block"><span className="block text-[9px] text-text-secondary">{label}</span><input type="number" min={1} max={999} disabled={disabled} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} onBlur={onBlur} className="w-full rounded-md border border-border-card bg-warm-50 px-1.5 py-1 text-right text-[11px] font-bold outline-none focus:border-accent" /></label>;
}

function PriceInput({ label, value, source, onChange, onBlur, disabled = false }: {
  label: string;
  value: number | null;
  source: number | null;
  onChange: (value: number | null) => void;
  onBlur: () => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[9px] text-text-secondary">{label} <span className="opacity-60">(元 {source?.toLocaleString() ?? '-'})</span></span>
      <span className="flex items-center rounded-md border border-border-card bg-warm-50 px-1.5 focus-within:border-accent">
        <span className="text-[10px] text-text-secondary">¥</span>
        <input
          type="number"
          min={1}
          max={100000000}
          disabled={disabled}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          onBlur={onBlur}
          className="min-w-0 flex-1 bg-transparent py-1 text-right text-[11px] font-bold outline-none"
        />
      </span>
    </label>
  );
}
