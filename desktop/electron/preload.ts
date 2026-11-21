import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("concertCompass", {
  pickVideos: () => ipcRenderer.invoke("media:pick"),
  probe: (filePath: string) => ipcRenderer.invoke("media:probe", filePath),
  preview: (id: string) => ipcRenderer.invoke("media:preview", id),
  previewCut: (selections: unknown, options: unknown, audioSelections?: unknown) => ipcRenderer.invoke("media:preview-cut", selections, options, audioSelections),
  analyzeAudio: (asset: unknown, reduceRumble?: boolean) => ipcRenderer.invoke("media:analyze-audio", asset, reduceRumble),
  suggest: (asset: unknown) => ipcRenderer.invoke("media:suggest", asset),
  render: (selections: unknown, options: unknown, audioSelections?: unknown) => ipcRenderer.invoke("media:render", selections, options, audioSelections),
  cancelRender: () => ipcRenderer.invoke("media:cancel-render"),
  saveProject: (snapshot: unknown) => ipcRenderer.invoke("project:save", snapshot),
  openProject: () => ipcRenderer.invoke("project:open"),
  onProgress: (callback: (progress: number) => void) => ipcRenderer.on("media:progress", (_event, progress) => callback(progress)),
});
