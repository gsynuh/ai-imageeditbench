import { atom } from "nanostores";
import type { ViewKey } from "../types/db";

export const $activeView = atom<ViewKey>("session");
export const $activeSessionId = atom<string | null>(null);

export function setActiveView(view: ViewKey) {
  $activeView.set(view);
}

export function setActiveSession(id: string | null) {
  $activeSessionId.set(id);
}
