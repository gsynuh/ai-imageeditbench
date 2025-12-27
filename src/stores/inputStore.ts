import { map } from "nanostores";
import type { MessageRole } from "../types/db";
import { createId } from "../lib/utils";

export interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
  size: number;
}

export interface InputState {
  role: MessageRole;
  text: string;
  pendingImages: PendingImage[];
  multiplier: number;
}

const initialState: InputState = {
  role: "user",
  text: "",
  pendingImages: [],
  multiplier: 1,
};

export const $inputState = map<InputState>(initialState);

export function setInputRole(role: MessageRole) {
  $inputState.set({ ...$inputState.get(), role });
}

export function setInputText(text: string) {
  $inputState.set({ ...$inputState.get(), text });
}

export function addPendingImage(file: File, size = 512) {
  const state = $inputState.get();
  const previewUrl = URL.createObjectURL(file);
  $inputState.set({
    ...state,
    pendingImages: [
      ...state.pendingImages,
      { id: createId("pending"), file, previewUrl, size },
    ],
  });
}

export function removePendingImage(id: string) {
  const state = $inputState.get();
  const item = state.pendingImages.find((img) => img.id === id);
  if (item) URL.revokeObjectURL(item.previewUrl);
  $inputState.set({
    ...state,
    pendingImages: state.pendingImages.filter((img) => img.id !== id),
  });
}

export function setMultiplier(multiplier: number) {
  $inputState.set({ ...$inputState.get(), multiplier });
}

export function clearInput() {
  const state = $inputState.get();
  state.pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
  $inputState.set({ ...initialState });
}
