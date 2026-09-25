import { Outlet, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Mail, Settings, Inbox as InboxIcon, Archive, FileText, AlertTriangle, UserPlus, LifeBuoy, User, Plus, Moon, Sun, ScrollText, Send, PenSquare, LogOut, KeyRound, ShieldCheck, ShieldAlert, CalendarDays, Menu, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { Folder } from "@theaiinc/missive-core";
import { useEffect, useRef, useState } from "react";
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
  "shield-alert": ShieldAlert,
};

const navItems = [
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
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

/** One sidebar row: icon and label, or a centred icon in the collapsed rail. */
const navRow = (collapsed: boolean) =>
  cn(
    "flex items-center rounded-md text-sm font-medium transition-colors text-left",
    collapsed ? "w-10 h-9 mx-auto justify-center" : "w-full gap-3 px-3 py-2",
  );

function initials(name: string) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

const COLLAPSED_KEY = "missive.sidebar.collapsed";

/** The desktop sidebar's rail mode: remembered per browser; by default collapsed on tablet widths. */
function useCollapsedSidebar(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      if (stored !== null) return stored === "1";
    } catch { /* storage blocked */ }
    return typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
  });
  const set = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0"); } catch { /* storage blocked */ }
  };
  return [collapsed, set];
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
  // Below md the sidebar is a slide-out menu; it closes on navigation.
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsedPref, setCollapsed] = useCollapsedSidebar();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  // Closes on a click anywhere else, or Escape. (A backdrop can't cover the
  // page from inside the sidebar: its transform makes fixed children local.)
  useEffect(() => {
    if (!accountOpen) return;
    const away = (e: PointerEvent) => { if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAccountOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [accountOpen]);
  // The phone menu is always the full sidebar; the rail is for md and up.
  const collapsed = collapsedPref && !menuOpen;
  const location = useLocation();
  const onInbox = location.pathname === "/inbox";
  useEffect(() => { setMenuOpen(false); setAccountOpen(false); }, [location.pathname, location.search]);
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
      <div className="flex h-dvh bg-background">
        {menuOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
        {/* Sidebar */}
        <aside
          id="sidebar"
          aria-label="Navigation"
          className={cn(
            "border-r border-border bg-card flex flex-col shrink-0 fixed inset-y-0 left-0 z-50 transition-[transform,width] duration-200 md:static md:translate-x-0",
            collapsed ? "w-[3.75rem]" : "w-64 max-w-[85vw] md:w-56",
            menuOpen ? "translate-x-0" : "-translate-x-full invisible md:visible",
          )}
        >
        <div className={cn("flex items-center h-14 shrink-0", collapsed ? "justify-center px-2" : "justify-between pl-4 pr-2")}>
          {collapsed ? (
            <button
              onClick={() => setCollapsed(false)}
              className="w-10 h-10 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Expand menu"
              aria-label="Expand menu"
            >
              <PanelLeftOpen className="w-5 h-5" />
            </button>
          ) : (
          <button
            onClick={() => navigate("/inbox")}
            className="flex items-center gap-2.5 min-w-0"
            title="Missive"
            aria-label="Missive inbox"
          >
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <Mail className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground truncate">Missive</span>
          </button>
          )}
          {!collapsed && (
            <>
              <button
                onClick={() => setCollapsed(true)}
                className="hidden md:inline-flex p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Collapse menu"
                aria-label="Collapse menu"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
              <button
                onClick={() => setMenuOpen(false)}
                className="md:hidden p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        <Separator />

        {me && me.mailboxes.some(canSendAs) && (
          <div className={cn("pt-2", collapsed ? "px-2 flex justify-center" : "px-3 pt-3")}>
            <button
              onClick={() => compose()}
              title="Compose"
              aria-label="Compose"
              className={cn(
                "flex items-center justify-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors",
                collapsed ? "w-10 h-10" : "w-full px-3 py-2",
              )}
            >
              <PenSquare className="w-4 h-4 shrink-0" />
              {!collapsed && "Compose"}
            </button>
          </div>
        )}

        <nav className={cn("flex-1 overflow-y-auto overflow-x-hidden", collapsed ? "p-2 space-y-0.5" : "p-3 space-y-1")}>
          {/* Folder list — first item is the inbox folder */}
          {folders?.map((folder) => {
            const Icon = folderIcons[folder.icon ?? ""] ?? InboxIcon;
            const isActive = onInbox && activeFolder === folder.slug;
            const count = folder.missiveCount != null && folder.missiveCount > 0 ? folder.missiveCount : null;
            return (
              <button
                key={folder.slug}
                onClick={() => navigate(`/inbox?folder=${folder.slug}`)}
                title={collapsed ? `${folder.name}${count ? ` (${count})` : ""}` : undefined}
                aria-label={collapsed ? folder.name : undefined}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  navRow(collapsed),
                  isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span className="relative shrink-0">
                  <Icon className="w-4 h-4" />
                  {collapsed && count && (
                    <span className="absolute -top-1.5 -right-2 min-w-[1rem] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] leading-4 text-center tabular-nums">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </span>
                {!collapsed && <span className="flex-1 truncate">{folder.name}</span>}
                {!collapsed && count && (
                  <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{count}</span>
                )}
              </button>
            );
          })}

          {/* New folder inline input */}
          {showNewFolder && !collapsed ? (
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
            onClick={() => { setCollapsed(false); setShowNewFolder(true); }}
            title={collapsed ? "New folder" : undefined}
            aria-label={collapsed ? "New folder" : undefined}
            className={cn(navRow(collapsed), "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}
          >
            <Plus className="w-4 h-4 shrink-0" />
            {!collapsed && <span>New Folder</span>}
          </button>

          <Separator className={collapsed ? "my-2" : "my-3"} />

          <button
            onClick={toggleTheme}
            title={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}
            aria-label={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}
            className={cn(navRow(collapsed), "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}
          >
            {theme === "dark" ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
            {!collapsed && <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>}
          </button>

          {[...navItems, ...(me?.isAdmin ? [{ to: "/admin", label: "Admin console", icon: ShieldCheck }] : [])].map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                aria-label={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  cn(navRow(collapsed), isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <Separator />

        <div className={cn(collapsed ? "py-3 px-2" : "p-3")}>
          {collapsed ? (
            <div ref={accountRef} className="relative flex justify-center">
              <button
                onClick={() => setAccountOpen((o) => !o)}
                title={me ? `${me.name ?? me.email}: account and sign out` : "Account"}
                aria-label="Account menu"
                aria-expanded={accountOpen}
                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    {me ? initials(me.name ?? me.email) : ""}
                  </AvatarFallback>
                </Avatar>
              </button>
              {accountOpen && (
                <>
                  <div role="menu" className="absolute left-full bottom-0 ml-2 z-50 w-60 rounded-lg border border-border bg-popover shadow-xl py-1 text-sm">
                    <div className="px-3 py-2 border-b border-border">
                      <p className="font-medium text-foreground truncate">{me?.name ?? me?.email ?? ""}</p>
                      <p className="text-xs text-muted-foreground truncate">{me?.mailboxes.find((m) => m.kind !== "group")?.address ?? me?.email ?? ""}</p>
                    </div>
                    {me?.accountUrl && (
                      <a href={me.accountUrl} target="_blank" rel="noopener noreferrer" onClick={() => setAccountOpen(false)} className="flex items-center gap-2 px-3 py-2 text-foreground hover:bg-accent">
                        <KeyRound className="w-4 h-4" /> Account &amp; security
                      </a>
                    )}
                    <a href="/auth/logout" className="flex items-center gap-2 px-3 py-2 text-foreground hover:bg-accent">
                      <LogOut className="w-4 h-4" /> Sign out
                    </a>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  {me ? initials(me.name ?? me.email) : ""}
                </AvatarFallback>
              </Avatar>
              <div className="text-sm leading-tight min-w-0 flex-1">
                <p className="font-medium text-foreground truncate">{me?.name ?? me?.email ?? ""}</p>
                <p className="text-xs text-muted-foreground truncate">{me?.mailboxes.find((m) => m.kind !== "group")?.address ?? me?.email ?? ""}</p>
              </div>
              {me?.accountUrl && (
                <a href={me.accountUrl} target="_blank" rel="noopener noreferrer" title="Account & security: password, passkeys" aria-label="Account and security" className="p-1 rounded-md text-muted-foreground hover:text-foreground shrink-0">
                  <KeyRound className="w-4 h-4" />
                </a>
              )}
              <a href="/auth/logout" title="Sign out" aria-label="Sign out" className="p-1 rounded-md text-muted-foreground hover:text-foreground shrink-0">
                <LogOut className="w-4 h-4" />
              </a>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col relative">
        <div className="md:hidden flex items-center gap-2 h-12 px-2 border-b border-border bg-card shrink-0 pt-[env(safe-area-inset-top)]">
          <button onClick={() => setMenuOpen((o) => !o)} className="p-2 text-muted-foreground hover:text-foreground" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="sidebar">
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center"><Mail className="w-3.5 h-3.5 text-primary-foreground" /></div>
          <span className="text-sm font-semibold">Missive</span>
        </div>
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
