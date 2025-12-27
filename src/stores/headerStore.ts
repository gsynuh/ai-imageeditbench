import { atom } from "nanostores";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type ButtonVariant = "default" | "secondary" | "ghost" | "outline" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export type HeaderAction = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onClick: () => void | Promise<void>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  title?: string;
};

export const $headerCenter = atom<ReactNode | null>(null);
export const $headerRightActions = atom<HeaderAction[]>([]);

export function setHeaderCenter(content: ReactNode | null) {
  $headerCenter.set(content);
}

export function setHeaderRightActions(actions: HeaderAction[]) {
  $headerRightActions.set(actions);
}
