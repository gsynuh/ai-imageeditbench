import { useStore } from "@nanostores/react";
import { $notifications, removeNotification } from "@stores/notificationsStore";
import type { Notification } from "@stores/notificationsStore";
import styles from "./Notifications.module.scss";

function NotificationItem({ notification }: { notification: Notification }) {
  return (
    <div className={`${styles.notification} ${styles[notification.type]}`}>
      <p>{notification.message}</p>
      <button onClick={() => removeNotification(notification.id)}>
        &times;
      </button>
    </div>
  );
}

export default function Notifications() {
  const notifications = useStore($notifications);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className={styles.notificationsContainer}>
      {notifications.map((notification) => (
        <NotificationItem key={notification.id} notification={notification} />
      ))}
    </div>
  );
}
