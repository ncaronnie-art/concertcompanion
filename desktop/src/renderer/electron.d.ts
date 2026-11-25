import type { AudioSelection, ExportOptions, MediaAsset, RenderSelection } from "../shared/render-plan";
import type { AudioBin, Suggestion } from "../shared/suggestions";
import type { ProjectSnapshot } from "../shared/project-file";
import type { ManualSubject, VisualAnalysis } from "../shared/visual-tracking";

declare global {
  interface Window {
    concertCompass: {
      pickVideos(): Promise<{ path: string; id: string }[]>;
      probe(filePath: string): Promise<MediaAsset>;
      preview(id: string): Promise<string>;
      suggest(asset: MediaAsset, highlightFocus?: "balanced" | "performance"): Promise<Suggestion>;
      analyzeAudio(asset: MediaAsset, reduceRumble?: boolean): Promise<AudioBin[]>;
      analyzeVisual(asset: MediaAsset, options: { start?: number; end?: number; fps?: number; subject?: ManualSubject }): Promise<VisualAnalysis>;
      render(selections: RenderSelection[], options: ExportOptions, audioSelections?: AudioSelection[]): Promise<{ cancelled: boolean; output?: string; cleanupWarning?: boolean }>;
      previewCut(selections: RenderSelection[], options: ExportOptions, audioSelections?: AudioSelection[]): Promise<{ url: string }>;
      cancelRender(): Promise<boolean>;
      saveProject(snapshot: ProjectSnapshot): Promise<{ cancelled: boolean; path?: string }>;
      openProject(): Promise<{ snapshot: ProjectSnapshot; files: { path: string; id: string }[] } | null>;
      onProgress(callback: (progress: number) => void): void;
    };
  }
}

export {};
