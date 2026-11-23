import type {
  OverlayConfig,
  TelemetrySnapshot,
  UpdateProgress,
  UpdateStatus
} from "../shared/types.js";

export const CDP_BINDING_NAME = "__codexHudSend";
export const CDP_RECEIVE_FN = "__codexHudReceive";
export const CDP_DEFAULT_PORT = 9222;
export const CDP_HOST = "127.0.0.1";

export type CdpHostEvent =
  | { type: "snapshot"; payload: TelemetrySnapshot }
  | { type: "config"; payload: OverlayConfig }
  | { type: "update_status"; payload: UpdateStatus }
  | { type: "update_progress"; payload: UpdateProgress }
  | { type: "teardown" };

export type CdpWidgetMessage =
  | { type: "ready" }
  | { type: "thread_hint"; threadId: string | null }
  | { type: "update_config"; patch: Partial<OverlayConfig> }
  | { type: "check_updates"; repo?: string }
  | { type: "apply_update" }
  | { type: "restart_monitor" };

export function parseWidgetMessage(raw: string): CdpWidgetMessage | null {
  try {
    const data = JSON.parse(raw) as Partial<CdpWidgetMessage> | null;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return null;
    switch (data.type) {
      case "ready":
      case "apply_update":
      case "restart_monitor":
        return { type: data.type };
      case "thread_hint":
        return {
          type: "thread_hint",
          threadId: typeof data.threadId === "string" && data.threadId.length > 0 ? data.threadId : null
        };
      case "update_config":
        return data.patch && typeof data.patch === "object"
          ? { type: "update_config", patch: data.patch }
          : null;
      case "check_updates":
        return {
          type: "check_updates",
          repo: typeof data.repo === "string" ? data.repo : undefined
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
