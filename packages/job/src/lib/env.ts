import { getSecret } from './secret-manager.js';

const SECRET_BY_ENV: Record<string, string> = {
  KECAK_SPREADSHEET_ID: 'haraka-kecak-spreadsheet-id',
  HARAKA_DB_SPREADSHEET_ID: 'haraka-db-spreadsheet-id',
  POKEMON_BOX_SPREADSHEET_ID: 'haraka-pokemon-box-spreadsheet-id',
};

export async function getRequiredEnvOrSecret(envName: keyof typeof SECRET_BY_ENV): Promise<string> {
  const envValue = process.env[envName]?.trim();
  if (envValue) return envValue;

  const secretName = SECRET_BY_ENV[envName];
  const secretValue = (await getSecret(secretName)).trim();
  if (!secretValue) {
    throw new Error(`${envName} が未設定です`);
  }
  return secretValue;
}

export async function getOptionalEnvOrSecret(envName: keyof typeof SECRET_BY_ENV): Promise<string | null> {
  const envValue = process.env[envName]?.trim();
  if (envValue) return envValue;

  const secretName = SECRET_BY_ENV[envName];
  try {
    const secretValue = (await getSecret(secretName)).trim();
    return secretValue || null;
  } catch {
    return null;
  }
}
