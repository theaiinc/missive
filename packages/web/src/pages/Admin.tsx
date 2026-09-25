import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Users, UsersRound, Plus, Trash2, Link2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useMe } from "@/hooks/useMe";

type Role = "owner" | "moderator" | "member";
type Org = { clientId: string; host: string; appUrl: string; name: string; domains: string[] };
type Person = { id: string; email: string; name?: string; client: string | null; signedIn: boolean; lastLoginAt: string | null; mailboxes: string[] };
type Member = { userId: string; email: string; name?: string; role: Role; mailboxes: string[] };
type Group = { id: string; address: string; domain: string; name?: string; org: string; members: Member[] };
type Overview = { organizations: Org[]; domains: { name: string; org: string }[]; users: Person[]; groups: Group[] };

const ROLES: Role[] = ["owner", "moderator", "member"];
const ROLE_HELP: Record<Role, string> = {
  owner: "Receives the group's mail, can send as the group",
  moderator: "Receives the group's mail, can send as the group",
  member: "Receives the group's mail",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/admin/${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? body.message ?? `Request failed (${res.status})`);
  return body as T;
}

const select = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const label = (p: { email: string; name?: string }) => (p.name ? `${p.name} <${p.email}>` : p.email);

type Section = "organizations" | "users" | "groups";

/** The admin console: organizations and domains, everyone's accounts, and email groups. Admins only. */
export function Admin() {
  const { data: me } = useMe();
  const [section, setSection] = useState<Section>("groups");
  const { data, isLoading, error } = useQuery({ queryKey: ["admin"], queryFn: () => api<Overview>("overview"), enabled: !!me?.isAdmin });

  if (me && !me.isAdmin) {
    return <div className="p-8 text-sm text-muted-foreground">The admin console is for Missive admins.</div>;
  }
  const nav: { id: Section; label: string; icon: React.ElementType; count?: number }[] = [
    { id: "organizations", label: "Organizations", icon: Building2, count: data?.organizations.length },
    { id: "users", label: "Users & mailboxes", icon: Users, count: data?.users.length },
    { id: "groups", label: "Groups", icon: UsersRound, count: data?.groups.length },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 sm:px-8 py-4 border-b border-border bg-card">
        <h2 className="text-lg font-semibold text-foreground">Admin console</h2>
        <p className="text-xs text-muted-foreground">Organizations, accounts, mailboxes and groups across every domain Missive hosts.</p>
      </div>
      <div className="flex-1 flex min-h-0">
        <nav className="w-52 border-r border-border p-3 space-y-1" aria-label="Admin sections">
          {nav.map(({ id, label: text, icon: Icon, count }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-left",
                section === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="w-4 h-4" />
              <span className="flex-1">{text}</span>
              {count != null && <span className="text-[11px] tabular-nums">{count}</span>}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
          {data && section === "organizations" && <Organizations data={data} />}
          {data && section === "users" && <People data={data} />}
          {data && section === "groups" && <Groups data={data} />}
        </div>
      </div>
    </div>
  );
}

function orgName(data: Overview, clientId: string | null) {
  return data.organizations.find((o) => o.clientId === clientId)?.name ?? "—";
}

function Organizations({ data }: { data: Overview }) {
  return (
    <div className="grid gap-4 max-w-3xl">
      {data.organizations.map((o) => (
        <section key={o.clientId} className="border border-border rounded-lg bg-card p-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{o.name}</h3>
            <Badge variant="outline" className="text-[10px]">Aegis client {o.clientId}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            People sign in at <a className="underline" href={o.appUrl} target="_blank" rel="noopener noreferrer">{o.host}</a>
          </p>
          <div className="mt-3 text-sm">
            <span className="text-muted-foreground">Domains: </span>
            {o.domains.length ? o.domains.join(", ") : <span className="text-muted-foreground">none hosted yet</span>}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {data.users.filter((u) => u.client === o.clientId).length} people ·{" "}
            {data.groups.filter((g) => g.org === o.clientId).length} groups
          </div>
        </section>
      ))}
    </div>
  );
}

function People({ data }: { data: Overview }) {
  const [address, setAddress] = useState("");
  const [link, setLink] = useState<{ address: string; url: string; expiresAt: string } | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      api<{ address: string; url: string; expiresAt: string }>("mailbox-invites", { method: "POST", body: JSON.stringify({ address }) }),
    onSuccess: (r) => {
      setLink(r);
      setAddress("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="space-y-6 max-w-5xl">
      <section className="border border-border rounded-lg bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Invite someone to a mailbox</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Reserves the address and gives you a one-time link (valid 7 days). Whoever signs up through it gets that mailbox.
        </p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={`name@${data.domains[0]?.name ?? "example.com"}`} className="max-w-sm" required />
          <Button type="submit" disabled={invite.isPending}>
            <Link2 className="w-4 h-4 mr-1.5" />
            Create link
          </Button>
        </form>
        {link && (
          <div className="mt-3 rounded-md border border-border p-3 text-sm">
            <p>
              Link for <b>{link.address}</b> (expires {new Date(link.expiresAt).toLocaleDateString()}):
            </p>
            <div className="mt-2 flex gap-2 items-center">
              <code className="text-xs break-all flex-1">{link.url}</code>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(link.url).then(() => toast.success("Copied"))}>
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-foreground mb-2">Everyone</h3>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Organization</th>
                <th className="text-left font-medium px-3 py-2">Mailboxes</th>
                <th className="text-left font-medium px-3 py-2">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{u.name ?? u.email}</div>
                    {u.name && <div className="text-xs text-muted-foreground">{u.email}</div>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{orgName(data, u.client)}</td>
                  <td className="px-3 py-2">{u.mailboxes.length ? u.mailboxes.join(", ") : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : u.signedIn ? "—" : "Not signed in yet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Groups({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const [selectedId, setSelectedId] = useState<string | null>(data.groups[0]?.id ?? null);
  const selected = data.groups.find((g) => g.id === selectedId) ?? null;
  const [localPart, setLocalPart] = useState("");
  const [domain, setDomain] = useState(data.domains[0]?.name ?? "");
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => api<{ id: string }>("groups", { method: "POST", body: JSON.stringify({ address: `${localPart}@${domain}`, name }) }),
    onSuccess: async (g) => {
      setLocalPart("");
      setName("");
      await refresh();
      setSelectedId(g.id);
      toast.success("Group created");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="flex gap-6 max-w-6xl">
      <div className="w-72 shrink-0 space-y-4">
        <form
          className="border border-border rounded-lg bg-card p-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <h3 className="text-sm font-semibold text-foreground">New group</h3>
          <div className="flex items-center gap-1">
            <Input value={localPart} onChange={(e) => setLocalPart(e.target.value.toLowerCase())} placeholder="hello" required aria-label="Group address" />
            <span className="text-muted-foreground">@</span>
            <select className={select} value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
              {data.domains.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
          </div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional), e.g. Bugmole" aria-label="Group name" />
          <Button type="submit" size="sm" className="w-full" disabled={create.isPending || !domain}>
            <Plus className="w-4 h-4 mr-1" />
            Create group
          </Button>
        </form>
        <ul className="space-y-1" aria-label="Groups">
          {data.groups.length === 0 && <li className="text-sm text-muted-foreground px-1">No groups yet.</li>}
          {data.groups.map((g) => (
            <li key={g.id}>
              <button
                onClick={() => setSelectedId(g.id)}
                aria-current={g.id === selectedId ? "true" : undefined}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md",
                  g.id === selectedId ? "bg-primary/10 text-primary" : "hover:bg-accent"
                )}
              >
                <div className="text-sm font-medium truncate">{g.address}</div>
                <div className="text-xs text-muted-foreground">
                  {orgName(data, g.org)} · {g.members.length} {g.members.length === 1 ? "member" : "members"}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 min-w-0">{selected ? <GroupDetail data={data} group={selected} onChange={refresh} onDeleted={() => setSelectedId(null)} /> : null}</div>
    </div>
  );
}

function GroupDetail({ data, group, onChange, onDeleted }: { data: Overview; group: Group; onChange: () => Promise<unknown>; onDeleted: () => void }) {
  const candidates = useMemo(() => data.users.filter((u) => !group.members.some((m) => m.userId === u.id)), [data.users, group.members]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<Role>("member");
  const fail = (e: unknown) => toast.error((e as Error).message);

  const setMember = useMutation({
    mutationFn: (v: { userId: string; role: Role }) =>
      api(`groups/${group.id}/members/${v.userId}`, { method: "PUT", body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => {
      setUserId("");
      return onChange();
    },
    onError: fail,
  });
  const removeMember = useMutation({
    mutationFn: (id: string) => api(`groups/${group.id}/members/${id}`, { method: "DELETE" }),
    onSuccess: () => onChange(),
    onError: fail,
  });
  const removeGroup = useMutation({
    mutationFn: () => api(`groups/${group.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      onDeleted();
      await onChange();
      toast.success("Group deleted");
    },
    onError: fail,
  });

  return (
    <section className="border border-border rounded-lg bg-card">
      <div className="p-4 border-b border-border flex items-start gap-3">
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">{group.address}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {group.name ? `${group.name} · ` : ""}
            {orgName(data, group.org)} · Mail sent here goes to every member's inbox.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => confirm(`Delete ${group.address}? Mail to it will no longer be delivered.`) && removeGroup.mutate()}
        >
          <Trash2 className="w-4 h-4 mr-1" />
          Delete group
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-4 py-2">Member</th>
            <th className="text-left font-medium px-4 py-2">Role</th>
            <th className="px-4 py-2"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {group.members.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-3 text-muted-foreground">No members yet: mail to this group isn't delivered anywhere.</td>
            </tr>
          )}
          {group.members.map((m) => (
            <tr key={m.userId} className="border-t border-border">
              <td className="px-4 py-2">
                <div className="font-medium text-foreground">{label(m)}</div>
                {m.mailboxes.length > 0 && <div className="text-xs text-muted-foreground">{m.mailboxes.join(", ")}</div>}
              </td>
              <td className="px-4 py-2">
                <select
                  className={select}
                  value={m.role}
                  onChange={(e) => setMember.mutate({ userId: m.userId, role: e.target.value as Role })}
                  aria-label={`Role for ${m.email}`}
                  title={ROLE_HELP[m.role]}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-2 text-right">
                <Button variant="ghost" size="sm" onClick={() => removeMember.mutate(m.userId)} aria-label={`Remove ${m.email}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        className="p-4 border-t border-border flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (userId) setMember.mutate({ userId, role });
        }}
      >
        <select className={cn(select, "min-w-72")} value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person to add" required>
          <option value="">Add a person…</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {label(u)}
              {u.mailboxes.length ? ` · ${u.mailboxes.join(", ")}` : ""} · {orgName(data, u.client)}
            </option>
          ))}
        </select>
        <select className={select} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          {ROLES.map((r) => (
            <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={!userId || setMember.isPending}>
          <Plus className="w-4 h-4 mr-1" />
          Add
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          Owners and moderators can send as {group.address}; every member receives its mail. People appear here once they've signed in to Missive.
        </p>
      </form>
    </section>
  );
}
