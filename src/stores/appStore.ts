import { atom } from "nanostores";
import type { ViewKey } from "../types/db";

export const $activeView = atom<ViewKey>("main");
export const $activeConversationId = atom<string | null>(null);

export function setActiveView(view: ViewKey) {
  $activeView.set(view);
}

export function setActiveConversation(id: string | null) {
  $activeConversationId.set(id);
}
