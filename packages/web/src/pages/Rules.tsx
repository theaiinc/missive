import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ToggleLeft, ToggleRight, Trash2, Loader2, Sparkles, AlertCircle, MessageCirclePlus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Rule } from "@theaiinc/missive-core";
import { useChat } from "@/hooks/useChat";

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

const actionLabel: Record<string, string> = {
  move_to_folder: "Move to folder",
  mark_read: "Mark read",
  mark_unread: "Mark unread",
  archive: "Archive",
  label: "Label",
  delete: "Delete",
  forward: "Forward",
  notify: "Notify",
};

const conditionLabel: Record<string, string> = {
  from_address: "From address",
  from_domain: "From domain",
  subject_contains: "Subject contains",
  subject_matches: "Subject matches",
  body_contains: "Body contains",
  has_attachments: "Has attachments",
  channel: "Channel",
  classification: "Classification",
  account_email: "Account email",
  received_after: "Received after",
  received_before: "Received before",
  direction: "Direction",
};

const operatorLabel: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  matches: "matches",
  before: "before",
  after: "after",
};

function RuleCard({ rule, onToggle, onDelete }: { rule: Rule; onToggle: () => void; onDelete: () => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Name and status */}
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
            <h3 className="text-sm font-semibold text-foreground truncate">
              {rule.name}
            </h3>
            <Badge
              variant={rule.enabled ? "default" : "secondary"}
              className="text-[10px] flex-shrink-0"
            >
              {rule.enabled ? "Active" : "Disabled"}
            </Badge>
          </div>

          {/* Description */}
          {rule.description && (
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              {rule.description}
            </p>
          )}

          {/* Conditions */}
          <div className="space-y-1 mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Conditions
            </span>
            {rule.conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-foreground bg-muted/50 rounded px-2 py-1">
                <span className="text-muted-foreground font-medium">
                  {conditionLabel[c.field] ?? c.field}
                </span>
                <span className="text-muted-foreground">
                  {operatorLabel[c.operator] ?? c.operator}
                </span>
                <span className="font-medium truncate">{c.value}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="space-y-1 mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Actions
            </span>
            {rule.actions.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-foreground bg-muted/50 rounded px-2 py-1">
                <span className="text-primary font-medium capitalize">
                  {actionLabel[a.type] ?? a.type.replace(/_/g, " ")}
                </span>
                {a.params && Object.entries(a.params).map(([k, v]) => (
                  <span key={k} className="text-muted-foreground">
                    {k}: <span className="font-medium">{v}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>

          {/* Stats */}
          {rule.appliedCount != null && rule.appliedCount > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Applied {rule.appliedCount} time{rule.appliedCount !== 1 ? "s" : ""}
              {rule.lastAppliedAt ? ` — last ${formatRelativeTime(rule.lastAppliedAt)}` : ""}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            title={rule.enabled ? "Disable rule" : "Enable rule"}
          >
            {rule.enabled ? (
              <ToggleRight className="w-4 h-4 text-primary" />
            ) : (
              <ToggleLeft className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
            title="Delete rule"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function Rules() {
  const queryClient = useQueryClient();
  const { openChat } = useChat();

  const { data: rules, isLoading, isError } = useQuery({
    queryKey: ["rules"],
    queryFn: async (): Promise<Rule[]> => {
      const res = await fetch("/api/v1/rules");
      if (!res.ok) throw new Error("Failed to fetch rules");
      return res.json();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/v1/rules/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed to toggle rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/rules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete rule");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-4 border-b border-border bg-card">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Rules</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              AI-generated organization rules that automatically process incoming emails
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={openChat}>
            <MessageCirclePlus className="w-4 h-4 mr-1.5" />
            New Rule
          </Button>
        </div>
      </div>

      <div className="flex-1 px-8 py-6 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Loading rules...</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <AlertCircle className="w-8 h-8 mb-3 opacity-40" />
            <p className="text-sm">Failed to load rules</p>
            <p className="text-xs opacity-60 mt-1">Try refreshing the page</p>
          </div>
        ) : !rules || rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Sparkles className="w-8 h-8 mb-3 opacity-40" />
            <p className="text-sm font-medium">No rules yet</p>
            <p className="text-xs opacity-60 mt-1 max-w-xs text-center">
              Ask the AI assistant to create a rule — try saying "move all invoices from acme.com to the invoices folder"
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-2xl">
            {rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onToggle={() =>
                  toggleMutation.mutate({ id: rule.id, enabled: !rule.enabled })
                }
                onDelete={() => {
                  if (window.confirm(`Delete rule "${rule.name}"?`)) {
                    deleteMutation.mutate(rule.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
