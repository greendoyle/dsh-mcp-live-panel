/**
 * @deepseek-ai/dsh-mcp-panel
 *
 * Host half of the editable MCP server panel.
 *
 * Data model
 * ----------
 * The panel owns one loader entry-list file (default `<profile>/mcp-servers.json`)
 * holding `@deepseek-ai/dsh-mcp-client` rows. A single `cordis:include` row in the
 * profile patch mounts that file as a nested loader tree, so the server list is
 * declarative, survives profile configuration reloads, and adding or removing a
 * server never means hand-editing `cordis.patch.yml`.
 *
 * Every panel mutation (add / edit / enable / disable / remove / restart) rewrites
 * that file and refreshes the include subtree through the Loader, which creates,
 * updates, or disposes exactly the affected `mcp-client` entries while the Host keeps
 * running. Connection failures are reported in the panel from a logger tap, so a
 * broken command is visible in the GUI instead of only on the Host console.
 *
 * Routes (config `path`, default "/mcp"):
 *   GET    <path>                      -> panel page (assets are read per request)
 *   GET    <path>/app.css | /app.js    -> panel assets
 *   GET    <path>/api/state            -> [{ servers, include, storePath, ... }]
 *   POST   <path>/api/servers          -> add one server
 *   PUT    <path>/api/servers/<name>   -> replace one server (rename allowed)
 *   DELETE <path>/api/servers/<name>   -> remove one server
 *   POST   <path>/api/servers/<name>/enabled -> { enabled: boolean }
 *   POST   <path>/api/servers/<name>/restart -> dispose + reconnect that server
 *   POST   <path>/api/reload           -> re-read the file (after a manual edit)
 *
 * Zero runtime dependencies: ESM, node:crypto-free, node:fs/node:path/node:url only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const name = "mcp-panel";

const inject = ["loader", "tools", "webServer"];

/** Module names whose entries this panel surfaces and manages. */
const MCP_CLIENT_MODULES = new Set([
  "@deepseek-ai/dsh-mcp-client",
  "dsh-mcp-client",
  "mcp-client",
]);

/** Canonical module specifier written into the managed entry list. */
const MCP_CLIENT_SPECIFIER = "@deepseek-ai/dsh-mcp-client";

/** Default id of the `cordis:include` row that mounts the managed file. */
const DEFAULT_INCLUDE_ID = "mcp-servers";

/** Default managed file, relative to the active profile directory. */
const DEFAULT_STORE_FILE = "mcp-servers.json";

/** `toolCallTimeoutMs` default of dsh-mcp-client. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** `serverName` contract of dsh-mcp-client. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Maximum accepted JSON body for one mutation. */
const MAX_BODY_BYTES = 128 * 1024;

/** Cordis Fiber states -> display phases (mirror of dsh-host-plugin-inventory). */
const FIBER_PHASE = {
  0: "pending",
  1: "loading",
  2: "active",
  3: "failed",
  4: null,
  5: "unloading",
};

const FIBER_FAILED = 3;

/** Truncation bound for one captured log line. */
const LOG_TEXT_LIMIT = 800;

/** Reconnect progress lines: useful context, but never the underlying cause. */
const LOG_PROGRESS_PATTERN = /(connection failed; retrying|reconnected and re-synced|giving up after)/i;

/** Error carrying an HTTP status for the panel API. */
class PanelError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PanelError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ paths */

/** Resolve the Harness home the same way `@deepseek-ai/dsh-home-paths` does. */
function resolveHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return resolve(configured.trim());
  }
  return join(homedir(), ".dsh");
}

/** Active profile directory: `profileContext.dir`, else the root include's base. */
function profileDirOf(ctx) {
  const profile = ctx.get("profileContext");
  if (profile && typeof profile.dir === "string" && profile.dir.length > 0) {
    return profile.dir;
  }
  for (const entry of ctx.loader.entries()) {
    const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
    if (typeof baseUrl !== "string") continue;
    try {
      return fileURLToPath(new URL(".", baseUrl));
    } catch {
      /* try the next entry */
    }
  }
  return join(resolveHome(), "profiles", "web");
}

/** Absolute path of the managed server list. */
function storePathOf(ctx, config) {
  const configured = String(config?.store ?? DEFAULT_STORE_FILE);
  return isAbsolute(configured) ? configured : join(profileDirOf(ctx), configured);
}

/* ------------------------------------------------------------------ store */

/** Read the managed loader entry list; a missing file is an empty list. */
function readStore(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new PanelError(500, `无法读取 ${file}：${error.message}`);
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new PanelError(500, `${file} 不是合法 JSON：${error.message}`);
  }
  return validateRows(rows, file);
}

/** Validate a loader entry list before it reaches the Loader. */
function validateRows(rows, file = "mcp-servers.json") {
  if (!Array.isArray(rows)) {
    throw new PanelError(500, `${file} 顶层必须是数组（loader 条目列表）`);
  }
  rows.forEach((row, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new PanelError(500, `${file} 第 ${index + 1} 行必须是对象`);
    }
    if (typeof row.id !== "string" || row.id.length === 0) {
      throw new PanelError(500, `${file} 第 ${index + 1} 行缺少 id`);
    }
    if (typeof row.name !== "string" || !MCP_CLIENT_MODULES.has(row.name)) {
      throw new PanelError(
        500,
        `${file} 第 ${index + 1} 行的 name 必须是 "${MCP_CLIENT_SPECIFIER}"（面板只管理 MCP 客户端条目）`,
      );
    }
    if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) {
      throw new PanelError(500, `${file} 第 ${index + 1} 行缺少 config 对象`);
    }
    const serverName = row.config.serverName;
    if (typeof serverName !== "string" || !SERVER_NAME_PATTERN.test(serverName)) {
      throw new PanelError(500, `${file} 第 ${index + 1} 行的 config.serverName 不合法`);
    }
  });
  return rows;
}

/** Replace the managed file atomically (temp file + rename). */
function writeStore(file, rows) {
  const text = `${JSON.stringify(rows, null, 2)}\n`;
  const temp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
}

/** Create an empty managed file when it is missing, so the include can mount. */
function ensureStoreFile(file) {
  if (existsSync(file)) return;
  writeStore(file, []);
}

/* ------------------------------------------------------------- row model */

/** Stable namespace of one row (falls back to the entry id). */
function serverNameOf(row) {
  const serverName = row?.config?.serverName;
  if (typeof serverName === "string" && serverName.length > 0) return serverName;
  if (typeof row?.id === "string") return row.id.replace(/^mcp-/, "");
  return "";
}

/** Split a textarea value into non-empty, trimmed lines. */
function splitLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Accept an array of arguments or one-per-line text. */
function coerceArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return splitLines(value);
  return [];
}

/**
 * Accept a plain object or `KEY=value` / `Key: value` lines.
 * @param value - object or textarea text.
 * @param label - field label used in the diagnostic.
 */
function coercePairs(value, label) {
  const out = {};
  const add = (key, item) => {
    const normalized = String(key ?? "").trim();
    if (normalized.length === 0) return;
    out[normalized] = String(item ?? "").trim();
  };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) add(key, item);
    return out;
  }
  for (const line of splitLines(value)) {
    const match = /^([^:=]+?)\s*[:=]\s*([\s\S]*)$/.exec(line);
    if (match === null) {
      throw new PanelError(400, `${label} 的每一行都需要 "名字" 和 "值"（用 = 或 : 分隔）：${line}`);
    }
    add(match[1], match[2]);
  }
  return out;
}

/** Parse a bounded positive integer. */
function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** Build one loader row from a panel submission. */
function buildRow(input) {
  const serverName = String(input?.serverName ?? "").trim();
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new PanelError(
      400,
      "服务器名称只能包含字母、数字、下划线和短横线，长度 1-32（它决定工具名前缀 mcp__<名称>__*）",
    );
  }
  const transport = input?.transport === "streamable-http" ? "streamable-http" : "stdio";
  const config = { serverName, transport };

  if (transport === "stdio") {
    const command = String(input?.command ?? "").trim();
    if (command.length === 0) throw new PanelError(400, "stdio 传输必须填写启动命令");
    config.command = command;
    const args = coerceArgs(input?.args);
    if (args.length > 0) config.args = args;
    const env = coercePairs(input?.env, "环境变量");
    if (Object.keys(env).length > 0) config.env = env;
    const cwd = String(input?.cwd ?? "").trim();
    if (cwd.length > 0) config.cwd = cwd;
  } else {
    const url = String(input?.url ?? "").trim();
    if (url.length === 0) throw new PanelError(400, "streamable-http 传输必须填写 MCP 地址");
    try {
      new URL(url);
    } catch {
      throw new PanelError(400, `MCP 地址不是合法 URL：${url}`);
    }
    config.url = url;
    const headers = coercePairs(input?.headers, "请求头");
    if (Object.keys(headers).length > 0) config.headers = headers;
  }

  const timeout = positiveInt(input?.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
  if (timeout !== DEFAULT_TOOL_CALL_TIMEOUT_MS) config.toolCallTimeoutMs = timeout;
  if (input?.failOnStartupError === true) config.failOnStartupError = true;

  const reconnect = {};
  if (input?.autoReconnect === false) reconnect.enabled = false;
  const attempts = positiveInt(input?.reconnectAttempts, 10);
  if (attempts !== 10) reconnect.maxAttempts = attempts;
  if (Object.keys(reconnect).length > 0) config.reconnect = reconnect;

  const row = { id: `mcp-${serverName}`, name: MCP_CLIENT_SPECIFIER, config };
  if (input?.enabled === false) row.disabled = true;
  return row;
}

/* ---------------------------------------------------------- loader access */

/** Every entry whose module is the MCP client bridge. */
function* mcpEntries(ctx) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    if (!MCP_CLIENT_MODULES.has(entry.options.name)) continue;
    yield entry;
  }
}

/** Find one entry by its plain options id. */
function findEntryById(ctx, id) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.id === id) return entry;
  }
  return undefined;
}

/** The running `cordis:include` row that mounts the managed entry list. */
function findIncludeEntry(ctx, includeId) {
  const entry = findEntryById(ctx, includeId);
  if (entry === undefined) return undefined;
  if (entry.subtree === undefined || typeof entry.subtree.refresh !== "function") return undefined;
  return entry;
}

/** Managed entry for one row, looked up inside the include subtree only. */
function entryOfRow(includeEntry, row) {
  if (includeEntry === undefined) return undefined;
  for (const entry of includeEntry.subtree.entries()) {
    if (entry.options.id === row.id) return entry;
  }
  return undefined;
}

/** True when `entry` lives inside the managed include subtree. */
function isManagedEntry(includeEntry, entry) {
  return includeEntry !== undefined && entry.parent?.tree === includeEntry.subtree;
}

/**
 * Throw when another server already owns `serverName`.
 * @param ctx - host context.
 * @param rows - candidate managed rows.
 * @param row - the row being written.
 * @param ignoreIndex - index of the row being replaced.
 * @param includeId - managed include row id.
 */
function assertUniqueServerName(ctx, rows, row, ignoreIndex, includeId) {
  const wanted = serverNameOf(row);
  rows.forEach((existing, index) => {
    if (index === ignoreIndex) return;
    if (serverNameOf(existing) === wanted) {
      throw new PanelError(409, `名称 "${wanted}" 已被列表里的另一个服务器占用`);
    }
  });
  const includeEntry = findIncludeEntry(ctx, includeId);
  for (const entry of mcpEntries(ctx)) {
    if (isManagedEntry(includeEntry, entry)) continue;
    const external = entry.options.config?.serverName ?? entry.options.id;
    if (external === wanted) {
      throw new PanelError(
        409,
        `名称 "${wanted}" 已被 cordis.patch.yml 里外部定义的 MCP 服务器占用，请改名或先删除那一条`,
      );
    }
  }
}

/** Re-read the managed file from disk and rebuild the include subtree. */
async function refreshInclude(ctx, includeId) {
  const entry = findIncludeEntry(ctx, includeId);
  if (entry === undefined) {
    throw new PanelError(
      500,
      `组合中找不到运行中的 include 行 "${includeId}"：面板无法热加载服务器列表。` +
        `请在 profile 的 cordis.patch.yml 中加入\n` +
        `- insert:\n    - id: ${includeId}\n      name: 'cordis:include'\n      config:\n        path: '${DEFAULT_STORE_FILE}'`,
    );
  }
  await entry.subtree.refresh();
  await ctx.loader.await();
}

/** Dispose a live server and start it again from its current options. */
async function restartEntry(entry) {
  if (entry.disabled) throw new PanelError(409, "该服务器已停用，先启用再重连");
  const fiber = entry.fiber;
  if (fiber !== undefined) {
    try {
      await fiber.dispose();
    } catch (error) {
      /* a failed fiber can reject its disposal; a fresh attempt still helps */
      void error;
    }
  }
  await entry.init();
}

/* --------------------------------------------------------------- log tap */

/** Flatten one structured log record into text (best effort). */
function formatLogMessage(message) {
  const args = Array.isArray(message?.args) ? message.args.slice() : [];
  if (args.length === 0) return "";
  const first = args.shift();
  if (first instanceof Error) return String(first.message ?? first);
  if (typeof first !== "string") return String(first);
  let text = first;
  if (args.length > 0) {
    text = text.replace(/%[sdifoO]/g, () => {
      const next = args.shift();
      return next instanceof Error ? String(next.message ?? next) : String(next);
    });
  }
  if (args.length > 0) {
    text += ` ${args.map((item) => (item instanceof Error ? String(item.message ?? item) : String(item))).join(" ")}`;
  }
  return text;
}

/**
 * Capture the most recent warning/error of every MCP server.
 *
 * `dsh-mcp-client` labels its records `mcp-client(<serverName>): ...`, which is the
 * only attribution available through the logger; a record without that label is
 * ignored. Reconnect progress lines are kept apart from the underlying cause so the
 * panel can show "spawn ... ENOENT" instead of "retrying in 4000ms".
 * @param ctx - host context owning the exporter lifetime.
 * @returns map of serverName -> { detail, progress }, each `{ level, text, at }`.
 */
function installLogTap(ctx) {
  const recent = new Map();
  const entryFor = (serverName) => {
    let entry = recent.get(serverName);
    if (entry === undefined) {
      entry = { detail: null, progress: null };
      recent.set(serverName, entry);
      if (recent.size > 64) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
    }
    return entry;
  };
  ctx.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      if (message?.type !== "warn" && message?.type !== "error") return;
      const text = formatLogMessage(message);
      const match = /mcp-client\(([^)\s]+)\):\s*([\s\S]*)$/.exec(text);
      if (match === null) return;
      const serverName = match[1];
      const body = match[2].length > LOG_TEXT_LIMIT ? `${match[2].slice(0, LOG_TEXT_LIMIT)}…` : match[2];
      const record = { level: message.type, text: body, at: message.ts ?? Date.now() };
      const entry = entryFor(serverName);
      if (LOG_PROGRESS_PATTERN.test(body)) entry.progress = record;
      else entry.detail = record;
    },
  });
  return recent;
}

/* ------------------------------------------------------------- snapshots */

/** MCP tool schemas grouped by their server namespace. */
function toolsByServer(ctx) {
  const byServer = new Map();
  let schemas = [];
  try {
    schemas = ctx.tools.schemas();
  } catch (error) {
    ctx.logger.warn(`mcp-panel: tools.schemas() failed: ${String(error)}`);
    return byServer;
  }
  for (const schema of schemas) {
    if (typeof schema?.name !== "string" || !schema.name.startsWith("mcp__")) continue;
    const parts = schema.name.split("__");
    const server = parts[1];
    const raw = parts.slice(2).join("__");
    if (!server || !raw) continue;
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server).push({
      raw,
      name: schema.name,
      description: typeof schema.description === "string" ? schema.description : "",
    });
  }
  return byServer;
}

/** Look for `command` on PATH (or on disk when it looks like a path). */
function commandExists(command) {
  if (/[\\/]/.test(command)) {
    try {
      return statSync(command).isFile();
    } catch {
      return false;
    }
  }
  const extensions =
    process.platform === "win32"
      ? String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item.length > 0)
      : [""];
  const directories = String(process.env.PATH ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        if (statSync(join(directory, `${command}${extension}`)).isFile()) return true;
      } catch {
        /* keep looking */
      }
    }
    try {
      if (statSync(join(directory, command)).isFile()) return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** Configuration warning shown on a server card (never blocks saving). */
function configWarning(config) {
  if (config?.transport === "streamable-http") {
    const url = String(config.url ?? "");
    if (url.length === 0) return "缺少 MCP 地址";
    try {
      new URL(url);
      return null;
    } catch {
      return `MCP 地址不是合法 URL：${url}`;
    }
  }
  const command = String(config?.command ?? "").trim();
  if (command.length === 0) return "缺少启动命令";
  return commandExists(command) ? null : `找不到可执行文件或命令：${command}`;
}

/** Pick the line worth showing: the underlying cause first, progress second. */
function logView(record) {
  if (record === undefined) return { lastLog: null, lastLogIsProgress: false };
  const chosen = record.detail ?? record.progress ?? null;
  return { lastLog: chosen, lastLogIsProgress: record.detail === null || record.detail === undefined };
}

/** One server row as the panel renders it. */
function serverView({ row, entry, tools, managed, recent }) {
  const config = row.config ?? {};
  const serverName = serverNameOf(row);
  const enabled = row.disabled !== true && entry?.disabled !== true;
  let phase;
  if (!enabled) phase = "disabled";
  else if (entry?.fiber !== undefined) phase = FIBER_PHASE[entry.fiber.state] ?? "unknown";
  else phase = managed ? "missing" : "pending";

  const toolList = tools.get(serverName) ?? [];
  return {
    id: typeof row.id === "string" ? row.id : null,
    serverName,
    managed,
    enabled,
    phase,
    disabled: row.disabled === true,
    transport: config.transport ?? "unknown",
    command: config.command ?? "",
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env ?? {},
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    headers: config.headers ?? {},
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: config.failOnStartupError === true,
    reconnect: config.reconnect ?? null,
    connected: toolList.length > 0,
    toolCount: toolList.length,
    tools: toolList,
    warning: configWarning(config),
    ...logView(recent.get(serverName)),
  };
}

/** Full panel snapshot. */
function buildState(ctx, env) {
  const includeEntry = findIncludeEntry(ctx, env.includeId);
  const includeRow = findEntryById(ctx, env.includeId);
  let rows = [];
  let storeError = null;
  try {
    rows = readStore(env.storeFile);
  } catch (error) {
    storeError = String(error?.message ?? error);
  }
  const tools = toolsByServer(ctx);
  const managedNames = new Set();
  const servers = [];

  for (const row of rows) {
    const serverName = serverNameOf(row);
    if (serverName.length > 0) managedNames.add(serverName);
    servers.push(
      serverView({
        row,
        entry: entryOfRow(includeEntry, row),
        tools,
        managed: true,
        recent: env.recent,
      }),
    );
  }

  for (const entry of mcpEntries(ctx)) {
    const config = entry.options.config ?? {};
    const serverName = typeof config.serverName === "string" ? config.serverName : entry.options.id;
    if (managedNames.has(serverName)) continue;
    servers.push(
      serverView({
        row: { id: entry.options.id, name: entry.options.name, config, disabled: entry.disabled },
        entry,
        tools,
        managed: false,
        recent: env.recent,
      }),
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    storePath: env.storeFile,
    includeId: env.includeId,
    includeInstalled: includeEntry !== undefined,
    includePhase:
      includeRow?.fiber !== undefined
        ? (FIBER_PHASE[includeRow.fiber.state] ?? "unknown")
        : includeRow !== undefined
          ? "pending"
          : "missing",
    storeError,
    servers,
  };
}

/* -------------------------------------------------------------- HTTP layer */

/** Read and parse one JSON request body. */
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new PanelError(413, "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch (error) {
        rejectPromise(new PanelError(400, `请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on("error", (error) => rejectPromise(new PanelError(400, String(error?.message ?? error))));
  });
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read one panel asset from disk (so UI edits need no Host reload). */
function assetPath(asset) {
  return fileURLToPath(new URL(`../assets/${asset}`, import.meta.url));
}

/** Serve one panel asset. */
function sendAsset(res, asset, contentType) {
  let body;
  try {
    body = readFileSync(assetPath(asset));
  } catch (error) {
    sendJson(res, 500, { error: `面板资源缺失：${asset}（${String(error?.message ?? error)}）` });
    return;
  }
  res.writeHead(200, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
}

/** Serve the panel page shell. */
function sendPage(res, basePath) {
  let html;
  try {
    html = readFileSync(assetPath("index.html"), "utf8").replaceAll("{{BASE}}", basePath);
  } catch (error) {
    sendJson(res, 500, { error: `面板页面缺失：${String(error?.message ?? error)}` });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

/* -------------------------------------------------------------- mutations */

/** Serialize every tree mutation so two clicks cannot interleave. */
function createMutex() {
  let chain = Promise.resolve();
  return (operation) => {
    const run = chain.then(operation, operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Mutate the managed list, persist it, and rebuild the include subtree.
 * @returns the fresh panel snapshot, with `reloadError` when hot-mounting failed.
 */
async function mutate(ctx, env, operation) {
  return env.exclusive(async () => {
    const rows = readStore(env.storeFile);
    const next = operation(rows);
    writeStore(env.storeFile, next);
    let reloadError = null;
    try {
      await refreshInclude(ctx, env.includeId);
    } catch (error) {
      reloadError = String(error?.message ?? error);
    }
    const state = buildState(ctx, env);
    if (reloadError !== null) state.reloadError = reloadError;
    return state;
  });
}

/** Find the managed entry for a server name. */
function findManagedEntry(ctx, env, serverName) {
  const includeEntry = findIncludeEntry(ctx, env.includeId);
  if (includeEntry === undefined) return undefined;
  for (const entry of includeEntry.subtree.entries()) {
    const configured = entry.options.config?.serverName ?? "";
    if (configured === serverName) return entry;
  }
  return undefined;
}

/** Route one `/api/*` request. */
async function handleApi(ctx, env, req, res, method, sub) {
  const parts = sub.split("/").filter((part) => part.length > 0);
  if (parts[0] !== "api") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (method === "POST" && parts.length === 2 && parts[1] === "reload") {
    const state = await env.exclusive(async () => {
      readStore(env.storeFile);
      let reloadError = null;
      try {
        await refreshInclude(ctx, env.includeId);
      } catch (error) {
        reloadError = String(error?.message ?? error);
      }
      const next = buildState(ctx, env);
      if (reloadError !== null) next.reloadError = reloadError;
      return next;
    });
    sendJson(res, 200, state);
    return;
  }
  if (parts[1] !== "servers") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const rest = parts.slice(2);

  if (rest.length === 0 && method === "POST") {
    const body = await readJsonBody(req);
    const state = await mutate(ctx, env, (rows) => {
      const row = buildRow(body?.server ?? body);
      assertUniqueServerName(ctx, rows, row, -1, env.includeId);
      return [...rows, row];
    });
    sendJson(res, 200, state);
    return;
  }

  if (rest.length === 1 && method === "PUT") {
    const target = decodeURIComponent(rest[0]);
    const body = await readJsonBody(req);
    const state = await mutate(ctx, env, (rows) => {
      const index = rows.findIndex((row) => serverNameOf(row) === target);
      if (index < 0) {
        throw new PanelError(404, `找不到服务器 "${target}"：它可能来自外部配置文件，面板不能修改`);
      }
      const row = buildRow(body?.server ?? body);
      assertUniqueServerName(ctx, rows, row, index, env.includeId);
      const next = [...rows];
      next[index] = row;
      return next;
    });
    sendJson(res, 200, state);
    return;
  }

  if (rest.length === 1 && method === "DELETE") {
    const target = decodeURIComponent(rest[0]);
    const state = await mutate(ctx, env, (rows) => {
      const next = rows.filter((row) => serverNameOf(row) !== target);
      if (next.length === rows.length) {
        throw new PanelError(404, `找不到服务器 "${target}"：它可能来自外部配置文件，面板不能删除`);
      }
      return next;
    });
    sendJson(res, 200, state);
    return;
  }

  if (rest.length === 2 && rest[1] === "enabled" && method === "POST") {
    const target = decodeURIComponent(rest[0]);
    const body = await readJsonBody(req);
    const enabled = body?.enabled !== false;
    const state = await mutate(ctx, env, (rows) => {
      const index = rows.findIndex((row) => serverNameOf(row) === target);
      if (index < 0) {
        throw new PanelError(404, `找不到服务器 "${target}"：它可能来自外部配置文件，面板不能停用`);
      }
      const next = [...rows];
      const row = { ...next[index] };
      if (enabled) delete row.disabled;
      else row.disabled = true;
      next[index] = row;
      return next;
    });
    sendJson(res, 200, state);
    return;
  }

  if (rest.length === 2 && rest[1] === "restart" && method === "POST") {
    const target = decodeURIComponent(rest[0]);
    const state = await env.exclusive(async () => {
      const entry = findManagedEntry(ctx, env, target);
      if (entry === undefined) {
        throw new PanelError(404, `找不到服务器 "${target}" 的运行实例（可能处于停用状态）`);
      }
      let reloadError = null;
      try {
        await restartEntry(entry);
        await ctx.loader.await();
      } catch (error) {
        reloadError = String(error?.message ?? error);
      }
      const next = buildState(ctx, env);
      if (reloadError !== null) next.reloadError = reloadError;
      return next;
    });
    sendJson(res, 200, state);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

/** Route one panel request. */
async function handleRequest(ctx, env, req, res) {
  const method = String(req.method ?? "GET").toUpperCase();
  let pathname = env.basePath;
  try {
    pathname = new URL(String(req.url ?? "/"), "http://localhost").pathname;
  } catch {
    /* keep the base path */
  }
  const sub = pathname.length > env.basePath.length ? pathname.slice(env.basePath.length) : "";
  try {
    if (sub === "" || sub === "/") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      sendPage(res, env.basePath);
      return;
    }
    if (method === "GET" && sub === "/app.css") {
      sendAsset(res, "app.css", "text/css");
      return;
    }
    if (method === "GET" && sub === "/app.js") {
      sendAsset(res, "app.js", "text/javascript");
      return;
    }
    if (method === "GET" && sub === "/api/state") {
      sendJson(res, 200, buildState(ctx, env));
      return;
    }
    if (sub.startsWith("/api/")) {
      await handleApi(ctx, env, req, res, method, sub);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    const status = error instanceof PanelError ? error.status : 500;
    if (status >= 500) ctx.logger.error(`mcp-panel: ${String(error?.stack ?? error)}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, status, { error: String(error?.message ?? error) });
  }
}

/* ---------------------------------------------------------------- plugin */

/** Normalize the configured mount path. */
function normalizePath(value) {
  const trimmed = String(value ?? "/mcp").trim().replace(/\/+$/g, "");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length === 0 ? "/mcp" : withSlash;
}

/** Try to revive the include row when it failed before its file existed. */
function recoverInclude(ctx, includeId) {
  const entry = findEntryById(ctx, includeId);
  if (entry === undefined || entry.disabled) return;
  if (entry.fiber?.state !== FIBER_FAILED) return;
  Promise.resolve()
    .then(async () => {
      try {
        await entry.fiber.dispose();
      } catch {
        /* a failed fiber may reject its disposal */
      }
      await entry.update(entry.options, true, true);
      await ctx.loader.await();
      ctx.logger.info(`mcp-panel: 已重新挂载 ${includeId}`);
    })
    .catch((error) => {
      ctx.logger.warn(`mcp-panel: 重新挂载 ${includeId} 失败：${String(error?.message ?? error)}`);
    });
}

/**
 * Mount the panel route.
 * @param ctx - host context carrying loader, tools, and the Web server.
 * @param config - `{ path, store, includeId }`.
 */
function apply(ctx, config = {}) {
  const basePath = normalizePath(config.path);
  const storeFile = storePathOf(ctx, config);
  const includeId = String(config.includeId ?? DEFAULT_INCLUDE_ID);
  const recent = installLogTap(ctx);
  const env = {
    basePath,
    storeFile,
    includeId,
    recent,
    exclusive: createMutex(),
  };

  ensureStoreFile(storeFile);
  ctx.logger.info(`mcp-panel: 面板 ${basePath} · 服务器列表 ${storeFile} · include 行 ${includeId}`);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: basePath,
        handler: (req, res) => handleRequest(ctx, env, req, res),
      }),
    "mcp-panel.routes",
  );

  recoverInclude(ctx, includeId);
}

export { apply, inject, name };
