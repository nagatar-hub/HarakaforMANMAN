'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  TagCombinationError,
  appendTagComponent,
  joinTagComponents,
  moveTagComponent,
  normalizeTagCombinations,
  splitTagCombination,
  tagComponentsFromCombinations,
} from '@haraka/shared';
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
function tagSelectionErrorMessage(error: unknown): string {
  if (!(error instanceof TagCombinationError)) {
    return '\u30bf\u30b0\u306e\u5165\u529b\u5185\u5bb9\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002';
  }
  switch (error.code) {
    case 'empty':
      return '\u30bf\u30b0\u30921\u3064\u4ee5\u4e0a\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002';
    case 'separator':
      return '\u5358\u4f53\u30bf\u30b0\u540d\u306b\u300c/\u300d\u306f\u4f7f\u3048\u307e\u305b\u3093\u3002';
    case 'too_many':
      return '\u30bf\u30b0\u306f20\u500b\u307e\u3067\u6307\u5b9a\u3067\u304d\u307e\u3059\u3002';
    case 'too_long':
      return '\u30bf\u30b0\u306e\u7d44\u307f\u5408\u308f\u305b\u306f200\u6587\u5b57\u4ee5\u5185\u306b\u3057\u3066\u304f\u3060\u3055\u3044\u3002';
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
  const [selectedTags, setSelectedTags] = useState(() => splitTagCombination(initialValue.tag));
  const [tagInput, setTagInput] = useState('');
  const [selectedCombination, setSelectedCombination] = useState('');
  const tagComponents = useMemo(() => tagComponentsFromCombinations(tagOptions), [tagOptions]);
  const [altImageUrl, setAltImageUrl] = useState(initialValue.alt_image_url ?? '');
  const [error, setError] = useState<string | null>(null);
  const tagListId = `new-card-tags-${itemId}`;
  const tagCombinationOptions = useMemo(() => normalizeTagCombinations(tagOptions), [tagOptions]);
  const altImageDescriptionId = `new-card-alt-image-description-${itemId}`;
  const requiresAltImage = !imageAvailable;
  const alternativePreviewUrl = requiresAltImage ? previewUrl(altImageUrl) : null;

  function addTag(): void {
    setError(null);
    try {
      setSelectedTags(appendTagComponent(selectedTags, tagInput));
      setTagInput('');
      setSelectedCombination('');
    } catch (tagError) {
      setError(tagSelectionErrorMessage(tagError));
    }
  }

  function applyCombination(): void {
    if (!selectedCombination) return;
    setSelectedTags(splitTagCombination(selectedCombination));
    setTagInput('');
    setError(null);
  }

  function moveTag(index: number, offset: -1 | 1): void {
    setSelectedTags(moveTagComponent(selectedTags, index, offset));
    setSelectedCombination('');
    setError(null);
  }

  function removeTag(index: number): void {
    setSelectedTags(selectedTags.filter((_, currentIndex) => currentIndex !== index));
    setSelectedCombination('');
    setError(null);
  }
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    try {
      const tagsWithPendingInput = tagInput.trim()
        ? appendTagComponent(selectedTags, tagInput)
        : selectedTags;
      const normalizedAltImageUrl = newCardAltImageUrlOrNull(altImageUrl);
      if (requiresAltImage && !normalizedAltImageUrl) {
        throw new Error('Excel画像を表示できないため、代替画像URLを入力してください。');
      }
      onStage({
        item_id: itemId,
        card_name: cardName.trim(),
        grade: grade.trim(),
        list_no: listNo.trim(),
        tag: joinTagComponents(tagsWithPendingInput),
        alt_image_url: normalizedAltImageUrl,
      });
    } catch (submitError) {
      setError(submitError instanceof TagCombinationError
        ? tagSelectionErrorMessage(submitError)
        : submitError instanceof Error ? submitError.message : '入力内容を確認してください。');
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
        <fieldset className="space-y-3 rounded-xl border border-blue-200 bg-white/70 p-3 sm:col-span-2">
          <legend className="px-1 text-xs font-semibold text-text-primary">
            {'\u30bf\u30b0'} <span className="text-[#a33b1f]">{'\u5fc5\u9808'}</span>
          </legend>

          <div>
            <label htmlFor={`tag-combination-${itemId}`} className="text-xs font-semibold text-text-primary">
              {'\u65e2\u5b58\u306e\u30bf\u30b0\u7d44\u307f\u5408\u308f\u305b\u3092\u9069\u7528'}
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <select
                id={`tag-combination-${itemId}`}
                value={selectedCombination}
                onChange={(event) => setSelectedCombination(event.target.value)}
                disabled={disabled || tagCombinationOptions.length === 0}
                className="min-w-0 flex-1 rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">{'\u7d44\u307f\u5408\u308f\u305b\u3092\u9078\u629e'}</option>
                {tagCombinationOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <button type="button" onClick={applyCombination} disabled={disabled || !selectedCombination} className="rounded-full border border-blue-300 bg-blue-50 px-4 py-2 text-xs font-bold text-blue-900 disabled:opacity-40">
                {'\u7d44\u307f\u5408\u308f\u305b\u3092\u9069\u7528'}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor={tagListId} className="text-xs font-semibold text-text-primary">
              {'\u5358\u4f53\u30bf\u30b0\u3092\u8ffd\u52a0'}
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                id={tagListId}
                value={tagInput}
                onChange={(event) => { setTagInput(event.target.value); setError(null); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addTag();
                  }
                }}
                list={`${tagListId}-options`}
                maxLength={200}
                placeholder={'\u65e2\u5b58\u30bf\u30b0\u3092\u9078\u3076\u304b\u3001\u65b0\u3057\u3044\u30bf\u30b0\u540d\u3092\u5165\u529b'}
                disabled={disabled}
                className="min-w-0 flex-1 rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50"
              />
              <datalist id={`${tagListId}-options`}>
                {tagComponents.map((option) => <option key={option} value={option} />)}
              </datalist>
              <button type="button" onClick={addTag} disabled={disabled || !tagInput.trim()} className="rounded-full bg-blue-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">
                {'\u30bf\u30b0\u3092\u8ffd\u52a0'}
              </button>
            </div>
            <p className="mt-1 text-xs font-normal text-text-secondary">
              {'\u5019\u88dc\u306b\u306a\u3044\u540d\u524d\u3082\u65b0\u898f\u30bf\u30b0\u3068\u3057\u3066\u8ffd\u52a0\u3067\u304d\u307e\u3059\u3002\u5546\u54c1\u306e\u53cd\u6620\u5f8c\u306f\u4ed6\u306e\u65b0\u898f\u767b\u9332\u3067\u3082\u9078\u3079\u307e\u3059\u3002'}
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-text-primary">{'\u9078\u629e\u4e2d\u306e\u30bf\u30b0\uff08\u4e0a\u304b\u3089\u9806\uff09'}</p>
            {selectedTags.length === 0 ? (
              <p className="mt-1.5 rounded-lg border border-dashed border-border-card px-3 py-2 text-xs text-text-secondary">
                {'\u30bf\u30b0\u30921\u3064\u4ee5\u4e0a\u8ffd\u52a0\u3057\u3066\u304f\u3060\u3055\u3044\u3002'}
              </p>
            ) : (
              <ol className="mt-1.5 space-y-2">
                {selectedTags.map((tag, index) => (
                  <li key={tag} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-card bg-card-bg px-3 py-2">
                    <span className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{index + 1}. {tag}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${index === 0 ? 'bg-blue-100 text-blue-900' : 'bg-warm-100 text-text-secondary'}`}>
                      {index === 0 ? '\u63b2\u8f09\u30b0\u30eb\u30fc\u30d7' : '\u5c5e\u6027\u30bf\u30b0'}
                    </span>
                    <button type="button" onClick={() => moveTag(index, -1)} disabled={disabled || index === 0} aria-label={tag + '\u3092\u4e0a\u3078\u79fb\u52d5'} className="rounded border border-border-card px-2 py-1 text-xs disabled:opacity-30">{'\u2191'}</button>
                    <button type="button" onClick={() => moveTag(index, 1)} disabled={disabled || index === selectedTags.length - 1} aria-label={tag + '\u3092\u4e0b\u3078\u79fb\u52d5'} className="rounded border border-border-card px-2 py-1 text-xs disabled:opacity-30">{'\u2193'}</button>
                    <button type="button" onClick={() => removeTag(index)} disabled={disabled} aria-label={tag + '\u3092\u524a\u9664'} className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-30">{'\u524a\u9664'}</button>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-1 text-xs font-normal text-text-secondary">
              {'\u5148\u982d\u306e\u30bf\u30b0\u304c\u8cb7\u53d6\u8868\u306e\u63b2\u8f09\u30b0\u30eb\u30fc\u30d7\u306b\u306a\u308a\u30012\u500b\u76ee\u4ee5\u964d\u306f\u5c5e\u6027\u3068\u3057\u3066\u4fdd\u5b58\u3055\u308c\u307e\u3059\u3002'}
            </p>
          </div>
        </fieldset>
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
