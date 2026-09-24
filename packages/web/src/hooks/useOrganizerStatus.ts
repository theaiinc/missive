import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL = 5_000;

export function useOrganizerStatus() {
  const [running, setRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/v1/organizer-status");
        if (res.ok) {
          const data = await res.json();
          setRunning(data.running === true);
        }
      } catch {
        // ignore
      }
    };
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return running;
}
