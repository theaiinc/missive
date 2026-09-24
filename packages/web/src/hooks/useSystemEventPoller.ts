import { useEffect, useRef } from "react";
import { useChat } from "./useChat";

const POLL_INTERVAL = 15_000;

export function useSystemEventPoller() {
  const { pushSystemMessage } = useChat();
  const seenIdsRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/v1/system-events");
        if (!res.ok) return;
        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) return;

        // Push only unseen events
        for (const evt of events) {
          if (!seenIdsRef.current.has(evt.id)) {
            seenIdsRef.current.add(evt.id);
            pushSystemMessage(evt.message, evt.type);
          }
        }
      } catch {
        // silently ignore polling errors
      }
    };

    // Give things a moment to settle before first poll
    const initial = setTimeout(poll, 8_000);
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      clearTimeout(initial);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [pushSystemMessage]);
}
