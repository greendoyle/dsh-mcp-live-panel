/**
 * Unit check for the browser half (lib/client.js) without a browser or a Host.
 * Fakes the client module loader, React's jsx runtime, the slots service and the
 * locale service, then drives `apply()`.
 *
 * Run: node test/client-test.mjs
 */
const failures = [];
let checks = 0;
function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(label + (extra === undefined ? "" : ` -> ${JSON.stringify(extra)}`));
  console.log(`  FAIL ${label}`);
}

/* ------------------------------------------------------- fake module loader */

let loaderSpec;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaderSpec = spec;
    },
  },
};

await import("../lib/client.js");
check("module registers with the client loader", loaderSpec !== undefined);
check("module id is the package name", loaderSpec?.id === "dsh-mcp-live-panel", loaderSpec?.id);

const reactStub = {
  jsx: (type, props) => ({ type, props }),
};
const client = loaderSpec.factory((name) => {
  if (name === "react/jsx-runtime") return reactStub;
  throw new Error(`unexpected require: ${name}`);
});
check("exports apply", typeof client.apply === "function");
check("exports inject", JSON.stringify(client.inject) === JSON.stringify(["slots"]), client.inject);
check("exports NS", typeof client.NS === "string" && client.NS.length > 0, client.NS);

/* ------------------------------------------------------------- fake services */

const dicts = {};
let active = "en";
const locale = {
  register(namespace, language, dict) {
    dicts[language] = { namespace, dict };
    return () => {};
  },
  bind() {
    return (key) => dicts[active]?.dict[key] ?? key;
  },
};

const injected = [];
const registered = [];
const slots = {
  inject(name, callback) {
    injected.push(name);
    return callback();
  },
  register(options, component) {
    registered.push({ options, component });
    return () => {};
  },
};

/** Client context with and without the optional locale service. */
function makeCtx(withLocale) {
  return {
    get(name) {
      return withLocale && name === "locale" ? locale : undefined;
    },
    slots,
  };
}

/* ------------------------------------------------------------ with locale */

client.apply(makeCtx(true));
check("injects settings.section", injected.includes("settings.section"));
check("registers one section", registered.length === 1, registered.length);
const section = registered[0];
check("section name", section.options.name === "settings.section", section.options.name);
check("section id", section.options.id === "mcp", section.options.id);
check("section order is numeric", typeof section.options.order === "number", section.options.order);
check("section declares its locale namespace", section.options.locale === client.NS, section.options.locale);
check("english label", section.options.label() === "MCP panel", section.options.label());
check("dictionary registered for en", dicts.en?.dict?.section === "MCP panel", dicts.en);
check("dictionary registered for zh", dicts.zh?.dict?.section === "MCP 面板", dicts.zh);
active = "zh";
check("label follows the active locale", section.options.label() === "MCP 面板", section.options.label());
active = "en";

/* ------------------------------------------------------- rendered component */

const element = section.component();
check("section renders an iframe", element.type === "iframe", element.type);
check("iframe points at the panel", element.props.src === "/mcp", element.props.src);
check("iframe is same-origin path", element.props.src.startsWith("/"), element.props.src);
check("iframe has a title", typeof element.props.title === "string" && element.props.title.length > 0, element.props.title);

/* --------------------------------------------------------- without locale */

registered.length = 0;
injected.length = 0;
client.apply(makeCtx(false));
check("still registers without locale", registered.length === 1, registered.length);
check("falls back to an english label", registered[0].options.label() === "MCP panel", registered[0].options.label());

/* ------------------------------------------------------------------ report */

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
