'use client';

import { useState, type FormEvent } from 'react';
import type { OrderListNewCardSelection } from './order-list-match-review-state';
import {
  NEW_CARD_ALLOWED_IMAGE_HOSTS,
  newCardAltImageUrlOrNull,
} from './order-list-new-card-validation';

type NewCardDefaults = Omit<OrderListNewCardSelection, 'item_id'>;

type Props = {
  itemId: string;
  franchiseLabel: string;
  initialValue: NewCardDefaults;
  tagOptions: string[];
  imageAvailable: boolean;
  appliesFromNextImport: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onStage: (selection: OrderListNewCardSelection) => void;
};

function previewUrl(value: string): string | null {
  try {
    return newCardAltImageUrlOrNull(value);
  } catch {
    return null;
  }
}

function AlternativeImagePreview({ url, cardName }: { url: string; cardName: string }) {
  const [failure, setFailure] = useState<{ url: string; failed: boolean }>({ url, failed: false });
  const failed = failure.url === url && failure.failed;

  if (failed) {
    return (
      <span className="flex h-28 w-20 shrink-0 items-center justify-center rounded border border-border-card bg-white px-1 text-center text-[10px] text-text-secondary">
        代替画像を表示できません
      </span>
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" title="代替画像を拡大表示" className="block h-28 w-20 shrink-0 overflow-hidden rounded border border-border-card bg-white">
      <img
        key={url}
        src={url}
        alt={`${cardName || '新規商品'}の代替画像`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailure({ url, failed: true })}
        className="h-full w-full object-contain"
      />
    </a>
  );
}

export function OrderListNewCardForm({
  itemId,
  franchiseLabel,
  initialValue,
  tagOptions,
  imageAvailable,
  appliesFromNextImport,
  disabled = false,
  onCancel,
  onStage,
}: Props) {
  const [cardName, setCardName] = useState(initialValue.card_name);
  const [grade, setGrade] = useState(initialValue.grade);
  const [listNo, setListNo] = useState(initialValue.list_no);
  const [tag, setTag] = useState(initialValue.tag);
  const [altImageUrl, setAltImageUrl] = useState(initialValue.alt_image_url ?? '');
  const [error, setError] = useState<string | null>(null);
  const tagListId = `new-card-tags-${itemId}`;
  const altImageDescriptionId = `new-card-alt-image-description-${itemId}`;
  const requiresAltImage = !imageAvailable;
  const alternativePreviewUrl = requiresAltImage ? previewUrl(altImageUrl) : null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    try {
      const normalizedAltImageUrl = newCardAltImageUrlOrNull(altImageUrl);
      if (requiresAltImage && !normalizedAltImageUrl) {
        throw new Error('Excel画像を表示できないため、代替画像URLを入力してください。');
      }
      onStage({
        item_id: itemId,
        card_name: cardName.trim(),
        grade: grade.trim(),
        list_no: listNo.trim(),
        tag: tag.trim(),
        alt_image_url: normalizedAltImageUrl,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '入力内容を確認してください。');
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border-2 border-blue-300 bg-blue-50/70 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold text-blue-950">新規DB商品として仮登録</p>
          <p className="mt-1 text-xs text-blue-800">{franchiseLabel}の商品として登録します。Excelの商品情報を初期入力しています。</p>
        </div>
        <span className="mt-2 w-fit rounded-full border border-blue-300 bg-white px-2.5 py-1 text-xs font-bold text-blue-800 sm:mt-0">まだDB未保存</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-text-primary sm:col-span-2">商品名 <span className="text-[#a33b1f]">必須</span>
          <input value={cardName} onChange={(event) => setCardName(event.target.value)} required maxLength={300} disabled={disabled} className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50" />
        </label>
        <label className="text-xs font-semibold text-text-primary">グレード・種別
          <input value={grade} onChange={(event) => setGrade(event.target.value)} maxLength={100} disabled={disabled} className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50" />
        </label>
        <label className="text-xs font-semibold text-text-primary">リスト番号
          <input value={listNo} onChange={(event) => setListNo(event.target.value)} maxLength={100} disabled={disabled} className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50" />
        </label>
        <label className="text-xs font-semibold text-text-primary sm:col-span-2">タグ（表示グループ） <span className="text-[#a33b1f]">必須</span>
          <input value={tag} onChange={(event) => setTag(event.target.value)} list={tagListId} required maxLength={200} placeholder="既存タグを選ぶか入力" disabled={disabled} className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50" />
          <datalist id={tagListId}>{tagOptions.map((option) => <option key={option} value={option} />)}</datalist>
          <span className="mt-1 block font-normal text-text-secondary">空欄の商品は画像生成対象にならないため必須です。</span>
        </label>
        <label className="text-xs font-semibold text-text-primary sm:col-span-2">代替画像URL {requiresAltImage && <span className="text-[#a33b1f]">必須</span>}
          <input
            type="url"
            value={altImageUrl}
            onChange={(event) => { setAltImageUrl(event.target.value); setError(null); }}
            required={requiresAltImage}
            aria-describedby={altImageDescriptionId}
            aria-invalid={Boolean(error) || undefined}
            maxLength={2048}
            placeholder="https://..."
            disabled={disabled}
            className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50"
          />
          <span id={altImageDescriptionId} className="mt-1 block font-normal text-text-secondary">
            {imageAvailable
              ? 'Excel画像を通常画像として使います。代替画像は必要な場合だけ入力してください。'
              : 'Excel画像を表示できないため必須です。入力した画像を代わりに使います。'}
            {' '}許可ホスト: {NEW_CARD_ALLOWED_IMAGE_HOSTS.join(' / ')}
          </span>
        </label>
      </div>
      {alternativePreviewUrl && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-blue-200 bg-white p-3">
          <AlternativeImagePreview url={alternativePreviewUrl} cardName={cardName.trim()} />
          <div className="min-w-0 text-xs text-blue-900">
            <p className="font-bold">代替画像プレビュー</p>
            <p className="mt-1 break-all text-blue-800">{alternativePreviewUrl}</p>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg border border-[#e3b0a2] bg-[#fff0ec] px-3 py-2 text-xs text-[#8d3a22]">{error}</p>}
      {appliesFromNextImport && <p className="mt-3 text-xs font-medium text-blue-800">反映済み取込のため、次回のExcel取込から有効です。</p>}
      <p className="mt-3 text-xs text-text-secondary">ここでは仮登録だけ行い、DB商品作成と対応表保存は最後のボタンでまとめて実行します。</p>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} disabled={disabled} className="rounded-full border border-border-card bg-card-bg px-4 py-2 text-xs font-semibold text-text-secondary disabled:opacity-40">キャンセル</button>
        <button type="submit" disabled={disabled} className="rounded-full bg-blue-900 px-5 py-2 text-xs font-bold text-white disabled:opacity-40">この内容で仮登録</button>
      </div>
    </form>
  );
}
