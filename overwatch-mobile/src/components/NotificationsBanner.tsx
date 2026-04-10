import React from "react";
import { Pressable, Text, View } from "react-native";
import { Bell } from "lucide-react-native";
import { useNotificationsStore } from "../stores/notifications-store";
import { useColors } from "../theme";
import { realtimeClient } from "../services/realtime";

export function NotificationsBanner() {
  const colors = useColors();
  const unreadCount = useNotificationsStore((s) => s.unreadCount());
  const latestUnread = useNotificationsStore((s) => s.latestUnread());
  const markSeen = useNotificationsStore((s) => s.markSeen);

  if (!latestUnread || unreadCount === 0) return null;

  return (
    <Pressable
      onPress={() => {
        markSeen(latestUnread.id);
        realtimeClient.acknowledgeNotification(latestUnread.id);
      }}
      style={{
        marginHorizontal: 16,
        marginTop: 6,
        marginBottom: 8,
        backgroundColor: colors.surface,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <Bell size={16} color={colors.textDim} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: colors.text,
            fontSize: 13,
            fontFamily: "IosevkaAile-Bold",
          }}
          numberOfLines={1}
        >
          {latestUnread.title}
        </Text>
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Regular",
            marginTop: 4,
          }}
          numberOfLines={2}
        >
          {latestUnread.body}
        </Text>
        {unreadCount > 1 ? (
          <Text
            style={{
              color: colors.textFaint,
              fontSize: 11,
              fontFamily: "IosevkaAile-Regular",
              marginTop: 6,
            }}
          >
            {unreadCount} unread notifications
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
