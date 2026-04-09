import React from "react";
import { View, Text, Pressable, FlatList } from "react-native";
import { Plus, Trash2, MessageSquare, ChevronLeft } from "lucide-react-native";
import { useTurnStore, type SessionInfo } from "../stores/turn-store";
import { useColors, type Colors } from "../theme";

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
  const { sessions, activeSessionId, switchSession, newSession, deleteSession } = useTurnStore();

  const handleSwitch = (id: string) => {
    switchSession(id);
    onClose();
  };

  const handleNew = () => {
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
          paddingHorizontal: 20,
          paddingVertical: 12,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 22, fontFamily: "IosevkaAile-Bold" }}>
          Sessions
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable
            onPress={handleNew}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: colors.surface,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 20,
            }}
          >
            <Plus size={14} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 13, fontFamily: "IosevkaAile-Regular" }}>New</Text>
          </Pressable>
          <Pressable onPress={onClose} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ color: colors.textDim, fontSize: 14, fontFamily: "IosevkaAile-Regular" }}>Chat</Text>
            <ChevronLeft size={16} color={colors.textDim} style={{ transform: [{ rotate: "180deg" }] }} />
          </Pressable>
        </View>
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
