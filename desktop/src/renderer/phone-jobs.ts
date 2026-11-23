export type PhoneJob<T> = {
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  result?: T;
  error?: string;
};

export class PhoneJobTimeout extends Error {}

/** Wait for the existing engine's result without keeping one long HTTP request open. */
export async function waitForPhoneJob<T>(
  jobId: string,
  read: (id: string, signal: AbortSignal) => Promise<PhoneJob<T>>,
  progress: (value: number) => void,
  { intervalMs = 1000, timeoutMs = 20 * 60 * 1000 } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (true) {
      const job = await read(jobId, controller.signal);
      if (job.jobId !== jobId) throw new Error("The processing response did not match your edit. Please try again.");
      if (Number.isFinite(job.progress)) progress(Math.max(0, Math.min(1, job.progress)));
      if (job.status === "completed") {
        if (!("result" in job)) throw new Error("The finished edit could not be retrieved. Please try again.");
        return job.result as T;
      }
      if (job.status === "cancelled") throw new Error("Processing stopped. Your original recordings and editing choices are safe.");
      if (job.status === "failed") throw new Error(job.error || "This step could not finish. Your edit is still here; please try again.");
      if (job.status !== "running") throw new Error("The processing response was incomplete. Please try again.");
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(pause); reject(new DOMException("Aborted", "AbortError")); };
        const pause = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, intervalMs);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      });
    }
  } catch (error) {
    if (controller.signal.aborted) throw new PhoneJobTimeout("This step took longer than expected. Your editing choices are still here.");
    throw error;
  } finally { clearTimeout(timer); }
}
