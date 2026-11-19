import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("concertCompass", {
  pickVideos: () => ipcRenderer.invoke("media:pick"),
  probe: (filePath: string) => ipcRenderer.invoke("media:probe", filePath),
  preview: (id: string) => ipcRenderer.invoke("media:preview", id),
  render: (selections: unknown, options: unknown) => ipcRenderer.invoke("media:render", selections, options),
  onProgress: (callback: (progress: number) => void) => ipcRenderer.on("media:progress", (_event, progress) => callback(progress)),
});
