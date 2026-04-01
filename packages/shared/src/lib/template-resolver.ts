/**
 * テンプレート内の {{key}} を variables の値で置換する
 */
export function resolveTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}

/**
 * テンプレートから使用されている変数キー一覧を抽出
 */
export function extractVariableKeys(template: string): string[] {
  const matches = template.matchAll(/\{\{(\w+)\}\}/g);
  return [...new Set(Array.from(matches, m => m[1]))];
}
