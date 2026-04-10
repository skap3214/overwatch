import { create } from "zustand";
import type { NotificationEvent } from "../types";

type NotificationsStore = {
  notifications: NotificationEvent[];
  upsertNotification: (notification: NotificationEvent) => void;
  markSeen: (id: string) => void;
  unreadCount: () => number;
  latestUnread: () => NotificationEvent | null;
};

export const useNotificationsStore = create<NotificationsStore>((set, get) => ({
  notifications: [],

  upsertNotification: (notification) => {
    const notifications = get().notifications.slice();
    const index = notifications.findIndex((item) => item.id === notification.id);
    if (index === -1) notifications.unshift(notification);
    else notifications[index] = notification;
    notifications.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    set({ notifications: notifications.slice(0, 100) });
  },

  markSeen: (id) => {
    set({
      notifications: get().notifications.map((item) =>
        item.id === id && item.status === "new"
          ? { ...item, status: "seen" }
          : item
      ),
    });
  },

  unreadCount: () =>
    get().notifications.filter((item) => item.status === "new").length,

  latestUnread: () =>
    get().notifications.find((item) => item.status === "new") ?? null,
}));
