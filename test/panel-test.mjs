/**
 * Standalone harness for @deepseek-ai/dsh-mcp-panel.
 * Fakes the tiny slice of the Cordis host the panel touches, then drives the
 * HTTP API the browser uses. Run: node mcp-panel-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const failures = [];
let checks = 0;
function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(label + (extra === undefined ? "" : ` -> ${typeof extra === "string" ? extra : JSON.stringify(extra)}`));
  console.log(`  FAIL ${label}`);
}

/* ------------------------------------------------------------------ fakes */

class FakeResponse {
  constructor() {
    this.status = 0;
    this.headers = {};
    this.body = "";
    this.headersSent = false;
    this.finished = false;
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers ?? {};
    this.headersSent = true;
  }
  end(body) {
    this.body = body === undefined ? "" : String(body);
    this.finished = true;
  }
}

class FakeRequest extends EventEmitter {
  constructor(method, url, payload) {
    super();
    this.method = method;
    this.url = url;
    this.destroyed = false;
    if (payload !== undefined) {
      this.bodyText = typeof payload === "string" ? payload : JSON.stringify(payload);
    }
  }
  destroy() {
    this.destroyed = true;
  }
  start() {
    if (this.bodyText !== undefined) this.emit("data", Buffer.from(this.bodyText, "utf8"));
    this.emit("end");
  }
}

function makeHost({ profileDir, storeFile, withInclude = true, entries = [] }) {
  const includeTree = {
    entries() {
      return entries[Symbol.iterator]();
    },
    async refresh() {
      host.refreshes += 1;
    },
    async await() {},
  };
  const includeEntry = {
    options: { id: "mcp-servers", name: "cordis:include", config: { path: "mcp-servers.json" } },
    subtree: includeTree,
    fiber: { state: 2 },
    disabled: false,
    parent: { tree: { ctx: { baseUrl: "file:///C:/fake/profiles/web/" } } },
  };
  for (const entry of entries) entry.parent = { tree: includeTree };

  const host = {
    refreshes: 0,
    logs: [],
    route: null,
    disposers: [],
    profile: { dir: profileDir },
    ctx: {
      get(name) {
        if (name === "profileContext") return host.profile;
        return undefined;
      },
      logger: Object.assign(
        (...args) => host.logs.push(args),
        {
          info: (...args) => host.logs.push(["info", ...args]),
          warn: (...args) => host.logs.push(["warn", ...args]),
          error: (...args) => host.logs.push(["error", ...args]),
          debug: (...args) => host.logs.push(["debug", ...args]),
          exporter(exporter) {
            host.exporter = exporter;
            return () => {};
          },
        },
      ),
      effect(factory) {
        const disposer = factory();
        host.disposers.push(disposer);
        return disposer;
      },
      webServer: {
        register(route) {
          host.route = route;
          return () => {
            host.route = null;
          };
        },
      },
      tools: { schemas: () => [] },
      loader: {
        entries() {
          return withInclude ? [includeEntry, ...entries][Symbol.iterator]() : [][Symbol.iterator]();
        },
        async await() {},
      },
    },
  };
  host.storeFile = storeFile;
  return host;
}

/* --------------------------------------------------------------- requests */

async function request(host, method, path, payload) {
  const res = new FakeResponse();
  const req = new FakeRequest(method, path, payload);
  const handler = host.route.handler;
  const pending = handler(req, res);
  req.start();
  await pending;
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text: res.body, headers: res.headers };
}

/* ------------------------------------------------------------------- main */

const panelModule = await import("../lib/index.js");
const dir = mkdtempSync(join(tmpdir(), "mcp-panel-test-"));
const storeFile = join(dir, "mcp-servers.json");
writeFileSync(
  storeFile,
  JSON.stringify(
    [
      {
        id: "mcp-godot",
        name: "@deepseek-ai/dsh-mcp-client",
        disabled: true,
        config: {
          serverName: "godot",
          transport: "stdio",
          command: "C:\\does\\not\\exist\\godot-mcp.exe",
        },
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const managedEntry = {
  options: { id: "mcp-godot", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "godot", transport: "stdio" }, disabled: true },
  fiber: undefined,
  disabled: true,
  subtree: undefined,
};
const liveEntries = [managedEntry];
const host = makeHost({ profileDir: dir, storeFile, entries: liveEntries });

console.log("apply()");
panelModule.apply(host.ctx, { path: "/mcp", store: "mcp-servers.json", includeId: "mcp-servers" });
check("route registered at /mcp", host.route?.path === "/mcp" && host.route?.kind === "prefix", host.route);
check("logger exporter registered", typeof host.exporter?.export === "function");

console.log("GET page / assets");
const page = await request(host, "GET", "/mcp");
check("page 200", page.status === 200, page.status);
check("page is html", /<title>MCP 服务面板<\/title>/.test(page.text));
check("page references /mcp/app.js", page.text.includes("/mcp/app.js"));
const css = await request(host, "GET", "/mcp/app.css");
check("css 200", css.status === 200 && css.text.includes("--bg"));
const js = await request(host, "GET", "/mcp/app.js");
check("app.js 200", js.status === 200 && js.text.includes("applyState"));

console.log("GET /api/state");
const initial = await request(host, "GET", "/mcp/api/state");
check("state 200", initial.status === 200, initial.status);
check("include installed", initial.body?.includeInstalled === true);
check("one managed server", initial.body?.servers?.length === 1, initial.body?.servers?.length);
check("managed flag set", initial.body?.servers?.[0]?.managed === true);
check("disabled phase", initial.body?.servers?.[0]?.phase === "disabled", initial.body?.servers?.[0]?.phase);
check("missing command warning", /找不到可执行文件/.test(initial.body?.servers?.[0]?.warning ?? ""), initial.body?.servers?.[0]?.warning);

console.log("POST /api/servers (valid)");
const created = await request(host, "POST", "/mcp/api/servers", {
  server: {
    serverName: "files",
    transport: "stdio",
    command: "node",
    args: "--root\nF:\\projects\\demo",
    env: "A=1\nB=2",
    cwd: "",
    toolCallTimeoutMs: "90000",
    reconnectAttempts: "4",
    autoReconnect: true,
    enabled: true,
  },
});
check("create 200", created.status === 200, created.text);
check("create returns 2 servers", created.body?.servers?.length === 2, created.body?.servers?.length);
const onDisk = JSON.parse(readFileSync(storeFile, "utf8"));
check("store has 2 rows", onDisk.length === 2, onDisk.length);
const filesRow = onDisk.find((row) => row.config.serverName === "files");
check("args split into array", JSON.stringify(filesRow?.config.args) === JSON.stringify(["--root", "F:\\projects\\demo"]), filesRow?.config.args);
check("env parsed", filesRow?.config.env?.A === "1" && filesRow?.config.env?.B === "2", filesRow?.config.env);
check("timeout stored", filesRow?.config.toolCallTimeoutMs === 90000, filesRow?.config.toolCallTimeoutMs);
check("reconnect stored", filesRow?.config.reconnect?.maxAttempts === 4, filesRow?.config.reconnect);
check("refresh called", host.refreshes === 1, host.refreshes);

console.log("validation");
const badName = await request(host, "POST", "/mcp/api/servers", { server: { serverName: "bad name!", transport: "stdio", command: "node" } });
check("bad name 400", badName.status === 400, badName.status);
check("bad name message", /名称只能包含/.test(badName.body?.error ?? ""), badName.body?.error);
const dup = await request(host, "POST", "/mcp/api/servers", { server: { serverName: "files", transport: "stdio", command: "node" } });
check("duplicate 409", dup.status === 409, dup.status);
const noCommand = await request(host, "POST", "/mcp/api/servers", { server: { serverName: "x", transport: "stdio", command: "" } });
check("missing command 400", noCommand.status === 400, noCommand.status);
const badUrl = await request(host, "POST", "/mcp/api/servers", { server: { serverName: "x", transport: "streamable-http", url: "nope" } });
check("bad url 400", badUrl.status === 400, badUrl.status);
const httpOk = await request(host, "POST", "/mcp/api/servers", {
  server: { serverName: "remote", transport: "streamable-http", url: "http://127.0.0.1:7777/mcp", headers: "X-K: v" },
});
check("http server 200", httpOk.status === 200, httpOk.text);
check("headers parsed", httpOk.body?.servers?.find((s) => s.serverName === "remote")?.headers?.["X-K"] === "v");

console.log("PUT /api/servers/files (rename + edit)");
const renamed = await request(host, "PUT", "/mcp/api/servers/files", {
  server: { serverName: "fs", transport: "stdio", command: "node", enabled: true },
});
check("rename 200", renamed.status === 200, renamed.text);
check("renamed present", renamed.body?.servers?.some((s) => s.serverName === "fs"));
check("old name gone", !renamed.body?.servers?.some((s) => s.serverName === "files"));
check("id follows name", JSON.parse(readFileSync(storeFile, "utf8")).some((row) => row.id === "mcp-fs"));

console.log("POST enabled");
const disabled = await request(host, "POST", "/mcp/api/servers/fs/enabled", { enabled: false });
check("disable 200", disabled.status === 200, disabled.text);
check("disabled flag on disk", JSON.parse(readFileSync(storeFile, "utf8")).find((row) => row.id === "mcp-fs")?.disabled === true);
const enabled = await request(host, "POST", "/mcp/api/servers/fs/enabled", { enabled: true });
check("enable clears flag", JSON.parse(readFileSync(storeFile, "utf8")).find((row) => row.id === "mcp-fs")?.disabled === undefined);

console.log("POST restart");
const restartMissing = await request(host, "POST", "/mcp/api/servers/nope/restart");
check("restart unknown 404", restartMissing.status === 404, restartMissing.status);

let disposeCalls = 0;
const restartable = {
  options: { id: "mcp-fs", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "fs", transport: "stdio" } },
  fiber: { state: 2, dispose: async () => { disposeCalls += 1; } },
  disabled: false,
  initCalls: 0,
  async init() { this.initCalls += 1; },
};
liveEntries.push(restartable);
const restarted = await request(host, "POST", "/mcp/api/servers/fs/restart");
check("restart 200", restarted.status === 200, restarted.text);
check("restart disposed old fiber", disposeCalls === 1, disposeCalls);
check("restart re-initialized entry", restartable.initCalls === 1, restartable.initCalls);

console.log("DELETE");
const removed = await request(host, "DELETE", "/mcp/api/servers/remote");
check("delete 200", removed.status === 200, removed.text);
check("remote gone", !removed.body?.servers?.some((s) => s.serverName === "remote"));
const removeUnknown = await request(host, "DELETE", "/mcp/api/servers/remote");
check("delete unknown 404", removeUnknown.status === 404, removeUnknown.status);

console.log("POST /api/reload with a hand-edited file");
writeFileSync(
  storeFile,
  JSON.stringify([{ id: "mcp-handmade", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "handmade", transport: "stdio", command: "node" } }], null, 2),
  "utf8",
);
const reloaded = await request(host, "POST", "/mcp/api/reload");
check("reload 200", reloaded.status === 200, reloaded.text);
check("handmade visible", reloaded.body?.servers?.some((s) => s.serverName === "handmade"));

console.log("broken store file");
writeFileSync(storeFile, "{ not json", "utf8");
const broken = await request(host, "GET", "/mcp/api/state");
check("broken store still 200", broken.status === 200, broken.status);
check("broken store error reported", /不是合法 JSON/.test(broken.body?.storeError ?? ""), broken.body?.storeError);
const brokenAdd = await request(host, "POST", "/mcp/api/servers", { server: { serverName: "ok", transport: "stdio", command: "node" } });
check("mutation on broken store 500", brokenAdd.status === 500, brokenAdd.status);

console.log("missing include row");
writeFileSync(storeFile, "[]", "utf8");
const bare = makeHost({ profileDir: dir, storeFile, withInclude: false });
panelModule.apply(bare.ctx, { path: "/mcp", store: "mcp-servers.json", includeId: "mcp-servers" });
const bareState = await request(bare, "GET", "/mcp/api/state");
check("includeInstalled false", bareState.body?.includeInstalled === false);
const bareAdd = await request(bare, "POST", "/mcp/api/servers", { server: { serverName: "x", transport: "stdio", command: "node" } });
check("save still succeeds", bareAdd.status === 200, bareAdd.status);
check("reloadError explains", /include/.test(bareAdd.body?.reloadError ?? ""), bareAdd.body?.reloadError);

console.log("unknown path");
const notFound = await request(host, "GET", "/mcp/nope");
check("404 for unknown path", notFound.status === 404, notFound.status);

console.log("log tap prefers the underlying cause");
writeFileSync(
  storeFile,
  JSON.stringify([{ id: "mcp-broken", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "broken", transport: "stdio", command: "nope" } }], null, 2),
  "utf8",
);
const emit = (text, type = "warn") =>
  bare.exporter.export({ type, ts: Date.now(), args: [text] });
emit("mcp-client(broken): connection attempt failed: Error: spawn nope ENOENT");
emit("mcp-client(broken): connection failed; retrying in 4000ms (attempt 2/10)");
emit("mcp-client(broken): reconnected and re-synced tools (attempt 1/10)", "info");
const withLog = await request(bare, "GET", "/mcp/api/state");
const brokenServer = withLog.body?.servers?.find((server) => server.serverName === "broken");
check("lastLog is the cause", /spawn nope ENOENT/.test(brokenServer?.lastLog?.text ?? ""), brokenServer?.lastLog);
check("lastLog is not progress", brokenServer?.lastLogIsProgress === false, brokenServer?.lastLogIsProgress);
emit("mcp-client(broken): connection failed; retrying in 8000ms (attempt 3/10)");
const progressOnly = await request(bare, "GET", "/mcp/api/state");
const brokenAfterProgress = progressOnly.body?.servers?.find((server) => server.serverName === "broken");
check("cause survives later progress", /spawn nope ENOENT/.test(brokenAfterProgress?.lastLog?.text ?? ""), brokenAfterProgress?.lastLog);
emit("mcp-client(other): connection attempt failed: boom");
const unattributed = await request(bare, "GET", "/mcp/api/state");
check("unrelated server not attributed", !unattributed.body?.servers?.some((server) => server.lastLog?.text === "boom"));

rmSync(dir, { recursive: true, force: true });

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
