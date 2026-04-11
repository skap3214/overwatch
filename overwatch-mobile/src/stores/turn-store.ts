import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Message, TurnState } from "../types";

const SESSIONS_INDEX_KEY = "overwatch_sessions_index";
const MESSAGES_PREFIX = "overwatch_messages_";
const ACTIVE_SESSION_KEY = "overwatch_active_session";

export type SessionInfo = {
  id: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
};

type TurnStore = {
  turnState: TurnState;
  messages: Message[];
  pendingText: string;
  pendingMessageId: string | null;
  abortController: AbortController | null;
  activeSessionId: string;
  sessions: SessionInfo[];

  setTurnState: (state: TurnState) => void;
  addUserMessage: (text: string) => void;
  handleTextDelta: (text: string) => void;
  handleToolCall: (name: string) => void;
  handleDone: () => void;
  handleError: (message: string) => void;
  setAbortController: (controller: AbortController | null) => void;
  cancelTurn: () => void;
  clearMessages: () => void;
  loadSessions: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  reset: () => void;
};

let nextId = 0;
const makeId = () => `msg_${++nextId}_${Date.now()}`;
const makeSessionId = () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function restoreIdCounter(messages: Message[]) {
  for (const m of messages) {
    const match = m.id.match(/^msg_(\d+)/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > nextId) nextId = n;
    }
  }
}

async function loadMessages(sessionId: string): Promise<Message[]> {
  try {
    const stored = await AsyncStorage.getItem(MESSAGES_PREFIX + sessionId);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

async function saveMessages(sessionId: string, messages: Message[]) {
  const toSave = messages.slice(-200);
  await AsyncStorage.setItem(MESSAGES_PREFIX + sessionId, JSON.stringify(toSave)).catch(() => {});
}

async function loadSessionsIndex(): Promise<SessionInfo[]> {
  try {
    const stored = await AsyncStorage.getItem(SESSIONS_INDEX_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

async function saveSessionsIndex(sessions: SessionInfo[]) {
  await AsyncStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(sessions)).catch(() => {});
}

function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    const text = firstUser.text.slice(0, 40);
    return text.length < firstUser.text.length ? text + "..." : text;
  }
  return "New Session";
}

export const useTurnStore = create<TurnStore>((set, get) => ({
  turnState: "idle",
  messages: [],
  pendingText: "",
  pendingMessageId: null,
  abortController: null,
  activeSessionId: "",
  sessions: [],

  setTurnState: (turnState) => set({ turnState }),

  addUserMessage: (text) => {
    const msg: Message = { id: makeId(), role: "user", text, timestamp: Date.now() };
    const messages = [...get().messages, msg];
    set({ messages });
    const { activeSessionId } = get();
    saveMessages(activeSessionId, messages);
    updateSessionIndex(get);
  },

  handleTextDelta: (text) => {
    const { pendingMessageId, pendingText, messages } = get();
    if (!pendingMessageId) {
      const id = makeId();
      const msg: Message = { id, role: "assistant", text, timestamp: Date.now() };
      set({ messages: [...messages, msg], pendingMessageId: id, pendingText: text });
    } else {
      const newText = pendingText + text;
      set({
        pendingText: newText,
        messages: messages.map((m) => (m.id === pendingMessageId ? { ...m, text: newText } : m)),
      });
    }
  },

  handleToolCall: (name) => {
    const toolMsg: Message = { id: makeId(), role: "tool_call", text: name, timestamp: Date.now() };
    const messages = [...get().messages, toolMsg];
    set({ messages, pendingMessageId: null, pendingText: "" });
    saveMessages(get().activeSessionId, messages);
    updateSessionIndex(get);
  },

  handleDone: () => {
    const { activeSessionId, messages } = get();
    saveMessages(activeSessionId, messages);
    updateSessionIndex(get);
    set({ pendingMessageId: null, pendingText: "", turnState: "idle" });
  },

  handleError: (message) => {
    const errMsg: Message = { id: makeId(), role: "error", text: message, timestamp: Date.now() };
    const messages = [...get().messages, errMsg];
    set({ messages, pendingMessageId: null, pendingText: "", turnState: "idle" });
    saveMessages(get().activeSessionId, messages);
    updateSessionIndex(get);
  },

  setAbortController: (controller) => set({ abortController: controller }),

  cancelTurn: () => {
    const { abortController } = get();
    abortController?.abort();
    set({ abortController: null, pendingMessageId: null, pendingText: "", turnState: "idle" });
  },

  clearMessages: () => {
    set({ messages: [], pendingMessageId: null, pendingText: "", turnState: "idle" });
  },

  loadSessions: async () => {
    let sessions = await loadSessionsIndex();
    let activeId: string | null = null;
    try {
      activeId = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
    } catch {}

    // Create default session if none exist
    if (sessions.length === 0) {
      const id = makeSessionId();
      sessions = [{ id, title: "New Session", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0 }];
      await saveSessionsIndex(sessions);
      activeId = id;
      await AsyncStorage.setItem(ACTIVE_SESSION_KEY, id);
    }

    if (!activeId || !sessions.find((s) => s.id === activeId)) {
      activeId = sessions[0].id;
    }

    const messages = await loadMessages(activeId);
    restoreIdCounter(messages);

    set({ sessions, activeSessionId: activeId, messages });
  },

  switchSession: async (sessionId: string) => {
    const { sessions, activeSessionId: currentId, messages: currentMessages, abortController } = get();
    if (!sessions.find((s) => s.id === sessionId)) return;

    // Cancel any in-progress turn so streaming events don't bleed
    if (abortController) abortController.abort();

    // Save current session's messages before switching
    if (currentId && currentMessages.length > 0) {
      await saveMessages(currentId, currentMessages);
    }

    const messages = await loadMessages(sessionId);
    restoreIdCounter(messages);

    set({ activeSessionId: sessionId, messages, pendingMessageId: null, pendingText: "", turnState: "idle", abortController: null });
    await AsyncStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  },

  newSession: async () => {
    const id = makeSessionId();
    const info: SessionInfo = { id, title: "New Session", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0 };
    const sessions = [info, ...get().sessions];

    set({ sessions, activeSessionId: id, messages: [], pendingMessageId: null, pendingText: "", turnState: "idle" });
    await saveSessionsIndex(sessions);
    await AsyncStorage.setItem(ACTIVE_SESSION_KEY, id);
  },

  deleteSession: async (sessionId: string) => {
    let { sessions, activeSessionId } = get();
    sessions = sessions.filter((s) => s.id !== sessionId);
    await AsyncStorage.removeItem(MESSAGES_PREFIX + sessionId);

    if (sessions.length === 0) {
      const id = makeSessionId();
      sessions = [{ id, title: "New Session", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0 }];
      activeSessionId = id;
    } else if (activeSessionId === sessionId) {
      activeSessionId = sessions[0].id;
    }

    const messages = await loadMessages(activeSessionId);
    restoreIdCounter(messages);

    set({ sessions, activeSessionId, messages });
    await saveSessionsIndex(sessions);
    await AsyncStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  },

  reset: () => set({
    turnState: "idle", messages: [], pendingText: "",
    pendingMessageId: null, abortController: null,
  }),
}));

function updateSessionIndex(get: () => TurnStore) {
  const { sessions, activeSessionId, messages } = get();
  const updated = sessions.map((s) => {
    if (s.id !== activeSessionId) return s;
    return {
      ...s,
      title: deriveTitle(messages),
      lastMessageAt: Date.now(),
      messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
    };
  });
  useTurnStore.setState({ sessions: updated });
  saveSessionsIndex(updated);
}
