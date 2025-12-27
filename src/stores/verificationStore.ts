import { atom } from "nanostores";

export interface VerificationDialog {
  type: "success" | "error";
  title: string;
  message: string;
  modelId: string;
}

export const $verificationDialog = atom<VerificationDialog | null>(null);

export function showVerificationDialog(dialog: VerificationDialog) {
  $verificationDialog.set(dialog);
}

export function closeVerificationDialog() {
  $verificationDialog.set(null);
}
