import {
  TagCombinationError,
  appendTagComponent,
  joinTagComponents,
  moveTagComponent,
  normalizeTagCombinations,
  splitTagCombination,
  tagComponentsFromCombinations,
} from '../utils/tag-combination.js';

test('splits an ordered combination and removes duplicates', () => {
  expect(splitTagCombination('Pikachu / Promo / Pokemon Center / Promo')).toEqual([
    'Pikachu',
    'Promo',
    'Pokemon Center',
  ]);
});

test('derives reusable single tags from existing combinations', () => {
  expect(tagComponentsFromCombinations([
    'Pikachu/Promo/Pokemon Center',
    'Charizard/Promo',
  ])).toEqual(['Charizard', 'Pikachu', 'Pokemon Center', 'Promo']);
});

test('keeps existing combinations available for one-click application', () => {
  expect(normalizeTagCombinations([
    'Pikachu / Promo / Pokemon Center',
    'Pikachu/Promo/Pokemon Center',
  ])).toEqual(['Pikachu/Promo/Pokemon Center']);
});

test('appends a new tag and preserves the first tag as primary', () => {
  const next = appendTagComponent(['Pikachu', 'Promo'], 'Pokemon Center');
  expect(next).toEqual(['Pikachu', 'Promo', 'Pokemon Center']);
  expect(joinTagComponents(next)).toBe('Pikachu/Promo/Pokemon Center');
});

test('reorders tag components without duplicating the product', () => {
  expect(moveTagComponent(['Pikachu', 'Promo', 'Pokemon Center'], 2, -1)).toEqual([
    'Pikachu',
    'Pokemon Center',
    'Promo',
  ]);
});

test('rejects slash inside a single tag name', () => {
  expect(() => appendTagComponent([], 'Promo/New')).toThrow(TagCombinationError);
  try {
    appendTagComponent([], 'Promo/New');
  } catch (error) {
    expect(error).toBeInstanceOf(TagCombinationError);
    expect((error as TagCombinationError).code).toBe('separator');
  }
});
