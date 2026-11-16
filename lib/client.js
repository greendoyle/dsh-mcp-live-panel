/**
 * Browser half of dsh-mcp-live-panel: registers an "MCP panel" section in the
 * Web Settings navigation and embeds the host-rendered panel page in a frame.
 *
 * The host half serves the page at its configured `path` (default `/mcp`); the
 * frame here uses that default. Change the host `path` and this `src` together.
 */
window.__ModuleLoader__.load({
	id: "dsh-mcp-live-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.mcpLivePanel";

		/** Host-rendered panel path (must match the host half's `path`). */
		const PANEL_PATH = "/mcp";

		/** Settings section component: the panel page in an embedded frame. */
		function McpPanelSection() {
			return react_jsx_runtime.jsx("iframe", {
				src: PANEL_PATH,
				title: "MCP panel",
				style: {
					width: "100%",
					height: "calc(100vh - 240px)",
					minHeight: 480,
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: 10,
					background: "#101418"
				}
			});
		}

		/** Services required by the Settings registration. */
		const inject = ["slots"];

		/** Contribute the panel section to the Web Settings navigation. */
		function apply(ctx) {
			let label = () => "MCP panel";
			const locale = typeof ctx.get === "function" ? ctx.get("locale") : undefined;
			if (locale !== undefined) {
				locale.register(NS, "en", { section: "MCP panel" });
				locale.register(NS, "zh", { section: "MCP 面板" });
				const t = locale.bind(NS);
				label = () => t("section");
			}
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "mcp",
						order: 90,
						locale: NS,
						label
					},
					McpPanelSection
				)
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
