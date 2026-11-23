export const DEFAULT_STORAGE_NAMESPACE = "vibe-phone-test-v1";

export type SetupIssue = "VIBE_KEY_MISSING" | "VIBE_KEY_INVALID" | "VIBE_ORIGIN_MISSING" | "VIBE_ORIGIN_INVALID" | "VIBE_STORAGE_NAMESPACE_INVALID";

type RuntimeConfig = { ok: true; token: string; origin: string; storageNamespace: string } | { ok: false; issues: SetupIssue[] };

// Read only runtime settings. Failure results contain codes, never setting values.
export function resolveRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const token = environment.VIBE_ACCESS_KEY?.trim();
  const origin = environment.VIBE_PUBLIC_ORIGIN?.trim();
  const storageNamespace = environment.VIBE_STORAGE_NAMESPACE === undefined ? DEFAULT_STORAGE_NAMESPACE : environment.VIBE_STORAGE_NAMESPACE.trim();
  const issues: SetupIssue[] = [];
  if (!token) issues.push("VIBE_KEY_MISSING");
  else if (!/^[a-f0-9]{64}$/.test(token)) issues.push("VIBE_KEY_INVALID");
  if (!origin) issues.push("VIBE_ORIGIN_MISSING");
  else {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password || parsed.hostname.includes("*")) issues.push("VIBE_ORIGIN_INVALID");
    } catch { issues.push("VIBE_ORIGIN_INVALID"); }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(storageNamespace)) issues.push("VIBE_STORAGE_NAMESPACE_INVALID");
  if (issues.length) return { ok: false, issues };
  return { ok: true, token: token!, origin: origin!, storageNamespace };
}
