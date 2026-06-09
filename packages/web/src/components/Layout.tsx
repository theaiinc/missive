import { Outlet, NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { Mail, Settings, Inbox as InboxIcon, Archive, FileText, AlertTriangle, UserPlus, LifeBuoy, User, Plus, Moon, Sun } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { Folder } from "@theaiinc/missive-core";
import { useState } from "react";
import { ChatWidget } from "./ChatWidget";
import { Toaster } from "sonner";
import { useNotifications } from "@/hooks/useNotifications";
import { NotificationPanel } from "./NotificationPanel";
import { useTheme } from "@/hooks/useTheme";

const folderIcons: Record<string, React.ElementType> = {
  inbox: InboxIcon,
  archive: Archive,
  "file-text": FileText,
  "alert-triangle": AlertTriangle,
  "user-plus": UserPlus,
  "life-buoy": LifeBuoy,
  user: User,
};

const navItems = [
  { to: "/settings", label: "Settings", icon: Settings },
];

async function fetchFolders(): Promise<Folder[]> {
  const res = await fetch("/api/v1/folders");
  return res.json();
}

export function Layout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeFolder = searchParams.get("folder") ?? "inbox";

  const { data: folders } = useQuery({
    queryKey: ["folders"],
    queryFn: fetchFolders,
  });
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const {
    notifications,
    unreadCount,
    digest,
    digestLoaded,
    markAllRead,
    dismissNotification,
    markRead,
  } = useNotifications();

  const { theme, toggleTheme } = useTheme();

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
        <div className="p-5">
          <button
            onClick={() => navigate("/inbox")}
            className="flex items-center gap-2.5"
          >
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Mail className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground">
                Missive
              </h1>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Communication Intelligence
              </p>
            </div>
          </button>
        </div>

        <Separator />

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
        </nav>

        <Separator />

        <div className="p-3">
          <div className="flex items-center gap-3 px-3 py-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                ST
              </AvatarFallback>
            </Avatar>
            <div className="text-sm leading-tight">
              <p className="font-medium text-foreground">Steve Tran</p>
              <p className="text-xs text-muted-foreground">theaiinc</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {/* Top bar with notification bell */}
        <div className="h-10 border-b border-border bg-card flex items-center justify-end px-4 flex-shrink-0">
          <NotificationPanel
            notifications={notifications}
            unreadCount={unreadCount}
            digest={digest}
            digestLoaded={digestLoaded}
            markAllRead={markAllRead}
            dismissNotification={dismissNotification}
            markRead={markRead}
          />
        </div>
        <div className="flex-1 overflow-hidden">
          <Outlet />
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
