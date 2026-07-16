export const TAG_COMBINATION_SEPARATOR = '/';
export const MAX_TAG_COMPONENTS = 20;
export const MAX_TAG_COMBINATION_LENGTH = 200;

export type TagCombinationErrorCode =
  | 'empty'
  | 'separator'
  | 'too_many'
  | 'too_long';

export class TagCombinationError extends Error {
  constructor(public readonly code: TagCombinationErrorCode) {
    super(code);
    this.name = 'TagCombinationError';
  }
}

export function normalizeTagComponent(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new TagCombinationError('empty');
  if (normalized.includes(TAG_COMBINATION_SEPARATOR)) {
    throw new TagCombinationError('separator');
  }
  return normalized;
}

export function splitTagCombination(value: string | null | undefined): string[] {
  if (!value) return [];
  const components: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(TAG_COMBINATION_SEPARATOR)) {
    const normalized = raw.trim().replace(/\s+/gu, ' ');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    components.push(normalized);
  }
  return components;
}

export function joinTagComponents(values: string[]): string {
  const components: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTagComponent(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    components.push(normalized);
  }
  if (components.length === 0) throw new TagCombinationError('empty');
  if (components.length > MAX_TAG_COMPONENTS) throw new TagCombinationError('too_many');
  const combination = components.join(TAG_COMBINATION_SEPARATOR);
  if (combination.length > MAX_TAG_COMBINATION_LENGTH) {
    throw new TagCombinationError('too_long');
  }
  return combination;
}

export function appendTagComponent(values: string[], value: string): string[] {
  const normalized = normalizeTagComponent(value);
  if (values.includes(normalized)) return values;
  const next = [...values, normalized];
  joinTagComponents(next);
  return next;
}

export function moveTagComponent(values: string[], index: number, offset: -1 | 1): string[] {
  const destination = index + offset;
  if (index < 0 || index >= values.length || destination < 0 || destination >= values.length) {
    return values;
  }
  const next = [...values];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}

export function tagComponentsFromCombinations(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => splitTagCombination(value)))]
    .sort((left, right) => left.localeCompare(right, 'ja'));
}

export function normalizeTagCombinations(values: string[]): string[] {
  const combinations = values.flatMap((value) => {
    const components = splitTagCombination(value);
    if (components.length === 0) return [];
    try {
      return [joinTagComponents(components)];
    } catch {
      return [];
    }
  });
  return [...new Set(combinations)].sort((left, right) => left.localeCompare(right, 'ja'));
}
