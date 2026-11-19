import type { ExportOptions, MediaAsset, RenderSelection } from "../shared/render-plan";

declare global {
  interface Window {
    concertCompass: {
      pickVideos(): Promise<{ path: string; id: string }[]>;
      probe(filePath: string): Promise<MediaAsset>;
      preview(id: string): Promise<string>;
      render(selections: RenderSelection[], options: ExportOptions): Promise<{ cancelled: boolean; output?: string }>;
      onProgress(callback: (progress: number) => void): void;
    };
  }
}

export {};
