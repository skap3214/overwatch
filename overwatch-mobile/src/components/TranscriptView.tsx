import React, { useRef, useEffect } from "react";
import { FlatList, View, Text, Keyboard } from "react-native";
import { useTurnStore } from "../stores/turn-store";
import { useColors } from "../theme";
import { ChevronRight } from "lucide-react-native";
import type { Message } from "../types";

function MessageBubble({ message, colors }: { message: Message; colors: ReturnType<typeof useColors> }) {
  if (message.role === "tool_call") {
    return (
      <View style={{ paddingVertical: 4, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <ChevronRight size={12} color={colors.textFaint} />
        <Text style={{ color: colors.textFaint, fontSize: 11, fontFamily: "IosevkaAile-Regular", fontStyle: "italic" }}>
          {message.text}
        </Text>
      </View>
    );
  }

  if (message.role === "error") {
    return (
      <View style={{ paddingVertical: 4, paddingHorizontal: 16 }}>
        <Text style={{ color: colors.error, fontSize: 13, fontFamily: "IosevkaAile-Regular" }}>{message.text}</Text>
      </View>
    );
  }

  const isUser = message.role === "user";

  return (
    <View style={{ paddingVertical: 6, paddingHorizontal: 16, alignItems: isUser ? "flex-end" : "flex-start" }}>
      <View
        style={
          isUser
            ? {
                backgroundColor: colors.surfaceAlt,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 18,
                borderBottomRightRadius: 4,
                maxWidth: "85%",
              }
            : {
                backgroundColor: colors.surface,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 18,
                borderBottomLeftRadius: 4,
                maxWidth: "90%",
              }
        }
      >
        <Text style={{ color: colors.text, fontSize: 14, fontFamily: "IosevkaAile-Regular", lineHeight: 21 }} selectable>
          {message.text}
        </Text>
      </View>
    </View>
  );
}

export function TranscriptView({ topInset = 0 }: { topInset?: number }) {
  const colors = useColors();
  const messages = useTurnStore((s) => s.messages);
  const flatListRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages]);

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <MessageBubble message={item} colors={colors} />}
      contentContainerStyle={{ paddingTop: topInset, paddingBottom: 8 }}
      style={{ flex: 1 }}
      keyboardDismissMode="on-drag"
      onScrollBeginDrag={() => Keyboard.dismiss()}
    />
  );
}
