import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs' } }],
  },
  moduleNameMapper: {
    // @haraka/shared パッケージを TypeScript ソースに解決
    '^@haraka/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    // shared 内の .js 拡張子付き相対 import を .ts ファイルに解決
    '^(\\.{1,2}/.+)\\.js$': '$1',
  },
};

export default config;
