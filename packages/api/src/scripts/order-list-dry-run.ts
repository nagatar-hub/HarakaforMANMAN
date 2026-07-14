import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseOrderListWorkbook } from '../lib/order-list-parser.js';

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npm -w packages/api run dry-run:order-list -- <file.xlsx>');
    process.exitCode = 2;
    return;
  }

  const resolvedPath = resolve(inputPath);
  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) throw new Error('指定されたパスはファイルではありません。');

    const result = await parseOrderListWorkbook(await readFile(resolvedPath));
    const issueLimit = 100;
    console.log(JSON.stringify({
      file: {
        path: resolvedPath,
        sizeBytes: fileStat.size,
      },
      valid: result.valid,
      structuralValid: result.structuralValid,
      summary: result.summary,
      issues: result.issues.slice(0, issueLimit),
      omittedIssueCount: Math.max(0, result.issues.length - issueLimit),
    }, null, 2));

    if (!result.structuralValid) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
