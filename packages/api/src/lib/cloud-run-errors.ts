const DEFINITIVE_CLOUD_RUN_REJECTION_CODES = new Set([
  3,  // INVALID_ARGUMENT
  5,  // NOT_FOUND
  7,  // PERMISSION_DENIED
  9,  // FAILED_PRECONDITION
  12, // UNIMPLEMENTED
  16, // UNAUTHENTICATED
]);

export function isDefinitiveCloudRunJobRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && DEFINITIVE_CLOUD_RUN_REJECTION_CODES.has(code);
}
