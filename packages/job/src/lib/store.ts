/** Store scope for every shared-Supabase query made by this worker. */
export const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';

/** Storage namespace isolated from other stores sharing the same bucket. */
export const GENERATED_STORAGE_PREFIX = `stores/${STORE_NAME}/generated`;
export const CUSTOM_BUYBACK_STORAGE_PREFIX = `stores/${STORE_NAME}/custom-buyback`;
