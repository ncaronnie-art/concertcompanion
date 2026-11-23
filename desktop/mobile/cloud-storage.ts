// Object storage owns durable data; the server uses its local directory only as a cache.
// Implementations must stream file downloads and reject missing objects with false.
export interface CloudStorage {
  readJson(key: string): Promise<unknown | null>;
  writeJson(key: string, value: unknown): Promise<void>;
  downloadFile(key: string, destination: string): Promise<boolean>;
  uploadFile(key: string, source: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CloudServerOptions = {
  storage: CloudStorage;
  keepAlive: (work: Promise<unknown>) => void;
};

export const hostedLimits = Object.freeze({
  maxUploadBytes: 50 * 1024 ** 2,
  maxTotalSourceBytes: 100 * 1024 ** 2,
  maxSourceSeconds: 60,
  maxOutputSeconds: 60,
  maxPictureSections: 8,
  maxAudioSections: 3,
  maxSourceDimension: 1920,
  maxSourcePixels: 1920 * 1080,
  maxRecordings: 8,
  maxGeneratedBytes: 128 * 1024 ** 2,
  maxOutputBytes: 64 * 1024 ** 2,
  maxGeneratedFiles: 24,
});

export type CloudJob = {
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  result?: unknown;
  error?: string;
};
