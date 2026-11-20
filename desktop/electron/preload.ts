import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("concertCompass", {
  pickVideos: () => ipcRenderer.invoke("media:pick"),
  probe: (filePath: string) => ipcRenderer.invoke("media:probe", filePath),
  preview: (id: string) => ipcRenderer.invoke("media:preview", id),
  suggest: (asset: unknown) => ipcRenderer.invoke("media:suggest", asset),
  render: (selections: unknown, options: unknown) => ipcRenderer.invoke("media:render", selections, options),
  cancelRender: () => ipcRenderer.invoke("media:cancel-render"),
  saveProject: (snapshot: unknown) => ipcRenderer.invoke("project:save", snapshot),
  openProject: () => ipcRenderer.invoke("project:open"),
  onProgress: (callback: (progress: number) => void) => ipcRenderer.on("media:progress", (_event, progress) => callback(progress)),
});
