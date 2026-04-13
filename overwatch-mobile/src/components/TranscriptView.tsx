import React, { useRef, useEffect, useCallback, useState } from "react";
import { FlatList, View, Text, Keyboard, useWindowDimensions } from "react-native";
import { useTurnStore } from "../stores/turn-store";
import { useColors } from "../theme";
import { useScrollToBottom } from "../hooks/use-scroll-to-bottom";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { ChevronRight } from "lucide-react-native";
import type { Message } from "../types";

function MessageBubble({ message, colors, isLast, anchorMinHeight }: {
  message: Message;
  colors: ReturnType<typeof useColors>;
  isLast: boolean;
  anchorMinHeight: number;
}) {
  const content = (() => {
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
  })();

  if (isLast && anchorMinHeight > 0) {
    return <View style={{ minHeight: anchorMinHeight }}>{content}</View>;
  }
  return content;
}

export function TranscriptView({ topInset = 0 }: { topInset?: number }) {
  const colors = useColors();
  const messages = useTurnStore((s) => s.messages);
  const turnState = useTurnStore((s) => s.turnState);
  const { height: windowHeight } = useWindowDimensions();

  const {
    listRef,
    isAtBottomAnim,
    shouldAutoScrollRef,
    onScroll,
    onScrollBeginDrag: scrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollEnd,
    scrollToBottom,
  } = useScrollToBottom<Message>();

  const [listHeight, setListHeight] = useState(0);
  const anchorMinHeight = listHeight > 0 ? Math.max(0, listHeight - topInset - 16) : Math.round(windowHeight * 0.7);

  // Track whether anchor mode is active (new message arrived)
  const anchorModeRef = useRef(false);
  const prevLastIdRef = useRef<string | null>(null);
  const hasInitialScrollRef = useRef(false);
  const pendingScrollRef = useRef(false);

  const lastId = messages[messages.length - 1]?.id ?? null;

  // Detect new messages → enable anchor mode + queue scroll
  useEffect(() => {
    if (messages.length === 0) {
      anchorModeRef.current = false;
      prevLastIdRef.current = null;
      pendingScrollRef.current = false;
      return;
    }
    if (lastId && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      anchorModeRef.current = true;
      pendingScrollRef.current = true;
    }
  }, [messages.length, lastId]);

  // Auto-scroll when streaming starts and we have a pending scroll
  useEffect(() => {
    if (!pendingScrollRef.current) return;
    if (turnState === "idle" && !shouldAutoScrollRef.current) return;
    pendingScrollRef.current = false;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [turnState, messages.length, listRef, shouldAutoScrollRef]);

  // Initial scroll — instant, no animation
  useEffect(() => {
    if (!hasInitialScrollRef.current && messages.length > 0) {
      hasInitialScrollRef.current = true;
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
      });
    }
  }, [messages.length, listRef]);

  // Continue auto-scrolling while streaming if user hasn't scrolled away
  useEffect(() => {
    if ((turnState === "processing" || turnState === "playing") && shouldAutoScrollRef.current) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages, turnState, listRef, shouldAutoScrollRef]);

  const handleScrollBeginDrag = useCallback(() => {
    Keyboard.dismiss();
    scrollBeginDrag();
  }, [scrollBeginDrag]);

  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => (
      <MessageBubble
        message={item}
        colors={colors}
        isLast={index === messages.length - 1 && anchorModeRef.current}
        anchorMinHeight={anchorMinHeight}
      />
    ),
    [colors, messages.length, anchorMinHeight],
  );

  const keyExtractor = useCallback((item: Message) => item.id, []);

  return (
    <View
      style={{ flex: 1 }}
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height);
        if (h > 0 && h !== listHeight) setListHeight(h);
      }}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={{ paddingTop: topInset, paddingBottom: 16 }}
        style={{ flex: 1 }}
        onScroll={onScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        scrollEventThrottle={16}
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      />
      <ScrollToBottomButton isAtBottomAnim={isAtBottomAnim} onPress={scrollToBottom} />
    </View>
  );
}
