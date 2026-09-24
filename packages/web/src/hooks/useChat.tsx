import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface SystemChatMessage {
  role: "assistant";
  content: string;
  isSystemEvent?: true;
  type?: string;
  count?: number;
}

interface ChatContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openChat: () => void;
  closeChat: () => void;
  systemMessages: SystemChatMessage[];
  pushSystemMessage: (content: string, type?: string) => void;
  unreadSystemCount: number;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [systemMessages, setSystemMessages] = useState<SystemChatMessage[]>([]);
  const [unreadSystemCount, setUnreadSystemCount] = useState(0);

  const openChat = useCallback(() => {
    setOpen(true);
    setUnreadSystemCount(0);
  }, []);

  const closeChat = useCallback(() => setOpen(false), []);

  const pushSystemMessage = useCallback((content: string, type?: string) => {
    setUnreadSystemCount((prev) => prev + 1);
    setSystemMessages((prev) => {
      // If same type as last message, merge them
      if (type && prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.type === type) {
          // Cap merged count at 9+ to keep it compact
          const newCount = Math.min((last.count ?? 1) + 1, 10);
          // Keep original content for display, just update count
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            count: newCount,
          };
          return updated;
        }
      }
      return [
        ...prev,
        { role: "assistant" as const, content, isSystemEvent: true, type, count: 1 },
      ];
    });
  }, []);

  return (
    <ChatContext.Provider value={{ open, setOpen, openChat, closeChat, systemMessages, pushSystemMessage, unreadSystemCount }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return ctx;
}
