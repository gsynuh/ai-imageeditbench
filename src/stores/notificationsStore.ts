import { atom } from "nanostores";

export type Notification = {
  id: string;
  type: "info" | "warning" | "error";
  message: string;
};

export const $notifications = atom<Notification[]>([]);

export function addNotification(notification: Omit<Notification, "id">) {
  const id = `notif-${Date.now()}`;
  const newNotification = { ...notification, id };
  $notifications.set([...$notifications.get(), newNotification]);
}

export function removeNotification(id: string) {
  $notifications.set($notifications.get().filter((n) => n.id !== id));
}
