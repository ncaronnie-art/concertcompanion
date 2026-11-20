import { constants } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
    }
  }
}

// Rendering happens outside synced folders. Only a fully copied file is
// renamed to the user-visible MP4 in the chosen destination directory.
export async function commitOutput(rendered: string, destination: string, checkDestination: () => Promise<void>): Promise<void> {
  const staged = path.join(path.dirname(destination), `.compass-${randomUUID()}.partial`);
  let committed = false;
  try {
    await copyFile(rendered, staged, constants.COPYFILE_EXCL);
    await checkDestination();
    await renameWithRetry(staged, destination);
    committed = true;
  } finally {
    if (!committed) await rm(staged, { force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
  }
}
