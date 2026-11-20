import { rm } from "node:fs/promises";

// The export result and the separate cleanup result must never replace each other.
export async function withTemporaryCleanup<T>(directory: string, operation: () => Promise<T>, remove: (directory: string) => Promise<void> = async (target) => { await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }): Promise<{ value: T; cleanupWarning: boolean }> {
  let result: T | undefined;
  let failed = false;
  let originalError: unknown;
  try { result = await operation(); } catch (error) { failed = true; originalError = error; }
  let cleanupWarning = false;
  try { await remove(directory); } catch { cleanupWarning = true; }
  if (failed) throw originalError;
  return { value: result as T, cleanupWarning };
}
