import type { MediaAsset, RenderSelection } from "../shared/render-plan";

declare global {
  interface Window {
    concertCompass: {
      pickVideos(): Promise<{ path: string; previewUrl: string }[]>;
      probe(filePath: string): Promise<MediaAsset>;
      render(selections: RenderSelection[]): Promise<{ cancelled: boolean; output?: string }>;
      onProgress(callback: (progress: number) => void): void;
    };
  }
}

export {};
