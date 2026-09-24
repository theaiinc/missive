import { Outlet, NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { Mail, Settings, Inbox as InboxIcon, Archive, FileText, AlertTriangle, UserPlus, LifeBuoy, User, Plus, Moon, Sun, ScrollText, Send, PenSquare, LogOut, KeyRound, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { Folder } from "@theaiinc/missive-core";
import { useState } from "react";
import { ChatWidget } from "./ChatWidget";
import { Toaster } from "sonner";
import { useTheme } from "@/hooks/useTheme";
import { useOrganizerStatus } from "@/hooks/useOrganizerStatus";
import { useSystemEventPoller } from "@/hooks/useSystemEventPoller";
import { canSendAs, useMe } from "@/hooks/useMe";
import { ClaimMailbox } from "@/components/ClaimMailbox";
import { ComposeProvider, useCompose } from "./Compose";

const folderIcons: Record<string, React.ElementType> = {
  inbox: InboxIcon,
  archive: Archive,
  "file-text": FileText,
  "alert-triangle": AlertTriangle,
  "user-plus": UserPlus,
  "life-buoy": LifeBuoy,
  user: User,
  send: Send,
};

const navItems = [
  { to: "/rules", label: "Rules", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

async function fetchFolders(): Promise<Folder[]> {
  const res = await fetch("/api/v1/folders");
  return res.json();
}

export function Layout() {
  return (
    <ComposeProvider>
      <LayoutShell />
    </ComposeProvider>
  );
}

function initials(name: string) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

function LayoutShell() {
  const { data: me } = useMe();
  const compose = useCompose();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeFolder = searchParams.get("folder") ?? "inbox";

  const { data: folders } = useQuery({
    queryKey: ["folders"],
    queryFn: fetchFolders,
  });
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const { theme, toggleTheme } = useTheme();
  const organizerRunning = useOrganizerStatus();
  useSystemEventPoller();

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    const slug = newFolderName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug) return;
    await fetch("/api/v1/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newFolderName, slug }),
    });
    setNewFolderName("");
    setShowNewFolder(false);
    // Reload to refetch folders
    window.location.reload();
  };

  return (
      <div className="flex h-screen bg-background">
        {/* Sidebar */}
        <aside className="w-56 border-r border-border bg-card flex flex-col">
        <div className="px-5 py-4">
          <button
            onClick={() => navigate("/inbox")}
            className="flex items-center gap-2.5"
          >
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Mail className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-foreground">
                Missive
              </h1>
            </div>
          </button>
        </div>

        <Separator />

        {me && me.mailboxes.some(canSendAs) && (
          <div className="px-3 pt-3">
            <button
              onClick={() => compose()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <PenSquare className="w-4 h-4" />
              Compose
            </button>
          </div>
        )}

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {/* Folder list — first item is the inbox folder */}
          {folders?.map((folder) => {
            const Icon = folderIcons[folder.icon ?? ""] ?? InboxIcon;
            const isActive = activeFolder === folder.slug;
            return (
              <button
                key={folder.slug}
                onClick={() => navigate(`/inbox?folder=${folder.slug}`)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon className="w-4 h-4" />
                <span className="flex-1 truncate">{folder.name}</span>
                {folder.missiveCount != null && folder.missiveCount > 0 && (
                  <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                    {folder.missiveCount}
                  </span>
                )}
              </button>
            );
          })}

          {/* New folder inline input */}
          {showNewFolder ? (
            <div className="px-2 pt-1">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") setShowNewFolder(false);
                }}
                placeholder="Folder name..."
                className="w-full px-2 py-1 text-xs rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          ) : null}

          {/* Add folder button */}
          <button
            onClick={() => setShowNewFolder(true)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>New Folder</span>
          </button>

          <Separator className="my-3" />

          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            {theme === "dark" ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>

          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )
                }
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </NavLink>
            );
          })}
          {me?.isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )
              }
            >
              <ShieldCheck className="w-4 h-4" />
              Admin console
            </NavLink>
          )}
        </nav>

        <Separator />

        <div className="p-3">
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                {me ? initials(me.name ?? me.email) : ""}
              </AvatarFallback>
            </Avatar>
            <div className="text-sm leading-tight min-w-0 flex-1">
              <p className="font-medium text-foreground truncate">{me?.name ?? me?.email ?? ""}</p>
              <p className="text-xs text-muted-foreground truncate">{me?.mailboxes.find((m) => m.kind !== "group")?.address ?? me?.email ?? ""}</p>
            </div>
            {me?.accountUrl && (
              <a href={me.accountUrl} target="_blank" rel="noopener noreferrer" title="Account & security: password, passkeys" aria-label="Account and security" className="text-muted-foreground hover:text-foreground">
                <KeyRound className="w-4 h-4" />
              </a>
            )}
            <a href="/auth/logout" title="Sign out" aria-label="Sign out" className="text-muted-foreground hover:text-foreground">
              <LogOut className="w-4 h-4" />
            </a>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-hidden flex flex-col relative">
        {/* Organizer activity indicator */}
        {organizerRunning && (
          <div className="absolute top-0 left-0 right-0 z-50 h-[2px] overflow-hidden">
            <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-primary to-transparent animate-pulse" />
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          {/* A blank account's first visit: pick the hosted mailbox address first. */}
          {me?.mailboxOffer ? <ClaimMailbox domain={me.mailboxOffer.domain} /> : <Outlet />}
        </div>
      </main>

      {/* Floating AI Chat */}
      <ChatWidget />

      {/* Toast notifications */}
      <Toaster
        position="bottom-left"
        theme={theme === "dark" ? "dark" : "light"}
        toastOptions={{
          style: { fontSize: "13px" },
          duration: 5000,
        }}
      />
    </div>
  );
}
