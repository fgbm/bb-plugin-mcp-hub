// MCP Hub page: edit the host and project hub files, set secret values, and
// write the generated harness files without touching a text editor.
//
// The page never lists a value from mcp.local.json in the overview: it carries
// names, sources and usage, and asks for one value with `revealVar` when the user
// opens that secret.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { HubServer } from "./contract";
import {
  MODELLED_KEYS,
  isRecord,
  referencedVars,
  serverEntries,
  serverFromEntry,
  splitCommand,
} from "./shared";
import type { Overview, ProjectSources, uiContract } from "./rpc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Scope = "host" | "project";
type Transport = "remote" | "local";

/** The MCP mark, same artwork as assets/mcp.svg (Simple Icons, CC0). */
const MCP_MARK_PATH =
  "M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245";

function McpMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-2 -2 28 28"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={MCP_MARK_PATH} />
    </svg>
  );
}

interface Draft {
  scope: Scope;
  /** Scope the entry is stored in now; a change moves it between files. */
  previousScope: Scope;
  previousName: string | null;
  name: string;
  transport: Transport;
  url: string;
  /** Remote harnesses distinguish streamable HTTP from SSE. */
  remoteType: "http" | "sse";
  headers: Pair[];
  command: string;
  args: string;
  env: Pair[];
  enabled: boolean;
  /** Harness options MCP Hub passes through but does not edit as fields. */
  advanced: string;
  /** Values for `${VAR}` references, written to mcp.local.json with the server. */
  secrets: Record<string, string>;
}

/** One editable `key`/`value` row for headers or environment variables. */
interface Pair {
  key: string;
  value: string;
}

function extrasText(server: HubServer | null): string {
  if (server === null) return "";
  const extras = Object.fromEntries(
    Object.entries(server).filter(([key]) => !MODELLED_KEYS.has(key)),
  );
  return Object.keys(extras).length === 0 ? "" : JSON.stringify(extras, null, 2);
}

/** Parsed advanced JSON, `{}` when empty, null when it is not an object. */
function parseExtras(text: string): Record<string, unknown> | null {
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function draftFor(scope: Scope, name: string | null, server: HubServer | null): Draft {
  return {
    scope,
    previousScope: scope,
    previousName: name,
    name: name ?? "",
    transport: server?.url === undefined ? "local" : "remote",
    url: server?.url ?? "",
    remoteType: server?.type === "sse" ? "sse" : "http",
    headers: pairsToRows(server?.headers),
    command: server?.command ?? "",
    args: (server?.args ?? []).join("\n"),
    env: pairsToRows(server?.env),
    enabled: server?.enabled !== false,
    advanced: extrasText(server),
    secrets: {},
  };
}

/** Rows for one map; empty when the server has no names. */
function pairsToRows(pairs: Record<string, string> | undefined): Pair[] {
  return Object.entries(pairs ?? {}).map(([key, value]) => ({ key, value }));
}

/** Rows become an object; a row without a name is ignored. */
function rowsToPairs(rows: Pair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    out[key] = row.value.trim();
  }
  return out;
}

/** Keep row order, let a pasted value win over the same name. */
function mergeRows(rows: Pair[], incoming: Record<string, string>): Pair[] {
  const merged = new Map<string, string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== "") merged.set(key, row.value);
  }
  for (const [key, value] of Object.entries(incoming)) merged.set(key, value);
  return [...merged.entries()].map(([key, value]) => ({ key, value }));
}

/** `.env` text: `export` prefixes, comments and quotes are tolerated. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^export\s+/u, "");
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/gu, "");
    if (key !== "") out[key] = value;
  }
  return out;
}

/** Request headers pasted as `Key: Value`, `Key=Value` or `Key Value`. */
function parseHeaderText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^([^:=]+)[:=]\s*(.+)$/u.exec(trimmed);
    if (match === null) {
      const [key, ...rest] = trimmed.split(/\s+/u);
      if (rest.length > 0) out[key] = rest.join(" ");
      continue;
    }
    out[match[1].trim()] = match[2].trim();
  }
  return out;
}

/** A pasted snippet: a named map, or one bare server worth filling the form with. */
function snippetEntries(json: unknown): Record<string, unknown> | null {
  const found = serverEntries("auto", json);
  if (found !== null) return found;
  return isRecord(json) && (typeof json.url === "string" || json.command !== undefined)
    ? { "new-mcp-server": json }
    : null;
}

function draftFromSnippet(name: string, raw: unknown, scope: Scope): Draft {
  const draft = draftFor(scope, name, serverFromEntry(raw, { splitCommand: true }));
  return { ...draft, previousName: null, secrets: {} };
}

function draftToServer(draft: Draft): HubServer {
  const server: HubServer = {};
  if (draft.transport === "remote") {
    server.url = draft.url.trim();
    if (draft.remoteType === "sse") server.type = "sse";
    const headers = rowsToPairs(draft.headers);
    if (Object.keys(headers).length > 0) server.headers = headers;
  } else {
    server.command = draft.command.trim();
    const args = draft.args
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (args.length > 0) server.args = args;
    const env = rowsToPairs(draft.env);
    if (Object.keys(env).length > 0) server.env = env;
  }
  if (!draft.enabled) server.enabled = false;
  const extras = Object.fromEntries(
    Object.entries(parseExtras(draft.advanced) ?? {}).filter(
      ([key]) => !MODELLED_KEYS.has(key),
    ),
  );
  return { ...extras, ...server };
}

/** A row name that appears twice; the second row would silently win. */
function duplicateKey(rows: Pair[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

function draftProblem(draft: Draft): string | null {
  if (draft.name.trim() === "") return "The server needs a name.";
  if (!/^[A-Za-z0-9._-]+$/u.test(draft.name.trim())) {
    return "Use letters, digits, dot, dash or underscore in the name.";
  }
  if (draft.transport === "remote" && draft.url.trim() === "") {
    return "A remote server needs a URL.";
  }
  if (draft.transport === "local" && draft.command.trim() === "") {
    return "A command server needs a command.";
  }
  const duplicate =
    draft.transport === "remote"
      ? duplicateKey(draft.headers)
      : duplicateKey(draft.env);
  if (duplicate !== null) {
    return `"${duplicate}" appears twice.`;
  }
  if (parseExtras(draft.advanced) === null) {
    return "Advanced options must be a JSON object.";
  }
  return null;
}

/** `${VAR}` names the draft references, wherever they appear. */
function draftVars(draft: Draft): string[] {
  return referencedVars(draftToServer(draft)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function describeServer(server: HubServer): string {
  if (server.url !== undefined) return server.url;
  return [server.command ?? "", ...(server.args ?? [])].join(" ");
}

function summarize(results: Array<{ status: string }>): string {
  const written = results.filter((result) => result.status === "written").length;
  const removed = results.filter((result) => result.status === "removed").length;
  const foreign = results.filter((result) => result.status === "foreign").length;
  const parts = [`${String(written)} written`];
  if (removed > 0) parts.push(`${String(removed)} removed`);
  if (foreign > 0) parts.push(`${String(foreign)} left alone (foreign)`);
  return parts.join(", ");
}

function ScopeTabs({
  value,
  onChange,
  counts,
}: {
  value: Scope;
  onChange: (scope: Scope) => void;
  counts: Record<Scope, number>;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as Scope)}>
      <TabsList>
        <TabsTrigger value="host">
          Host
          <span className="ml-1.5 text-xs text-muted-foreground">{counts.host}</span>
        </TabsTrigger>
        <TabsTrigger value="project">
          Project
          <span className="ml-1.5 text-xs text-muted-foreground">{counts.project}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function ServerIdentity({
  name,
  scope,
  enabled,
  busy,
  onToggle,
  nameClassName,
}: {
  name: string;
  scope: Scope;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
  nameClassName?: string;
}) {
  return (
    <>
      <Switch
        checked={enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`${enabled ? "Disable" : "Enable"} ${name}`}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          nameClassName,
          !enabled && "text-muted-foreground line-through",
        )}
      >
        {name}
      </span>
      <Badge variant="outline">{scope}</Badge>
    </>
  );
}

function ServerRow({
  entry,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  entry: Overview["servers"][number];
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-center gap-2">
        <ServerIdentity
          name={entry.name}
          scope={entry.scope}
          enabled={entry.enabled}
          busy={busy}
          onToggle={onToggle}
          nameClassName="text-sm font-medium"
        />
        <span className="text-xs text-muted-foreground">
          {entry.server.url === undefined ? "command" : "remote"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
          {confirming ? (
            <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
              Delete
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${entry.name}`}
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              <Icon name="Trash2" className="size-4" />
            </Button>
          )}
        </span>
      </div>
      <code className="truncate text-xs text-muted-foreground">{describeServer(entry.server)}</code>
      <p className="text-xs text-muted-foreground">
        {entry.enabled
          ? entry.materialized.length === 0
            ? "Not written anywhere: no enabled harness takes it here."
            : `→ ${entry.materialized.join(", ")}`
          : "Disabled: removed from every generated file."}
      </p>
      {entry.collisions.length > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Also configured in {entry.collisions.join(", ")} — check which definition
          the harness reads.
        </p>
      ) : null}
    </li>
  );
}

async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    toast.error("Clipboard is not available here.");
    return null;
  }
}

function ServerImportDialog({
  scope,
  onImport,
  onClose,
}: {
  scope: Scope;
  onImport: (draft: Draft) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parse = () => {
    try {
      const found = snippetEntries(JSON.parse(text) as unknown);
      if (found === null || Object.keys(found).length === 0) {
        throw new Error("No MCP servers in that JSON.");
      }
      setEntries(found);
      setSelected(Object.keys(found)[0]);
      setError(null);
    } catch (cause) {
      setEntries(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const names = entries === null ? [] : Object.keys(entries);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import JSON snippet</DialogTitle>
          <DialogDescription>
            Paste a full MCP snippet from docs or another config. The parsed values
            fill the form for review before saving.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            placeholder={'{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"] } } }'}
            className="font-mono text-xs"
          />
          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {names.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label>Server</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {names.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              void readClipboard().then((value) => {
                if (value !== null) setText(value);
              });
            }}
          >
            Paste from clipboard
          </Button>
          {entries === null ? (
            <Button onClick={parse} disabled={text.trim() === ""}>
              Parse
            </Button>
          ) : (
            <Button
              onClick={() => {
                onImport(draftFromSnippet(selected, entries[selected], scope));
                onClose();
              }}
            >
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Servers already configured by the project's own harness files. */
function ProjectImportDialog({
  hostId,
  projectId,
  overview,
  onImport,
  onClose,
}: {
  hostId: string | null;
  projectId: string | null;
  overview: Overview | null;
  onImport: (entries: Array<{ name: string; server: HubServer }>) => Promise<void>;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof uiContract>();
  const [sources, setSources] = useState<ProjectSources | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    void rpc
      .call("projectSources", { hostId, projectId })
      .then((found) => {
        if (!active) return;
        setSources(found);
        setSelected(
          new Set(
            found.files.flatMap((file) =>
              file.servers.map((server) => `${file.path}\u0000${server.name}`),
            ),
          ),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [hostId, projectId, rpc]);

  const hubNames = new Set(
    (overview?.servers ?? [])
      .filter((entry) => entry.scope === "project")
      .map((entry) => entry.name),
  );
  const entries =
    sources?.files.flatMap((file) =>
      file.servers
        .filter((server) => selected.has(`${file.path}\u0000${server.name}`))
        .map((server) => ({ name: server.name, server: server.server })),
    ) ?? [];

  /** Header/env values that look like a literal token rather than a `${VAR}`. */
  const literalSecrets = entries.flatMap((entry) =>
    [
      ...Object.entries(entry.server.headers ?? {}),
      ...Object.entries(entry.server.env ?? {}),
    ].filter(
      ([key, value]) =>
        /token|key|secret|pass|auth/iu.test(key) &&
        value !== "" &&
        !value.includes("${"),
    ),
  );

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    setWorking(true);
    setError(null);
    try {
      await onImport(entries);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from project files</DialogTitle>
          <DialogDescription>
            Servers this project already configures for another harness. Imported
            entries are written to &lt;repo&gt;/.bb/mcp.json and replace the same
            names there.
          </DialogDescription>
          {sources?.files.some((file) => file.kind === "opencode") ? (
            <p className="text-xs text-muted-foreground">
              OpenCode reads its project opencode.json before MCP Hub&apos;s generated
              file, so entries left there keep precedence.
            </p>
          ) : null}
        </DialogHeader>
        {literalSecrets.length > 0 ? (
          <p
            role="status"
            className="text-xs text-amber-600 dark:text-amber-500"
          >
            {literalSecrets.length} selected values look like secrets and are
            copied verbatim into <code>&lt;repo&gt;/.bb/mcp.json</code>. Replace
            them with <code>${"{VAR}"}</code> if that file is committed.
          </p>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {sources === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Reading files…</p>
        ) : sources.files.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No MCP configuration found in this project.
          </p>
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto pr-1">
            {sources.files.map((file) => (
              <div key={file.path} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 truncate text-xs">{file.path}</code>
                  <Badge variant="outline">{file.kind}</Badge>
                </div>
                {file.error === null ? null : (
                  <p className="text-xs text-destructive">{file.error}</p>
                )}
                {file.servers.map((server) => {
                  const key = `${file.path}\u0000${server.name}`;
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
                    >
                      <Switch
                        checked={selected.has(key)}
                        onCheckedChange={() => toggle(key)}
                        aria-label={`Import ${server.name}`}
                      />
                      <span className="shrink-0 text-xs font-medium">{server.name}</span>
                      <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {describeServer(server.server)}
                      </code>
                      {hubNames.has(server.name) ? (
                        <Badge variant="outline">replaces</Badge>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button disabled={working || entries.length === 0} onClick={() => void submit()}>
            {working ? "Importing…" : `Import ${String(entries.length)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Key/value rows for headers and environment variables. */
function PairEditor({
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel,
  onChange,
}: {
  rows: Pair[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  removeLabel: string;
  onChange: (rows: Pair[]) => void;
}) {
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(
      rows.map((row, position) =>
        position === index ? { ...row, ...patch } : row,
      ),
    );
  const remove = (index: number) => {
    onChange(rows.filter((_, position) => position !== index));
  };
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.key}
            placeholder={keyPlaceholder}
            aria-label={`${addLabel} name ${String(index + 1)}`}
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-40 shrink-0 font-mono text-xs"
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input
            value={row.value}
            placeholder={valuePlaceholder}
            aria-label={`${addLabel} value ${String(index + 1)}`}
            autoComplete="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`${removeLabel} ${String(index + 1)}`}
            onClick={() => remove(index)}
          >
            <Icon name="Trash2" className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Icon name="Plus" className="size-4" />
        {addLabel}
      </Button>
    </div>
  );
}

function ServerEditor({
  draft,
  overview,
  projectAvailable,
  projectName,
  onDraft,
  onSave,
  onClose,
  saving,
  problem,
}: {
  draft: Draft | null;
  overview: Overview | null;
  projectAvailable: boolean;
  projectName: string | null;
  onDraft: (next: Draft) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  problem: string | null;
}) {
  const [importing, setImporting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  if (draft === null) return null;
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });
  const refs = draftVars(draft);
  const projectLabel = projectName ?? "this project";

  const pasteCommand = async () => {
    const text = await readClipboard();
    if (text === null) return;
    const argv = splitCommand(text.trim());
    if (argv.length === 0) return;
    set({ command: argv[0], args: argv.slice(1).join("\n") });
  };

  const pasteEnv = async () => {
    const text = await readClipboard();
    if (text !== null) set({ env: mergeRows(draft.env, parseDotenv(text)) });
  };

  const pasteHeaders = async () => {
    const text = await readClipboard();
    if (text !== null) set({ headers: mergeRows(draft.headers, parseHeaderText(text)) });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4 pr-6">
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle>
                {draft.previousName === null ? "Add server" : `Edit ${draft.previousName}`}
              </DialogTitle>
              <DialogDescription>
                Use <code>${"{VAR}"}</code> for values that live in mcp.local.json.
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-1">
              <Switch
                id="mcp-server-enabled"
                checked={draft.enabled}
                onCheckedChange={(checked) => set({ enabled: checked })}
              />
              <Label htmlFor="mcp-server-enabled">Enabled</Label>
            </div>
          </div>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="mcp-server-name">Name</Label>
              <Input
                id="mcp-server-name"
                value={draft.name}
                autoFocus
                onChange={(event) => set({ name: event.target.value })}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
              <Icon name="FileText" className="size-4" />
              Import JSON
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              value={draft.transport}
              onValueChange={(next) => set({ transport: next as Transport })}
            >
              <TabsList>
                <TabsTrigger value="remote">Remote</TabsTrigger>
                <TabsTrigger value="local">Command</TabsTrigger>
              </TabsList>
            </Tabs>
            <Select
              value={draft.scope}
              onValueChange={(next) => set({ scope: next as Scope })}
            >
              <SelectTrigger className="ml-auto h-8 w-52" aria-label="Scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="host">Available in every project</SelectItem>
                <SelectItem value="project" disabled={!projectAvailable}>
                  Only {projectLabel}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.previousName !== null && draft.previousScope !== draft.scope ? (
            <p className="text-xs text-muted-foreground">
              Saving moves this server{" "}
              {draft.scope === "project" ? `to ${projectLabel}` : "to the host file"}.
            </p>
          ) : null}
          {draft.transport === "remote" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="mcp-server-url">URL</Label>
                  <Select
                    value={draft.remoteType}
                    onValueChange={(next) =>
                      set({ remoteType: next as Draft["remoteType"] })
                    }
                  >
                    <SelectTrigger className="h-8 w-28" aria-label="Remote transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  id="mcp-server-url"
                  value={draft.url}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(event) => set({ url: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label>Request headers</Label>
                  <Button variant="ghost" size="sm" onClick={() => void pasteHeaders()}>
                    Paste headers
                  </Button>
                </div>
                <PairEditor
                  rows={draft.headers}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer ${TOKEN}"
                  addLabel="Add header"
                  removeLabel="Remove header"
                  onChange={(headers) => set({ headers })}
                />
                <p className="text-xs text-muted-foreground">
                  Use <code>${"{VAR}"}</code> for values that live in mcp.local.json.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="mcp-server-command">Command</Label>
                  <Button variant="ghost" size="sm" onClick={() => void pasteCommand()}>
                    Paste whole command
                  </Button>
                </div>
                <Input
                  id="mcp-server-command"
                  value={draft.command}
                  placeholder="npx"
                  onChange={(event) => set({ command: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-server-args">Arguments, one per line</Label>
                <Textarea
                  id="mcp-server-args"
                  value={draft.args}
                  onChange={(event) => set({ args: event.target.value })}
                  rows={3}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label>Environment variables</Label>
                  <Button variant="ghost" size="sm" onClick={() => void pasteEnv()}>
                    Paste .env
                  </Button>
                </div>
                <PairEditor
                  rows={draft.env}
                  keyPlaceholder="API_KEY"
                  valuePlaceholder="${API_KEY}"
                  addLabel="Add variable"
                  removeLabel="Remove variable"
                  onChange={(env) => set({ env })}
                />
                <p className="text-xs text-muted-foreground">
                  Use <code>${"{VAR}"}</code> for values that live in mcp.local.json.
                </p>
              </div>
            </>
          )}
          {refs.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <Label>Values</Label>
              <p className="text-xs text-muted-foreground">
                Stored in{" "}
                {draft.scope === "host"
                  ? "~/.bb/mcp.local.json"
                  : "<repo>/.bb/mcp.local.json"}{" "}
                with the server. Leave a field empty to keep the stored value.
              </p>
              {refs.map((name) => {
                const state = overview?.vars.find((item) => item.name === name);
                const where =
                  state === undefined || !state.resolved
                    ? "missing"
                    : state[draft.scope]
                      ? "set here"
                      : state.host
                        ? "set in host"
                        : state.project
                          ? "set in project"
                          : "from environment";
                return (
                  <div key={name} className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate text-xs">{name}</code>
                    <span className="shrink-0 text-xs text-muted-foreground">{where}</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label={`Value for ${name}`}
                      value={draft.secrets[name] ?? ""}
                      onChange={(event) =>
                        set({ secrets: { ...draft.secrets, [name]: event.target.value } })
                      }
                      placeholder={state?.resolved ? "keep" : "value"}
                      className="h-8 w-40 text-xs"
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {advancedOpen ? "Hide advanced options" : "Advanced options"}
            </Button>
            {advancedOpen ? (
              <>
                <Textarea
                  value={draft.advanced}
                  onChange={(event) => set({ advanced: event.target.value })}
                  rows={4}
                  placeholder={'{ "timeout": 60000 }'}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Passed to the harness untouched; MCP Hub does not interpret these.
                </p>
              </>
            ) : null}
          </div>
          {problem === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || problem !== null}>
            {saving ? "Saving…" : "Save and apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
      {importing ? (
        <ServerImportDialog
          scope={draft.scope}
          onImport={(next) => {
            onDraft({
              ...next,
              previousName: draft.previousName,
              previousScope: draft.previousScope,
            });
            setImporting(false);
          }}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </Dialog>
  );
}

function useMcpOverview(hostId: string | null, projectId: string | null) {
  const rpc = useRpc<typeof uiContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    toast.error(message);
  }, []);
  const reload = useCallback(async () => {
    try {
      setOverview(await rpc.call("overview", { hostId, projectId }));
      setError(null);
    } catch (cause) {
      report(cause);
    }
  }, [hostId, projectId, report, rpc]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // A change made from the composer menu or another window lands here too.
  useRealtime("mcp-hub/changed", () => {
    void reload();
  });
  return { overview, error, reload, report };
}

/** Harness configs the selected project already has, for the import banner. */
function useProjectSources(hostId: string | null, projectId: string | null) {
  const rpc = useRpc<typeof uiContract>();
  const [sources, setSources] = useState<ProjectSources | null>(null);
  useEffect(() => {
    if (projectId === null) {
      setSources(null);
      return;
    }
    let active = true;
    void rpc
      .call("projectSources", { hostId, projectId })
      .then((found) => {
        if (active) setSources(found);
      })
      .catch(() => {
        if (active) setSources(null);
      });
    return () => {
      active = false;
    };
  }, [hostId, projectId, rpc]);
  return sources;
}

function PageHeader({
  overview,
  hostId,
  projectId,
  busy,
  onHost,
  onProject,
  onApply,
}: {
  overview: Overview | null;
  hostId: string | null;
  projectId: string | null;
  busy: boolean;
  onHost: (hostId: string) => void;
  onProject: (projectId: string | null) => void;
  onApply: () => void;
}) {
  const choices = overview?.projects.filter((project) => project.path !== null) ?? [];
  const hosts = overview?.hosts ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">MCP servers</h1>
        <span className="ml-auto flex items-center gap-2">
          <Select
            value={overview?.hostId ?? hostId ?? ""}
            onValueChange={onHost}
          >
            <SelectTrigger className="h-8 w-44" aria-label="Host">
              <SelectValue placeholder="Host" />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.name}
                  {host.status === "connected" ? "" : ` (${host.status})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={projectId ?? "none"}
            onValueChange={(next) => onProject(next === "none" ? null : next)}
          >
            <SelectTrigger className="h-8 w-56" aria-label="Project">
              <SelectValue placeholder="No project (host only)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No project (host only)</SelectItem>
              {choices.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="secondary" size="sm" onClick={onApply} disabled={busy}>
            <Icon name="RefreshCw" className="size-4" />
            Apply all
          </Button>
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {overview?.hostName ?? "resolving host…"}
        {projectId === null
          ? " · host scope: written for every project on this host."
          : overview?.projectPath === null
            ? " · this host has no checkout of the selected project."
            : ` · project scope: ${overview?.projectPath ?? ""}`}
      </p>
    </>
  );
}

function UnresolvedNotice({ unresolved }: { unresolved: string[] }) {
  if (unresolved.length === 0) return null;
  return (
    <Alert className="mt-3">
      <Icon name="AlertTriangle" className="size-4" />
      <AlertTitle>Missing values</AlertTitle>
      <AlertDescription>
        No value for {unresolved.join(", ")} — those servers keep the literal reference.
        Set it under Secrets.
      </AlertDescription>
    </Alert>
  );
}

function ServersSection({
  overview,
  scope,
  servers,
  counts,
  busy,
  onScope,
  onAdd,
  onEdit,
  onToggle,
  onDelete,
  onImportFiles,
}: {
  overview: Overview | null;
  scope: Scope;
  servers: Overview["servers"];
  counts: Record<Scope, number>;
  busy: boolean;
  onScope: (scope: Scope) => void;
  onAdd: () => void;
  onEdit: (entry: Overview["servers"][number]) => void;
  onToggle: (entry: Overview["servers"][number]) => void;
  onDelete: (entry: Overview["servers"][number]) => void;
  onImportFiles: () => void;
}) {
  const addBlocked =
    scope === "project" && (overview === null || overview.projectPath === null);
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ScopeTabs value={scope} onChange={onScope} counts={counts} />
        <Button size="sm" onClick={onAdd} disabled={addBlocked}>
          <Icon name="Plus" className="size-4" />
          Add server
        </Button>
        {scope === "project" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onImportFiles}
            disabled={addBlocked || overview === null}
          >
            <Icon name="Download" className="size-4" />
            Import from files
          </Button>
        ) : null}
        {scope === "project" && overview?.projectAuthored === false ? (
          <span className="text-xs text-muted-foreground">
            This project has no servers yet; adding one creates .bb/mcp.json.
          </span>
        ) : null}
      </div>
      <Card className="mt-3">
        <CardContent className="px-4">
          {overview === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : servers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {scope === "host"
                ? "No host-scope servers. Add one to make it available in every project."
                : "No project-scope servers."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {servers.map((entry) => (
                <ServerRow
                  key={`${entry.scope}:${entry.name}`}
                  entry={entry}
                  busy={busy}
                  onEdit={() => onEdit(entry)}
                  onToggle={() => onToggle(entry)}
                  onDelete={() => onDelete(entry)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/u;

function SecretDialog({
  name,
  scope: initialScope,
  projectAvailable,
  stored,
  onReveal,
  onSet,
  onClose,
}: {
  /** Null adds a new name; otherwise the existing one. */
  name: string | null;
  scope: Scope;
  projectAvailable: boolean;
  stored: Overview["vars"];
  onReveal: (scope: Scope, name: string) => Promise<string | null>;
  onSet: (scope: Scope, name: string, value: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [secretName, setSecretName] = useState(name ?? "");
  const [scope, setScope] = useState<Scope>(initialScope);
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = secretName.trim();
  const state = stored.find((entry) => entry.name === trimmed);
  const hasHere = state?.[scope] === true;

  // The value is read only when this dialog opens, and only for that scope.
  useEffect(() => {
    if (name === null) return;
    let active = true;
    setLoading(true);
    setError(null);
    void onReveal(scope, name)
      .then((found) => {
        if (active) setValue(found ?? "");
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [name, scope, onReveal]);

  const apply = async (next: string | null) => {
    setWorking(true);
    setError(null);
    try {
      await onSet(scope, trimmed, next);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const problem =
    !SECRET_NAME.test(trimmed) && trimmed !== ""
      ? "Use upper-case letters, digits and underscore."
      : null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{name === null ? "Add secret" : `Secret ${name}`}</DialogTitle>
          <DialogDescription>
            Values are written to the host or project mcp.local.json and never committed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-secret-name">Name</Label>
            <Input
              id="mcp-secret-name"
              value={secretName}
              readOnly={name !== null}
              autoFocus={name === null}
              placeholder="CONTEXT7_API_KEY"
              className="font-mono text-xs"
              onChange={(event) => setSecretName(event.target.value.toUpperCase())}
            />
            {problem === null ? null : (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Stored in</Label>
            <Select value={scope} onValueChange={(next) => setScope(next as Scope)}>
              <SelectTrigger className="h-8" aria-label="Where the secret is stored">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="host">Host: ~/.bb/mcp.local.json</SelectItem>
                <SelectItem value="project" disabled={!projectAvailable}>
                  Project: &lt;repo&gt;/.bb/mcp.local.json
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="mcp-secret-value">Value</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRevealed((current) => !current)}
              >
                <Icon name={revealed ? "EyeOff" : "Eye"} className="size-4" />
                {revealed ? "Hide" : "Show"}
              </Button>
            </div>
            <Input
              id="mcp-secret-value"
              type={revealed ? "text" : "password"}
              autoComplete="off"
              autoFocus={name !== null}
              value={value}
              disabled={loading}
              placeholder={loading ? "Reading…" : hasHere ? "stored value" : "value"}
              className="font-mono text-xs"
              onChange={(event) => setValue(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {hasHere
                ? "A value is stored here; saving replaces it."
                : name !== null && state?.environment === true
                  ? "Resolved from the host environment; a stored value would override it."
                  : name !== null && state?.resolved === true
                    ? "Set in the other scope; this one would take precedence here."
                    : "Nothing stored yet."}
            </p>
          </div>
          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          {hasHere ? (
            <Button
              variant="destructive"
              disabled={working}
              onClick={() => void apply(null)}
              className="mr-auto"
            >
              Clear
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            disabled={working || loading || trimmed === "" || value === "" || problem !== null}
            onClick={() => void apply(value)}
          >
            {working ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretsSection({
  overview,
  defaultScope,
  projectAvailable,
  busy,
  onReveal,
  onSet,
}: {
  overview: Overview | null;
  defaultScope: Scope;
  projectAvailable: boolean;
  busy: boolean;
  onReveal: (scope: Scope, name: string) => Promise<string | null>;
  onSet: (scope: Scope, name: string, value: string | null) => Promise<void>;
}) {
  const [dialog, setDialog] = useState<{ name: string | null } | null>(null);
  const vars = overview?.vars ?? [];
  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">Secrets</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setDialog({ name: null })}
        >
          <Icon name="Plus" className="size-4" />
          Add secret
        </Button>
      </CardHeader>
      <CardContent className="px-4">
        <p className="pb-2 text-xs text-muted-foreground">
          Values live in ~/.bb/mcp.local.json (host) or &lt;repo&gt;/.bb/mcp.local.json
          (project) and are not part of the generated harness files unless expanded.
        </p>
        {vars.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            No ${"{VAR}"} references yet. Add a secret to prepare one.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {vars.map((variable) => (
              <li key={variable.name} className="flex flex-wrap items-center gap-2 py-2.5">
                <code className="text-xs">{variable.name}</code>
                {variable.usedBy.length === 0 ? (
                  <Badge variant="outline">unused</Badge>
                ) : (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    used by {variable.usedBy.join(", ")}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {variable.host ? <Badge variant="secondary">host</Badge> : null}
                  {variable.project ? <Badge variant="secondary">project</Badge> : null}
                  {variable.environment && !variable.host && !variable.project ? (
                    <Badge variant="secondary">env</Badge>
                  ) : null}
                  {variable.resolved ? null : (
                    <Badge
                      variant="outline"
                      className="text-amber-600 dark:text-amber-500"
                    >
                      missing
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog({ name: variable.name })}
                  >
                    {variable.resolved ? "Edit" : "Set value"}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {dialog === null ? null : (
        <SecretDialog
          key={dialog.name ?? "new"}
          name={dialog.name}
          scope={defaultScope}
          projectAvailable={projectAvailable}
          stored={vars}
          onReveal={onReveal}
          onSet={onSet}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}

function TargetsSection({
  targets,
  busy,
  onTakeOver,
}: {
  targets: Overview["targets"];
  busy: boolean;
  onTakeOver: () => void;
}) {
  const foreign = targets.some((target) => target.exists && !target.owned);
  return (
    <>
      <Card className="mt-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Generated files</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <ul className="divide-y divide-border">
            {targets.map((target) => (
              <li key={target.path} className="flex items-center gap-2 py-2.5">
                <code className="min-w-0 flex-1 truncate text-xs">{target.path}</code>
                <Badge
                  variant={!target.exists ? "outline" : target.owned ? "secondary" : "outline"}
                  className={cn(
                    !target.exists && "text-muted-foreground",
                    target.exists && !target.owned && "text-amber-600 dark:text-amber-500",
                  )}
                >
                  {!target.exists ? "missing" : target.owned ? "owned" : "foreign"}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {foreign ? (
        <Alert className="mt-2">
          <AlertTitle>A file MCP Hub did not write is left alone</AlertTitle>
          <AlertDescription className="flex items-center gap-2">
            Taking it over backs it up first.
            <Button
              variant="destructive"
              size="sm"
              className="ml-auto"
              disabled={busy}
              onClick={onTakeOver}
            >
              Take over
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

const TARGET_STORAGE_KEY = "mcp-hub:target";

interface PageTarget {
  hostId: string | null;
  projectId: string | null;
}

/** A panel link like `/host_faqge25fd2/proj_ehjmqtbwkb`; empty segments mean all. */
function targetFromSubPath(subPath: string): PageTarget | null {
  if (subPath === "") return null;
  const decode = (value: string | undefined): string | null => {
    if (value === undefined || value === "") return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const [host, project] = subPath.split("/");
  return { hostId: decode(host), projectId: decode(project) };
}

/** The last host and project the page was looking at. */
function storedTarget(): PageTarget | null {
  try {
    const raw = window.localStorage.getItem(TARGET_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { hostId?: unknown; projectId?: unknown };
    return {
      hostId: typeof record.hostId === "string" ? record.hostId : null,
      projectId: typeof record.projectId === "string" ? record.projectId : null,
    };
  } catch {
    return null;
  }
}

function McpHubPage({ subPath = "" }: { subPath?: string }) {
  const rpc = useRpc<typeof uiContract>();
  const context = useBbContext();
  const [start] = useState(() =>
    targetFromSubPath(subPath) ??
    storedTarget() ?? { hostId: null, projectId: null },
  );
  const [hostId, setHostId] = useState<string | null>(start.hostId);
  const [projectId, setProjectId] = useState<string | null>(
    start.projectId ?? context.projectId,
  );
  const [scope, setScope] = useState<Scope>("host");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [importingProject, setImportingProject] = useState(false);
  const { overview, error, reload, report } = useMcpOverview(hostId, projectId);
  const sources = useProjectSources(hostId, projectId);
  // Servers the project configures for another harness but MCP Hub does not own.
  const importable = useMemo(() => {
    const known = new Set((overview?.servers ?? []).map((entry) => entry.name));
    const found = new Map<string, { name: string; file: string }>();
    for (const file of sources?.files ?? []) {
      for (const server of file.servers) {
        if (!known.has(server.name)) {
          found.set(server.name, { name: server.name, file: file.path });
        }
      }
    }
    return [...found.values()];
  }, [overview, sources]);
  const importableFiles = useMemo(
    () => [
      ...new Set(
        importable.map((entry) => entry.file.split(/[\\/]/u).slice(-2).join("/")),
      ),
    ],
    [importable],
  );

  // The composer hands the page the thread's machine and project.
  useEffect(() => {
    const target = targetFromSubPath(subPath);
    if (target === null) return;
    setHostId(target.hostId);
    setProjectId(target.projectId);
  }, [subPath]);

  // In a pane the route still knows the thread; follow its machine.
  useEffect(() => {
    if (context.threadId === null) return;
    let active = true;
    void rpc
      .call("threadTarget", { threadId: context.threadId })
      .then((target) => {
        if (!active) return;
        setHostId(target.hostId);
        setProjectId(target.projectId);
      })
      .catch(() => {
        // A thread that vanished keeps the current selection.
      });
    return () => {
      active = false;
    };
  }, [context.threadId, rpc]);

  // The pane outlives project switches; follow the project the user opens.
  useEffect(() => {
    if (context.projectId !== null) setProjectId(context.projectId);
  }, [context.projectId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        TARGET_STORAGE_KEY,
        JSON.stringify({ hostId, projectId }),
      );
    } catch {
      // Storage can be unavailable; the page still works without it.
    }
  }, [hostId, projectId]);

  const run = async (
    label: string,
    action: () => Promise<{ results: Array<{ status: string }> }>,
  ): Promise<boolean> => {
    setBusy(label);
    try {
      const { results } = await action();
      toast.success(`${label}: ${summarize(results)}`);
      await reload();
      return true;
    } catch (cause) {
      report(cause);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const setSecret = useCallback(
    async (secretScope: Scope, name: string, value: string | null) => {
      setBusy("Secret");
      try {
        const { results } = await rpc.call("setVar", {
          hostId,
          projectId,
          scope: secretScope,
          name,
          value,
        });
        toast.success(`Secret: ${summarize(results)}`);
        await reload();
      } catch (cause) {
        report(cause);
        throw cause;
      } finally {
        setBusy(null);
      }
    },
    [hostId, projectId, reload, report, rpc],
  );

  const revealSecret = useCallback(
    async (secretScope: Scope, name: string) => {
      const { value } = await rpc.call("revealVar", {
        hostId,
        projectId,
        scope: secretScope,
        name,
      });
      return value;
    },
    [hostId, projectId, rpc],
  );

  const importEntries = useCallback(
    async (entries: Array<{ name: string; server: HubServer }>) => {
      setBusy("Import");
      try {
        const { results } = await rpc.call("importServers", {
          hostId,
          projectId,
          scope: "project",
          entries,
        });
        toast.success(`Import: ${summarize(results)}`);
        await reload();
      } catch (cause) {
        report(cause);
        throw cause;
      } finally {
        setBusy(null);
      }
    },
    [hostId, projectId, reload, report, rpc],
  );

  const saveDraft = async () => {
    if (draft === null || draftProblem(draft) !== null) return;
    setSaving(true);
    try {
      const secrets = Object.fromEntries(
        Object.entries(draft.secrets).filter(([, value]) => value !== ""),
      );
      const previousName = draft.previousName;
      const saved = await run(previousName === null ? "Add" : "Save", () =>
        rpc.call("saveServer", {
          hostId,
          projectId,
          scope: draft.scope,
          name: draft.name.trim(),
          previousName,
          server: draftToServer(draft),
          vars: Object.keys(secrets).length === 0 ? null : secrets,
        }),
      );
      if (!saved) return;
      if (previousName !== null && draft.previousScope !== draft.scope) {
        const previousScope = draft.previousScope;
        // Save first, then drop the old copy: a failed save must not lose it.
        const moved = await run("Move", () =>
          rpc.call("deleteServer", {
            hostId,
            projectId,
            scope: previousScope,
            name: previousName,
          }),
        );
        if (!moved) return;
      }
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const servers = useMemo(
    () => (overview?.servers ?? []).filter((entry) => entry.scope === scope),
    [overview, scope],
  );
  const counts = useMemo(
    () => ({
      host: (overview?.servers ?? []).filter((entry) => entry.scope === "host").length,
      project: (overview?.servers ?? []).filter((entry) => entry.scope === "project").length,
    }),
    [overview],
  );

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-10 pt-3 md:px-5 md:pt-4">
        <PageHeader
          overview={overview}
          hostId={hostId}
          projectId={projectId}
          busy={busy !== null}
          onHost={setHostId}
          onProject={setProjectId}
          onApply={() =>
            void run("Apply", () => rpc.call("apply", { hostId, projectId, force: false }))
          }
        />
        {error === null ? null : (
          <Alert variant="destructive" className="mt-3">
            <Icon name="AlertTriangle" className="size-4" />
            <AlertTitle>MCP Hub</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {importable.length > 0 && overview?.projectPath != null ? (
          <Alert className="mt-3">
            <Icon name="Download" className="size-4" />
            <AlertTitle>
              {importable.length} MCP servers in this project are not managed by MCP Hub
            </AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                Found in {importableFiles.join(", ")}. Import them into{" "}
                <code>&lt;repo&gt;/.bb/mcp.json</code> to edit and materialize them.
              </span>
              <Button size="sm" onClick={() => setImportingProject(true)} disabled={busy !== null}>
                Review and import
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <UnresolvedNotice unresolved={overview?.unresolved ?? []} />
        <ServersSection
          overview={overview}
          scope={scope}
          servers={servers}
          counts={counts}
          busy={busy !== null}
          onScope={setScope}
          onAdd={() => setDraft(draftFor(scope, null, null))}
          onEdit={(entry) => setDraft(draftFor(entry.scope, entry.name, entry.server))}
          onToggle={(entry) =>
            void run(entry.enabled ? "Disable" : "Enable", () =>
              rpc.call("setEnabled", {
                hostId,
                projectId,
                scope: entry.scope,
                name: entry.name,
                enabled: !entry.enabled,
              }),
            )
          }
          onDelete={(entry) =>
            void run("Delete", () =>
              rpc.call("deleteServer", {
                hostId,
                projectId,
                scope: entry.scope,
                name: entry.name,
              }),
            )
          }
          onImportFiles={() => setImportingProject(true)}
        />
        <SecretsSection
          overview={overview}
          defaultScope={scope}
          projectAvailable={overview?.projectPath != null}
          busy={busy !== null}
          onReveal={revealSecret}
          onSet={setSecret}
        />
        <TargetsSection
          targets={overview?.targets ?? []}
          busy={busy !== null}
          onTakeOver={() =>
            void run("Take over", () => rpc.call("apply", { hostId, projectId, force: true }))
          }
        />
      </div>

      <ServerEditor
        draft={draft}
        overview={overview}
        projectAvailable={overview?.projectPath != null}
        projectName={
          overview?.projects.find((project) => project.id === projectId)?.name ?? null
        }
        onDraft={setDraft}
        onSave={() => void saveDraft()}
        onClose={() => setDraft(null)}
        saving={saving}
        problem={draft === null ? null : draftProblem(draft)}
      />
      {importingProject ? (
        <ProjectImportDialog
          hostId={hostId}
          projectId={projectId}
          overview={overview}
          onImport={importEntries}
          onClose={() => setImportingProject(false)}
        />
      ) : null}
    </div>
  );
}

/** The project's MCP state, resolved from the composer's thread. */
function useThreadOverview() {
  const rpc = useRpc<typeof uiContract>();
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [state, setState] = useState<Overview | null>(null);
  const load = useCallback(async () => {
    if (threadId === null) {
      setState(null);
      return;
    }
    try {
      const target = await rpc.call("threadTarget", { threadId });
      setState(
        await rpc.call("overview", {
          hostId: target.hostId,
          projectId: target.projectId,
        }),
      );
    } catch {
      // A transient failure keeps the last good list on screen.
    }
  }, [rpc, threadId]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("mcp-hub/changed", () => {
    void load();
  });
  return { state, reload: load };
}

/** Workspace MCP count in the composer toolbar, with a menu anchored to it. */
function ComposerMcpCount() {
  const rpc = useRpc<typeof uiContract>();
  const navigate = useBbNavigate();
  const { state, reload } = useThreadOverview();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const count = state?.servers.filter((server) => server.enabled).length ?? 0;

  const toggle = async (entry: Overview["servers"][number]) => {
    if (state === null) return;
    setBusy(`${entry.scope}:${entry.name}`);
    try {
      await rpc.call("setEnabled", {
        hostId: state.hostId,
        projectId: state.projectId,
        scope: entry.scope,
        name: entry.name,
        enabled: !entry.enabled,
      });
      await reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (count === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`MCP servers: ${String(count)}`}
          aria-haspopup="menu"
          className="h-7 gap-1 px-1.5 text-xs text-muted-foreground"
        >
          <McpMark className="size-3.5" />
          {count}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-64 p-1.5">
        <div className="flex items-baseline justify-between px-1.5 pb-1">
          <span className="text-xs font-medium">MCP servers</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {state?.projectId === null ? "host" : "host + project"}
          </span>
        </div>
        {state === null ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : state.servers.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">No servers configured.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {state.servers.map((entry) => {
              const key = `${entry.scope}:${entry.name}`;
              return (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-secondary/60"
                >
                  <ServerIdentity
                    name={entry.name}
                    scope={entry.scope}
                    enabled={entry.enabled}
                    busy={busy !== null}
                    onToggle={() => void toggle(entry)}
                    nameClassName="text-xs"
                  />
                </li>
              );
            })}
          </ul>
        )}
        {(state?.unresolved ?? []).length > 0 ? (
          <p className="px-1.5 text-[11px] text-amber-600 dark:text-amber-500">
            Missing values: {state?.unresolved.join(", ")}
          </p>
        ) : null}
        <Separator className="my-1" />
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs text-muted-foreground"
          onClick={() => {
            setOpen(false);
            if (state === null) {
              navigate.toPluginPanel("mcp");
              return;
            }
            navigate.toPluginPanel("mcp", {
              subPath:
                state.projectId === null
                  ? state.hostId
                  : `${state.hostId}/${state.projectId}`,
            });
          }}
        >
          <Icon name="ExternalLink" className="size-3.5" />
          Open MCP page
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mcp",
    title: "MCP",
    icon: "mcp-hub/mcp",
    path: "mcp",
    component: McpHubPage,
  });
  app.composer.customize({
    id: "mcp-count",
    scopes: ["thread"],
    actions: [{ id: "mcp", component: ComposerMcpCount }],
  });
});
