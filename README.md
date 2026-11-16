# dsh-mcp-live-panel

给 **DeepSeek Harness (DSH)** 用的 MCP 服务面板：在 Web 界面里增删改 MCP 服务器、启用/停用、重连，**保存即生效** —— 不用改 `cordis.patch.yml`，也不用重启 Host。

![面板](docs/preview-list.png)

![编辑表单](docs/preview-editor.png)

---

## 它解决什么

DSH 把 MCP 服务器接进来自带一套 `@deepseek-ai/dsh-mcp-client`，但每个服务器都是配置里的一条 `insert` 行。于是：

- 加一个服务器要记住 schema（`transport` / `command` / `args` / `env` / `url` / `headers`…），改错一个字段就很难查；
- 命令写错（比如 `godot-mcp.exe` 装到了别处）时，客户端会按退避策略反复重试，控制台一直刷 `不是内部或外部命令`，界面上却什么都看不到；
- 停掉一个服务器、换个参数，都要手改 YAML 再重启。

这个插件把这份配置搬进一个由界面管理的文件：**服务器列表 = 面板里的一张张卡片**，改动通过 Loader 热更新，正在跑的 Host 立刻按新配置连接或断开。

## 安装

要求：DSH `0.2.0.x`、Node 22.19+ 或 24.9+、`pnpm` 在 `PATH` 里（DSH 的插件管理用 pnpm 装包）。

**方式一：命令行**

```bash
dsh plugin --profile web add dsh-mcp-live-panel
```

**方式二：Web 界面**

侧边栏 **Plugins → 添加插件**，填包名 `dsh-mcp-live-panel` → **安装** → **立即启用**。

装好后打开 **设置 → MCP 面板**（或直接访问 <http://127.0.0.1:3080/mcp>）。

> 安装的是 DSH 的 **bundle** 包：它的 `cordis.patch.yml` 会自己插入需要的两行，**你不需要改任何本地配置**。

## 用法

| 操作 | 位置 | 效果 |
| --- | --- | --- |
| 新增服务器 | 右上「＋ 新增服务器」 | 保存后立刻连接，工具以 `mcp__<名称>__<工具>` 注册 |
| 编辑 / 改名 | 卡片「编辑」 | 按新配置重启该服务器 |
| 启用 / 停用 | 卡片右侧开关 | 停用会断开进程并注销工具，不再重试 |
| 重连 | 卡片「重连」 | 只重连，不改配置（适合卡住时） |
| 删除 | 卡片「删除」 | 断开并把这条从列表移除 |
| 手改文件后 | 顶部「重新读取」 | 按文件内容重载 |

表单支持两种传输：

- **stdio**：启动命令、参数（每行一个）、环境变量（`KEY=VALUE` 每行）、工作目录；
- **streamable-http**：URL、请求头（`Key: Value` 每行）。

另外可设置工具调用超时、断线重连次数、是否启用；「连接失败时视为插件加载失败」一般不用开。

### 卡片上的诊断

- **找不到可执行文件或命令**：保存前后都会检查 `command`（绝对路径查文件、裸命令查 `PATH` + `PATHEXT`）。写错的命令会当场标出来，而不是静默重试。
- **最近一次报错**：Host 日志里 `mcp-client(<名称>):` 的记录按服务器归因，优先显示真正的失败原因（如 `spawn ... ENOENT`），而不是重试进度。
- **外部配置**：仍然写在 `cordis.patch.yml` 里的 `dsh-mcp-client` 行会以只读卡片显示，提醒你迁进面板，避免同一个 `serverName` 被两处占用。

## 工作原理

```
<profile>/cordis.patch.yml          ← 不需要手改
└── mcp-servers  (cordis:include)   ← 挂载下面这个文件
└── mcp-panel                       ← 本插件：页面 + API

<profile>/mcp-servers.json          ← 面板独占写入的 loader 条目列表
└── { id, name: '@deepseek-ai/dsh-mcp-client', config, disabled? }
```

面板每次改动都会：校验 → 原子写入 `mcp-servers.json` → 刷新 include 子树。Loader 自己 diff：新增条目连接、改动条目重启、删掉条目断开并注销工具。

因为服务器列表在 include 的**子树**里，改 profile 的 `cordis.patch.yml`（DSH 的配置热重载）不会把面板加的服务器冲掉。

## 配置（可选）

bundle patch 已给好默认值；需要时可以按 id 覆盖：

```yaml
- id: mcp-panel
  config:
    path: '/mcp'              # 页面与 API 的挂载路径
    includeId: 'mcp-servers'  # 挂载列表的那一行
    store: 'mcp-servers.json' # 相对 profile 目录，也接受绝对路径
```

> 如果 `/mcp` 已被别的插件占用，Loader 会因为路由重复让这一行加载失败；把 `path` 改成别的值（同时改 `lib/client.js` 里的 `PANEL_PATH`，或直接访问新路径）。

## 升级 / 卸载

- **升级**：DSH 的插件不会自动更新。`dsh plugin --profile web add dsh-mcp-live-panel@latest` 重新安装即可；面板里的服务器列表在 `mcp-servers.json`，升级不会丢。
- **卸载**：Plugins 页移除该 bundle（或 `dsh plugin --profile web remove dsh-mcp-live-panel`）。`mcp-servers.json` 会留在 profile 里，重新安装即可恢复。

### 如果你以前是手写配置的

把 `cordis.patch.yml` 里原来的 `mcp-godot` / `mcp-chrome-devtools` 之类 `dsh-mcp-client` 行删掉，再装本插件，然后在面板里重建这几条。两边同时存在会让同一个 `serverName` 冲突，也会让 `/mcp` 路由重复。

## 安全说明

- 插件运行在 Host 进程内，**拥有你的用户权限**：它会 spawn 你填写的命令、读写 profile 目录下的 `mcp-servers.json`。只添加你信任的 MCP 服务器。
- 页面与 API 只由 DSH 的 Web 服务器提供（默认 `127.0.0.1`），没有额外鉴权；不要把它暴露到公网。
- 环境变量会以明文保存在 `mcp-servers.json` 里，别在里面放长期凭证（需要时用 MCP 服务器自己的配置/环境注入）。

## 兼容性

- DSH **0.2.0.x**（`engines.dsh` 与 `peerDependencies` 同时声明，DSH 安装时会按 peer 范围校验，不匹配会直接拒绝安装而不是装完再崩）。
- 两个 peer 都标了 `optional`：它们只用于版本门禁，本插件不 `import` 任何 DSH 包，只通过 Cordis 服务取能力，所以不需要 pnpm 再把运行时包拉进 profile。
- 没有自动更新：升级 = 重新安装新版本。

## 开发

```bash
npm test                     # 宿主 55 项 + 浏览器半边 21 项断言
npm pack --dry-run           # 检查发布内容
```

`test/panel-test.mjs` 用假的 Cordis 上下文驱动真实插件代码（页面、状态、增删改、校验、日志归因）；
`test/client-test.mjs` 用假的模块加载器 / slots / locale 驱动浏览器半边。

仓库结构：

```
lib/index.js        宿主半边：store、HTTP API、资源服务、日志归因
lib/client.js       浏览器半边：设置页里的「MCP 面板」
assets/             页面 HTML/CSS/JS（每次请求读盘，改界面不用重启）
locale/             插件卡片的中英文标题/描述
cordis.patch.yml    bundle 层：插入 mcp-servers 与 mcp-panel 两行
test/               两个不依赖运行中 Host 的测试
```

## English quickstart

MCP server panel for DeepSeek Harness: add, edit, enable, restart and remove MCP servers from the Web GUI. Changes apply live — no config edits, no restart.

```bash
dsh plugin --profile web add dsh-mcp-live-panel
```

Then open **Settings → MCP panel** (or `http://127.0.0.1:3080/mcp`). Servers live in `<profile>/mcp-servers.json`, mounted by a `cordis:include` row that this bundle declares itself. Requires DSH 0.2.0.x and `pnpm` on `PATH`.

## License

MIT
