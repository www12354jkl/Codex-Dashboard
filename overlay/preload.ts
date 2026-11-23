import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type CodexHudApi, type HitRect } from "../shared/types.js";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

function interactiveHitRects(): HitRect[] {
  const rects: HitRect[] = [];
  const addRect = (element: Element, padding = 0) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    if (width > 0 && height > 0) {
      rects.push({ x: x - padding, y: y - padding, width: width + 2 * padding, height: height + 2 * padding });
    }
  };
  const group = document.getElementById("hud-group");
  if (group) addRect(group, 2);
  for (const popover of document.querySelectorAll(".metric-popover:popover-open")) addRect(popover);
  return rects;
}

const api: CodexHudApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SNAPSHOT),
  onSnapshot: listener => subscribe(IPC_CHANNELS.ON_SNAPSHOT, listener),
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  updateConfig: patch => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CONFIG, patch),
  onConfig: listener => subscribe(IPC_CHANNELS.ON_CONFIG, listener),
  getRuntimeState: () => ipcRenderer.invoke(IPC_CHANNELS.GET_RUNTIME_STATE),
  onRuntimeState: listener => subscribe(IPC_CHANNELS.ON_RUNTIME_STATE, listener),
  reportHitRects: () => ipcRenderer.send(IPC_CHANNELS.REPORT_HIT_RECTS, interactiveHitRects()),
  checkForUpdates: repoOverride => ipcRenderer.invoke(IPC_CHANNELS.CHECK_UPDATES, repoOverride),
  applyUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APPLY_UPDATE),
  restartApp: () => ipcRenderer.invoke(IPC_CHANNELS.RESTART_APP),
  onUpdateStatus: listener => subscribe(IPC_CHANNELS.ON_UPDATE_STATUS, listener),
  onUpdateProgress: listener => subscribe(IPC_CHANNELS.ON_UPDATE_PROGRESS, listener)
};

contextBridge.exposeInMainWorld("codexHud", api);

