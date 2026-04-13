import { useCallback, useRef, useState } from "react";
import { Animated, FlatList, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

const SCROLL_THRESHOLD = 24;

export function useScrollToBottom<T = unknown>() {
  const listRef = useRef<FlatList<T>>(null);
  const isAtBottomAnim = useRef(new Animated.Value(1)).current;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const shouldAutoScrollRef = useRef(true);
  const isDraggingRef = useRef(false);
  const autoScrollLockedRef = useRef(false);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      const atBottom = distanceFromBottom < SCROLL_THRESHOLD;

      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
        Animated.timing(isAtBottomAnim, {
          toValue: atBottom ? 1 : 0,
          duration: 150,
          useNativeDriver: true,
        }).start();
      }

      if (!atBottom) {
        shouldAutoScrollRef.current = false;
      } else if (!isDraggingRef.current && !autoScrollLockedRef.current) {
        shouldAutoScrollRef.current = true;
      }
    },
    [isAtBottomAnim],
  );

  const onScrollBeginDrag = useCallback(() => {
    isDraggingRef.current = true;
    autoScrollLockedRef.current = true;
    shouldAutoScrollRef.current = false;
  }, []);

  const onScrollEndDrag = useCallback(() => {
    isDraggingRef.current = false;
    if (!autoScrollLockedRef.current && isAtBottomRef.current) {
      shouldAutoScrollRef.current = true;
    }
  }, []);

  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      const atBottom = distanceFromBottom < SCROLL_THRESHOLD;
      isDraggingRef.current = false;
      if (atBottom) {
        autoScrollLockedRef.current = false;
        shouldAutoScrollRef.current = true;
        if (!isAtBottomRef.current) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
          isAtBottomAnim.setValue(1);
        }
      }
    },
    [isAtBottomAnim],
  );

  const scrollToBottom = useCallback(() => {
    autoScrollLockedRef.current = false;
    shouldAutoScrollRef.current = true;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    isAtBottomAnim.setValue(1);
    listRef.current?.scrollToEnd({ animated: true });
  }, [isAtBottomAnim]);

  return {
    listRef,
    isAtBottom,
    isAtBottomAnim,
    isAtBottomRef,
    shouldAutoScrollRef,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollEnd,
    scrollToBottom,
  };
}
