import React from "react";
import { View, Text, Pressable, FlatList } from "react-native";
import { Plus, Trash2, MessageSquare } from "lucide-react-native";
import { useTurnStore, type SessionInfo } from "../stores/turn-store";
import { useColors, type Colors } from "../theme";
import { GlassSurface } from "./GlassSurface";

type Props = {
  onClose: () => void;
};

function SessionRow({ session, isActive, onPress, onDelete, colors }: {
  session: SessionInfo;
  isActive: boolean;
  onPress: () => void;
  onDelete: () => void;
  colors: Colors;
}) {
  const date = new Date(session.lastMessageAt);
  const timeStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
        backgroundColor: isActive ? colors.surface : "transparent",
        borderRadius: 14,
        marginHorizontal: 12,
        marginVertical: 2,
      }}
    >
      <MessageSquare size={16} color={isActive ? colors.text : colors.textDim} />
      <View style={{ flex: 1 }}>
        <Text
          style={{ color: isActive ? colors.text : colors.textDim, fontSize: 14, fontFamily: "IosevkaAile-Regular" }}
          numberOfLines={1}
        >
          {session.title}
        </Text>
        <Text style={{ color: colors.textFaint, fontSize: 11, fontFamily: "IosevkaAile-Regular", marginTop: 2 }}>
          {timeStr} · {session.messageCount} messages
        </Text>
      </View>
      <Pressable onPress={onDelete} hitSlop={10}>
        <Trash2 size={14} color={colors.textFaint} />
      </Pressable>
    </Pressable>
  );
}

export function SessionsPanel({ onClose }: Props) {
  const colors = useColors();
  const { sessions, activeSessionId, switchSession, newSession } = useTurnStore();
  const { deleteSession } = useTurnStore();

  const handleSwitch = (id: string) => {
    switchSession(id);
    onClose();
  };

  const handleNew = () => {
    // Don't create a new session if the current one is empty
    const active = sessions.find((s) => s.id === activeSessionId);
    if (active && active.messageCount === 0) {
      // Already on an empty session — just go to chat
      onClose();
      return;
    }
    newSession();
    onClose();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 22, fontFamily: "IosevkaAile-Bold", paddingLeft: 8 }}>
          Sessions
        </Text>
        <Pressable onPress={handleNew} hitSlop={16}>
          <GlassSurface
            isInteractive
            style={{ padding: 10, borderRadius: 14 }}
            fallbackStyle={{ backgroundColor: colors.surface }}
            tintColor={colors.surface}
          >
            <Plus size={26} color={colors.text} />
          </GlassSurface>
        </Pressable>
      </View>

      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            isActive={item.id === activeSessionId}
            onPress={() => handleSwitch(item.id)}
            onDelete={() => deleteSession(item.id)}
            colors={colors}
          />
        )}
        contentContainerStyle={{ paddingVertical: 4 }}
      />
    </View>
  );
}
