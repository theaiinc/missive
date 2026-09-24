import { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, X, Send, Bot, User, Loader2, Check, XCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChat } from "@/hooks/useChat";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ruleProposal?: RuleProposal;
  isClarification?: boolean;
}

interface RuleProposal {
  name: string;
  description: string;
  conditions: { field: string; operator: string; value: string }[];
  actions: { type: string; params?: Record<string, string> }[];
  needsClarification: boolean;
  clarification?: string;
}

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function RuleCard({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: RuleProposal;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="border border-primary/30 rounded-xl p-3 bg-primary/5 space-y-2.5">
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-xs font-semibold text-foreground">
          {proposal.name}
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {proposal.description}
      </p>

      {/* Conditions */}
      <div className="space-y-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Conditions</span>
        {proposal.conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs text-foreground bg-background/50 rounded px-2 py-1">
            <span className="text-muted-foreground font-mono text-[10px]">{c.field}</span>
            <span className="text-muted-foreground">{c.operator}</span>
            <span className="font-medium truncate">{c.value}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="space-y-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Actions</span>
        {proposal.actions.map((a, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs text-foreground bg-background/50 rounded px-2 py-1">
            <span className="text-primary font-mono text-[10px] capitalize">{a.type.replace(/_/g, " ")}</span>
            {a.params && Object.entries(a.params).map(([k, v]) => (
              <span key={k} className="text-muted-foreground">
                {k}: <span className="font-medium">{v}</span>
              </span>
            ))}
          </div>
        ))}
      </div>

      {/* Approve / Reject */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onApprove}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground py-1.5 hover:bg-primary/90 transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          Approve
        </button>
        <button
          onClick={onReject}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg bg-muted text-muted-foreground py-1.5 hover:text-foreground transition-colors"
        >
          <XCircle className="w-3.5 h-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}

export function ChatWidget() {
  const { open, openChat, closeChat, systemMessages, unreadSystemCount } = useChat();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [rulePending, setRulePending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streamContent]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  /** Send a message, first checking if it's a rule-creation request */
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || rulePending) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    // Try the rule-proposal endpoint first
    setRulePending(true);
    try {
      const ruleRes = await fetch("/api/v1/chat/rule-proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (ruleRes.ok) {
        const ruleData = await ruleRes.json();
        const proposal: RuleProposal | null = ruleData.proposal;

        if (proposal) {
          if (proposal.needsClarification) {
            // AI needs more info — show as a chat message
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: proposal.clarification ?? "Could you clarify?",
                isClarification: true,
              },
            ]);
          } else {
            // Show the rule proposal with approve/reject
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: ruleData.message ?? "I suggest this rule:",
                ruleProposal: proposal,
              },
            ]);
          }
          setRulePending(false);
          return;
        }
      }
    } catch {
      // Rule proposal failed — fall through to normal chat
    }
    setRulePending(false);

    // Normal streaming chat
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setStreamContent("");

    const safetyTimer = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch("/api/v1/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: err.error ?? "Something went wrong. Is LM Studio running?",
          },
        ]);
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "No response from server." },
        ]);
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let fullContent = "";
      let toolCleanedContent: string | null = null;
      let toolResults: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const json = trimmed.slice(6);
          try {
            const parsed = JSON.parse(json);
            if (parsed.done) break;
            if (parsed.content) {
              fullContent += parsed.content;
              setStreamContent(fullContent);
            }
            if (parsed.toolCleaned) {
              // Backend cleaned out tool call lines — use this instead
              toolCleanedContent = parsed.toolCleaned;
              setStreamContent(toolCleanedContent);
            }
            if (parsed.toolResult) {
              toolResults.push(parsed.toolResult);
            }
            if (parsed.error) {
              fullContent += `\n\n⚠️ ${parsed.error}`;
              setStreamContent(fullContent);
            }
          } catch {
            // ignore
          }
        }
      }

      // Use cleaned content if available, otherwise full streamed content
      const finalContent = toolCleanedContent ?? fullContent;

      // Append tool result messages
      let finalDisplay = finalContent;
      for (const tr of toolResults) {
        if (tr.success) {
          finalDisplay += `\n\n✅ ${tr.message}`;
        } else {
          finalDisplay += `\n\n❌ ${tr.message}`;
        }
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: finalDisplay },
      ]);
      setStreamContent("");
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Network error. Make sure the backend is running.",
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              "Request timed out. LM Studio may still be loading the model. Try again in a moment.",
          },
        ]);
      }
    } finally {
      clearTimeout(safetyTimer);
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, rulePending]);

  /** Approve a rule proposal — create the rule via API, apply to existing messages */
  const approveRule = useCallback(async (proposal: RuleProposal) => {
    try {
      const res = await fetch("/api/v1/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: proposal.name,
          description: proposal.description,
          conditions: proposal.conditions,
          actions: proposal.actions,
          enabled: true,
        }),
      });

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Failed to create the rule. Please try again.",
          },
        ]);
        return;
      }

      const rule = await res.json();

      // Also apply the rule to existing inbox messages immediately
      fetch("/api/v1/rules/evaluate-all", { method: "POST" }).catch(() => {});

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `✅ Rule **"${rule.name}"** has been created and activated. It will run automatically on new messages and I've triggered it on your existing inbox.`,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Network error while creating the rule. Please try again.",
        },
      ]);
    }
  }, []);

  /** Reject a rule proposal */
  const rejectRule = useCallback((proposal: RuleProposal) => {
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `Rule **"${proposal.name}"** was rejected. Let me know if you'd like to adjust it or create something different.`,
      },
    ]);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => open ? closeChat() : openChat()}
        className={cn(
          "fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all duration-200",
          open
            ? "bg-muted-foreground hover:bg-foreground scale-90"
            : "bg-primary hover:bg-primary/90 scale-100",
          !open && unreadSystemCount > 0 && "animate-pulse"
        )}
      >
        {open ? (
          <X className="w-5 h-5 text-background" />
        ) : (
          <MessageCircle className="w-5 h-5 text-primary-foreground" />
        )}
        {!open && unreadSystemCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center animate-bounce">
            {unreadSystemCount > 9 ? "9+" : unreadSystemCount}
          </span>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-20 right-5 z-50 w-[360px] h-[520px] rounded-xl border border-border shadow-2xl bg-card flex flex-col overflow-hidden animate-in slide-in-from-bottom-5 fade-in duration-200">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-primary/5">
            <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Missive AI
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Ask about your communications
              </p>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          >
            {messages.length === 0 && !streaming && !rulePending && systemMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Bot className="w-8 h-8 mb-2 opacity-40" />
                <p className="text-sm text-center max-w-[200px]">
                  Ask me anything about your inbox, or try saying "create a rule to organize emails from..."
                </p>
              </div>
            )}

            {/* System event messages — cap at 20 most recent */}
            {systemMessages.slice(-20).map((msg, i) => {
              const isMerged = msg.count && msg.count > 1;
              return (
                <div key={`sys-${i}`} className="flex gap-2.5 justify-start opacity-80">
                  <div className="w-6 h-6 rounded-full bg-primary/60 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="w-3.5 h-3.5 text-primary-foreground" />
                  </div>
                  <div className="max-w-[80%] rounded-2xl rounded-tl-sm px-3.5 py-2 bg-primary/5 border border-primary/10 text-foreground text-xs leading-relaxed relative">
                    <Markdown>{msg.content}</Markdown>
                    {isMerged && (
                      <span className="absolute -top-2 -right-2 min-w-[18px] h-[18px] rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1">
                        {msg.count === 10 ? "9+" : msg.count}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {messages.map((msg, i) => (
              <div key={i} className="space-y-2">
                <div
                  className={cn(
                    "flex gap-2.5",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-primary-foreground" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-muted text-foreground rounded-tl-sm"
                    )}
                  >
                    <div className="[&_code]:bg-muted [&_code]:px-1 [&_code]:rounded [&_code]:text-xs">
                      <Markdown>{msg.content}</Markdown>
                    </div>
                  </div>
                  {msg.role === "user" && (
                    <div className="w-6 h-6 rounded-full bg-muted-foreground flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User className="w-3.5 h-3.5 text-background" />
                    </div>
                  )}
                </div>

                {/* Rule proposal card */}
                {msg.ruleProposal && (
                  <div className="ml-9">
                    <RuleCard
                      proposal={msg.ruleProposal}
                      onApprove={() => approveRule(msg.ruleProposal!)}
                      onReject={() => rejectRule(msg.ruleProposal!)}
                    />
                  </div>
                )}
              </div>
            ))}

            {(streaming || rulePending) && (
              <div className="flex gap-2.5 justify-start">
                <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot className="w-3.5 h-3.5 text-primary-foreground" />
                </div>
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm px-3.5 py-2 bg-muted text-foreground">
                  {streamContent ? (
                    <>
                      <div className="[&_code]:bg-muted [&_code]:px-1 [&_code]:rounded [&_code]:text-xs">
                        <Markdown>{streamContent}</Markdown>
                      </div>
                      <span className="inline-block w-1.5 h-4 bg-primary/60 ml-0.5 animate-pulse" />
                    </>
                  ) : (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span className="text-xs">
                        {rulePending ? "Thinking..." : "Typing..."}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-border">
            <div className="flex items-center gap-2 bg-background rounded-lg border border-border px-3 py-1.5 focus-within:ring-1 focus-within:ring-primary">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Missive AI..."
                disabled={streaming || rulePending}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-50"
              />
              <button
                onClick={send}
                disabled={!input.trim() || streaming || rulePending}
                className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
              >
                {streaming || rulePending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
