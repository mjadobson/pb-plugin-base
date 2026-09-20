import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(testDir, "..");
const mainSource = fs.readFileSync(path.join(repoDir, "ui/main.js"), "utf8");

function createHarness({
  pending = [],
  sendResult = [],
  stored = {},
  storeImpl = (value) => value,
  watchImpl,
} = {}) {
  const consoleErrors = [];
  const apiErrors = [];
  const routes = new Map();

  class FakeNode {
    constructor(tag = "node", args = []) {
      this.tag = tag;
      this.args = args;
      this.props =
        args[0] &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0]) &&
        !(args[0] instanceof FakeNode)
          ? args[0]
          : {};
      this.children = [];
    }

    replaceChildren(...children) {
      this.children = children;
    }
  }

  const t = new Proxy(
    {},
    {
      get(_target, tag) {
        return (...args) => new FakeNode(String(tag), args);
      },
    },
  );

  const document = {
    querySelector() {
      return null;
    },
    head: {
      appendChild() {},
    },
    createTextNode(value) {
      const node = new FakeNode("#text");
      node.textContent = String(value);
      return node;
    },
  };

  const storage = new Map(Object.entries(stored));
  const window = {
    xpbPluginsPending: [...pending],
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
  };

  const app = {
    pb: {
      async send() {
        if (typeof sendResult === "function") {
          return sendResult();
        }
        return sendResult;
      },
    },
    store: {
      headerLinks: [],
      title: "",
    },
    components: {
      pageSidebar(...args) {
        return new FakeNode("pageSidebar", args);
      },
      credits() {
        return new FakeNode("credits");
      },
    },
    routes: {
      superuserOnly(route, handler) {
        routes.set(route, handler);
      },
    },
    checkApiError(err) {
      apiErrors.push(err);
    },
  };

  const context = vm.createContext({
    AbortController,
    Node: FakeNode,
    app,
    console: {
      error(...args) {
        consoleErrors.push(args);
      },
      warn() {},
      log() {},
    },
    document,
    setTimeout,
    clearTimeout,
    store: storeImpl,
    watch: watchImpl,
    t,
    window,
  });

  const exportsSource = `
    ;globalThis.__xpbTest = {
      registry,
      localRegistrations,
      normalizeRegistration,
      register,
      unregister,
      parsePluginInfoResponse,
      entries,
      flushPendingRegistrations,
      loadPluginInfo,
      pluginSidebar,
      pluginRegistryFailure,
      pluginMount,
      pluginPageState,
      requestedPluginName,
      pagePlugins,
    };
  `;

  vm.runInContext(mainSource + exportsSource, context, {
    filename: "ui/main.js",
  });

  return {
    app,
    apiErrors,
    consoleErrors,
    context,
    FakeNode,
    routes,
    testApi: context.__xpbTest,
    window,
  };
}

let shablonResolution;

function loadResolvedShablon(t) {
  if (!shablonResolution) {
    try {
      const moduleInfo = execFileSync(
        "go",
        [
          "list",
          "-m",
          "-f",
          "{{.Version}}|{{.Dir}}",
          "github.com/pocketbase/pocketbase",
        ],
        { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      const separator = moduleInfo.indexOf("|");
      const version = moduleInfo.slice(0, separator);
      const moduleDir = moduleInfo.slice(separator + 1);
      assert.equal(version, "v0.40.4");
      shablonResolution = {
        source: fs.readFileSync(
          path.join(moduleDir, "ui/public/libs/shablon/shablon.iife.js"),
          "utf8",
        ),
      };
    } catch (error) {
      shablonResolution = { error };
    }
  }

  if (shablonResolution.error) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw shablonResolution.error;
    }
    t.skip(
      "resolved PocketBase/Shablon integration requires the Go 1.27 toolchain/module cache",
    );
    return null;
  }

  const source = shablonResolution.source;
  const listeners = new Map();
  const shablonWindow = {
    location: { hash: "#/" },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };

  const context = vm.createContext({
    URLSearchParams,
    clearTimeout,
    console,
    queueMicrotask,
    setTimeout,
    window: shablonWindow,
  });
  vm.runInContext(
    `RegExp.escape ||= (value) => String(value).replace(/[\\^$.*+?()[\\]{}|/]/g, "\\\\$&");`,
    context,
  );
  vm.runInContext(source, context, { filename: "shablon.iife.js" });

  function navigate(hash) {
    shablonWindow.location.hash = hash;
    for (const handler of listeners.get("hashchange") || []) {
      handler();
    }
  }

  return { window: shablonWindow, navigate };
}

function nodeText(node) {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (node.textContent) {
    return node.textContent;
  }
  if (!Array.isArray(node.args)) {
    return "";
  }
  return node.args.map((value) => nodeText(value)).join(" ");
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

test("public browser API exposes the version 1 contract", () => {
  const { window } = createHarness();

  assert.equal(window.xpbPlugins.apiVersion, 1);
  for (const method of [
    "register",
    "unregister",
    "flushPending",
    "get",
    "all",
  ]) {
    assert.equal(typeof window.xpbPlugins[method], "function");
  }
});

test("pending registrations are order independent", () => {
  const harness = createHarness({
    pending: [{ name: "early", label: "Early plugin" }],
  });

  assert.equal(harness.window.xpbPlugins.get("early").label, "Early plugin");
  assert.equal(harness.window.xpbPluginsPending.length, 0);

  harness.window.xpbPluginsPending.push({ name: "late" });
  harness.window.xpbPlugins.flushPending();
  assert.equal(harness.window.xpbPlugins.get("late").name, "late");
});

test("invalid pending registrations are consumed without blocking later entries", () => {
  const harness = createHarness({
    pending: [
      { name: "" },
      { name: "valid-after-error", label: "Still registered" },
    ],
  });

  assert.equal(harness.window.xpbPluginsPending.length, 0);
  assert.equal(
    harness.window.xpbPlugins.get("valid-after-error").label,
    "Still registered",
  );
  assert.equal(harness.consoleErrors.length, 1);

  harness.window.xpbPlugins.flushPending();
  assert.equal(harness.consoleErrors.length, 1);
});

test("Map-backed registrations safely support object-special names", () => {
  const { window } = createHarness();

  window.xpbPlugins.register({ name: "__proto__" });
  window.xpbPlugins.register({ name: "constructor" });

  assert.equal(window.xpbPlugins.get("__proto__").name, "__proto__");
  assert.equal(window.xpbPlugins.get("constructor").name, "constructor");
});

test("duplicate registrations are rejected and stale disposers are harmless", () => {
  const { window } = createHarness();

  const disposeFirst = window.xpbPlugins.register({
    name: "demo",
    label: "first",
  });
  assert.throws(
    () => window.xpbPlugins.register({ name: "demo", label: "duplicate" }),
    /already exists/,
  );

  assert.equal(window.xpbPlugins.unregister("demo"), true);
  const disposeSecond = window.xpbPlugins.register({
    name: "demo",
    label: "second",
  });

  assert.equal(disposeFirst(), false);
  assert.equal(window.xpbPlugins.get("demo").label, "second");
  assert.equal(disposeSecond(), true);
  assert.equal(disposeSecond(), false);
});

test("unregister rejects non-string names without coercion", () => {
  const { window } = createHarness();
  window.xpbPlugins.register({ name: "demo" });

  assert.equal(
    window.xpbPlugins.unregister({ toString: () => "demo" }),
    false,
  );
  assert.equal(window.xpbPlugins.get("demo").name, "demo");
  assert.equal(window.xpbPlugins.unregister(" demo "), true);
});

test("frontend and backend metadata normalization is consistent", () => {
  const { testApi, window } = createHarness();

  assert.throws(() => testApi.parsePluginInfoResponse({}), /must be an array/);
  assert.throws(
    () => testApi.parsePluginInfoResponse([{ name: "a" }, { name: "a" }]),
    /duplicate name/,
  );
  assert.throws(
    () => testApi.parsePluginInfoResponse([{ name: "a", version: 1 }]),
    /version must be a string/,
  );
  assert.throws(
    () => testApi.parsePluginInfoResponse([{ name: "a", author: null }]),
    /author must be a string/,
  );

  testApi.registry.remote = testApi.parsePluginInfoResponse([
    {
      name: " demo ",
      author: " backend-author ",
      icon: " ri-server-line ",
      label: " Backend label ",
      description: "  Backend line one\nBackend line two  ",
      version: " v1.2.3 ",
    },
  ]);
  testApi.registry.loaded = true;

  window.xpbPlugins.register({
    name: "demo",
    label: "   ",
    description: " \n ",
    version: " v2.0.0 ",
  });

  const entry = window.xpbPlugins.get("demo");
  assert.equal(entry.author, "backend-author");
  assert.equal(entry.icon, "ri-server-line");
  assert.equal(entry.label, "Backend label");
  assert.equal(entry.description, "Backend line one\nBackend line two");
  assert.equal(entry.version, "v2.0.0");
});

test("malformed backend responses become explicit retryable registry errors", async () => {
  const harness = createHarness({ sendResult: { unexpected: true } });

  assert.equal(await harness.testApi.loadPluginInfo(), false);
  assert.equal(harness.testApi.registry.loaded, false);
  assert.equal(harness.testApi.registry.loading, false);
  assert.match(harness.testApi.registry.error.message, /must be an array/);
  assert.equal(harness.apiErrors.length, 1);
});

test("backend failure leaves a usable local plugin selected and exposes retry UI", async () => {
  const harness = createHarness({
    sendResult() {
      throw new Error("registry unavailable");
    },
  });
  const mount = () => null;
  harness.window.xpbPlugins.register({ name: "local", mount });

  assert.equal(await harness.testApi.loadPluginInfo(), false);
  const state = harness.testApi.pluginPageState("");
  assert.equal(state.selected.name, "local");
  assert.equal(state.selected.mount, mount);
  assert.ok(harness.testApi.registry.error);

  const warning = harness.testApi.pluginRegistryFailure();
  assert.match(warning.props.className, /warning/);
  assert.match(nodeText(warning), /retry to reload metadata/i);
});

test("backend failure remains blocking when no plugin is usable", async () => {
  const harness = createHarness({
    sendResult() {
      throw new Error("registry unavailable");
    },
  });

  assert.equal(await harness.testApi.loadPluginInfo(), false);
  assert.equal(harness.testApi.pluginPageState("").selected, null);
  const failure = harness.testApi.pluginRegistryFailure({ blocking: true });
  assert.equal(failure.props.className, "block");
  assert.match(nodeText(failure), /registry failed to load/i);
});

test("registry retry succeeds without losing local registration", async () => {
  let attempts = 0;
  const harness = createHarness({
    sendResult() {
      attempts++;
      if (attempts === 1) {
        throw new Error("temporary failure");
      }
      return [{ name: "demo", label: "Backend label", version: "v1" }];
    },
  });
  const mount = () => null;
  harness.window.xpbPlugins.register({ name: "demo", label: "Local label", mount });

  assert.equal(await harness.testApi.loadPluginInfo(), false);
  assert.equal(harness.window.xpbPlugins.get("demo").mount, mount);

  assert.equal(await harness.testApi.loadPluginInfo(), true);
  const entry = harness.window.xpbPlugins.get("demo");
  assert.equal(entry.label, "Local label");
  assert.equal(entry.version, "v1");
  assert.equal(entry.mount, mount);
  assert.equal(harness.testApi.registry.error, null);
  assert.equal(attempts, 2);
});

test("authoritative registry hides unmatched frontend registrations and diagnoses them", async () => {
  const harness = createHarness({ sendResult: [{ name: "compiled" }] });
  harness.window.xpbPlugins.register({ name: "typo", label: "Typo" });

  assert.equal(harness.window.xpbPlugins.get("typo").label, "Typo");
  assert.equal(await harness.testApi.loadPluginInfo(), true);
  assert.equal(harness.window.xpbPlugins.get("typo"), null);
  assert.equal(harness.consoleErrors.length, 1);
  assert.match(String(harness.consoleErrors[0][0]), /no compiled xpb plugin/i);
});

test("frontend registration added after authoritative load is rejected and diagnosed", async () => {
  const harness = createHarness({ sendResult: [{ name: "compiled" }] });
  assert.equal(await harness.testApi.loadPluginInfo(), true);

  harness.window.xpbPlugins.register({ name: "late-typo" });
  assert.equal(harness.window.xpbPlugins.get("late-typo"), null);
  assert.equal(harness.consoleErrors.length, 1);
});

test("later registry refresh can validate an existing frontend registration", async () => {
  let includeLocal = false;
  const harness = createHarness({
    sendResult() {
      return includeLocal ? [{ name: "local", label: "Backend" }] : [];
    },
  });
  const mount = () => null;
  harness.window.xpbPlugins.register({ name: "local", label: "Local", mount });

  assert.equal(await harness.testApi.loadPluginInfo(), true);
  assert.equal(harness.window.xpbPlugins.get("local"), null);

  includeLocal = true;
  assert.equal(await harness.testApi.loadPluginInfo(), true);
  const entry = harness.window.xpbPlugins.get("local");
  assert.equal(entry.label, "Local");
  assert.equal(entry.mount, mount);
});

test("failed refresh preserves the last authoritative registry snapshot", async () => {
  let fail = false;
  const harness = createHarness({
    sendResult() {
      if (fail) {
        throw new Error("refresh failed");
      }
      return [{ name: "compiled", label: "Compiled" }];
    },
  });

  assert.equal(await harness.testApi.loadPluginInfo(), true);
  fail = true;
  assert.equal(await harness.testApi.loadPluginInfo(), false);
  assert.equal(harness.testApi.registry.loaded, true);
  assert.equal(harness.window.xpbPlugins.get("compiled").label, "Compiled");
});

test("explicit unknown plugin routes do not fall back to another plugin", () => {
  const { testApi } = createHarness();

  testApi.registry.remote = testApi.parsePluginInfoResponse([{ name: "known" }]);
  testApi.registry.loaded = true;

  const state = testApi.pluginPageState("missing");
  assert.equal(state.selected, null);
  assert.equal(state.missing, true);

  const rootState = testApi.pluginPageState("");
  assert.equal(rootState.selected.name, "known");
  assert.equal(rootState.missing, false);
});

test("requestedPluginName preserves already-decoded PocketBase route params exactly", () => {
  const { testApi } = createHarness();
  for (const name of [
    "foo%2Fbar",
    "literal%name",
    "foo%25bar",
    "with space",
    "ユニコード",
  ]) {
    assert.equal(testApi.requestedPluginName({ params: { plugin: name } }), name);
  }
  assert.equal(testApi.requestedPluginName({ params: { plugin: 123 } }), null);
  assert.equal(testApi.requestedPluginName({ params: {} }), "");
});

test("sidebar uses encoded machine-name links without fake disclosure semantics", () => {
  const harness = createHarness();
  harness.window.xpbPlugins.register({
    name: "foo%2Fbar",
    author: "author",
    label: "Display",
  });

  const sidebar = harness.testApi.pluginSidebar("foo%2Fbar");
  const nav = sidebar.args[1];
  const renderGroups = nav.args.find((value) => typeof value === "function");
  const groups = renderGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tag, "div");
  assert.equal(groups[0].args[1].tag, "div");
  assert.notEqual(groups[0].args[1].tag, "summary");

  const renderLinks = groups[0].args.find((value) => typeof value === "function");
  const links = renderLinks();
  assert.equal(links[0].tag, "a");
  assert.equal(links[0].props.href, "#/plugins/foo%252Fbar");
  assert.match(links[0].props.className(), /active/);
});

test("the plugins root restores the last explicitly viewed plugin", () => {
  const { testApi, window } = createHarness();

  testApi.registry.remote = testApi.parsePluginInfoResponse([
    { name: "alpha" },
    { name: "beta" },
  ]);
  testApi.registry.loaded = true;

  assert.equal(testApi.pluginPageState("").selected.name, "alpha");
  assert.equal(testApi.pluginPageState("beta").selected.name, "beta");
  assert.equal(window.localStorage.getItem("xpbPlugins.lastViewed"), "beta");
  assert.equal(testApi.pluginPageState("").selected.name, "beta");
});

test("a stale last-viewed plugin falls back to the first available plugin", () => {
  const { testApi } = createHarness({
    stored: { "xpbPlugins.lastViewed": "removed" },
  });

  testApi.registry.remote = testApi.parsePluginInfoResponse([
    { name: "available" },
  ]);

  assert.equal(testApi.pluginPageState("").selected.name, "available");
});

test("async mounts are aborted on unmount and late cleanup still runs", async () => {
  const harness = createHarness();
  const { FakeNode, testApi } = harness;
  const container = new FakeNode("container");

  let resolveMount;
  let signal;
  let cleanupCalls = 0;
  const mountPromise = new Promise((resolve) => {
    resolveMount = resolve;
  });

  const mountNode = testApi.pluginMount({
    name: "async",
    mount(_container, context) {
      signal = context.signal;
      return mountPromise;
    },
  });

  mountNode.props.onmount(container);
  assert.equal(signal.aborted, false);

  assert.doesNotThrow(() => mountNode.props.onunmount(container));
  assert.equal(signal.aborted, true);

  resolveMount(() => {
    cleanupCalls++;
  });
  await tick();

  assert.equal(cleanupCalls, 1);
});

test("cleanup failures are isolated from navigation lifecycle", () => {
  const harness = createHarness();
  const { FakeNode, testApi } = harness;
  const container = new FakeNode("container");

  const mountNode = testApi.pluginMount({
    name: "cleanup-error",
    mount() {
      return () => {
        throw new Error("cleanup failed");
      };
    },
  });

  mountNode.props.onmount(container);
  assert.doesNotThrow(() => mountNode.props.onunmount(container));
  assert.equal(harness.consoleErrors.length, 1);
  assert.match(String(harness.consoleErrors[0][0]), /Failed to clean up/);
});

test("rejected async cleanup is isolated from navigation lifecycle", async () => {
  const harness = createHarness();
  const { FakeNode, testApi } = harness;
  const container = new FakeNode("container");

  const mountNode = testApi.pluginMount({
    name: "async-cleanup-error",
    mount() {
      return () => Promise.reject(new Error("async cleanup failed"));
    },
  });

  mountNode.props.onmount(container);
  assert.doesNotThrow(() => mountNode.props.onunmount(container));
  await tick();

  assert.equal(harness.consoleErrors.length, 1);
  assert.match(String(harness.consoleErrors[0][0]), /Failed to clean up/);
});

test("invalid mount results are contained and rendered as a host error", () => {
  const harness = createHarness();
  const { FakeNode, testApi } = harness;
  const container = new FakeNode("container");

  const mountNode = testApi.pluginMount({
    name: "bad-result",
    mount() {
      return [new FakeNode("valid"), "not-a-node"];
    },
  });

  assert.doesNotThrow(() => mountNode.props.onmount(container));
  assert.equal(harness.consoleErrors.length, 1);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].tag, "div");
});

test("resolved PocketBase Shablon preserves machine names through route lookup", async (t) => {
  const shablon = loadResolvedShablon(t);
  if (!shablon) return;

  const names = [
    "foo%2Fbar",
    "literal%name",
    "foo%25bar",
    "with space",
    "ユニコード",
  ];
  const harness = createHarness();
  harness.testApi.registry.remote = harness.testApi.parsePluginInfoResponse(
    names.map((name) => ({ name })),
  );
  harness.testApi.registry.loaded = true;

  for (const name of names) {
    let routedName;
    let selectedName;
    shablon.window.location.hash = `#/plugins/${encodeURIComponent(name)}`;
    const destroy = shablon.window.router(
      {
        "#/plugins/{plugin}": (route) => {
          routedName = harness.testApi.requestedPluginName(route);
          selectedName = harness.testApi.pluginPageState(routedName).selected?.name;
        },
      },
      { fallbackPath: "#/plugins/fallback" },
    );
    await settle();
    assert.equal(routedName, name);
    assert.equal(selectedName, name);
    destroy();
  }
});

test("resolved Shablon reactivity observes async production registry changes", async (t) => {
  const shablon = loadResolvedShablon(t);
  if (!shablon) return;

  let resolveSend;
  const harness = createHarness({
    storeImpl: shablon.window.store,
    watchImpl: shablon.window.watch,
    sendResult: () => new Promise((resolve) => {
      resolveSend = resolve;
    }),
  });
  const seen = [];
  const watcher = shablon.window.watch(
    () => harness.testApi.pluginPageState("").selected?.name || "",
    (value) => seen.push(value),
  );

  const loading = harness.testApi.loadPluginInfo();
  resolveSend([{ name: "async-loaded" }]);
  assert.equal(await loading, true);
  await settle();

  assert.equal(harness.window.xpbPlugins.get("async-loaded").name, "async-loaded");
  assert.ok(seen.includes("async-loaded"));
  watcher.unwatch();
});

test("resolved Shablon navigation cleans up production plugin mounts exactly once", async (t) => {
  const shablon = loadResolvedShablon(t);
  if (!shablon) return;

  const harness = createHarness();
  const containerA = new harness.FakeNode("container-a");
  const containerB = new harness.FakeNode("container-b");
  let cleanupA = 0;
  let cleanupB = 0;

  const mountA = harness.testApi.pluginMount({
    name: "a",
    mount() {
      return () => {
        cleanupA++;
      };
    },
  });
  const mountB = harness.testApi.pluginMount({
    name: "b",
    mount() {
      return () => {
        cleanupB++;
      };
    },
  });

  shablon.window.location.hash = "#/plugins/a";
  const destroy = shablon.window.router(
    {
      "#/plugins/a": () => {
        mountA.props.onmount(containerA);
        return () => mountA.props.onunmount(containerA);
      },
      "#/plugins/b": () => {
        mountB.props.onmount(containerB);
        return () => mountB.props.onunmount(containerB);
      },
    },
    { fallbackPath: "#/plugins/a" },
  );
  await settle();

  shablon.navigate("#/plugins/b");
  await settle();
  assert.equal(cleanupA, 1);
  assert.equal(cleanupB, 0);

  destroy();
  await settle();
  assert.equal(cleanupA, 1);
  assert.equal(cleanupB, 0);

  // PocketBase v0.40.4's bundled Shablon router destroy only unregisters
  // its hashchange listener; page removal owns the final mounted-node cleanup.
  mountB.props.onunmount(containerB);
  assert.equal(cleanupB, 1);
});


test("resolved Shablon navigation aborts async production mounts and runs late cleanup once", async (t) => {
  const shablon = loadResolvedShablon(t);
  if (!shablon) return;

  const harness = createHarness();
  const container = new harness.FakeNode("container-async");
  let resolveMount;
  let signal;
  let cleanupCalls = 0;
  const mountPromise = new Promise((resolve) => {
    resolveMount = resolve;
  });
  const mountNode = harness.testApi.pluginMount({
    name: "async-route",
    mount(_container, context) {
      signal = context.signal;
      return mountPromise;
    },
  });

  shablon.window.location.hash = "#/plugins/async";
  const destroy = shablon.window.router(
    {
      "#/plugins/async": () => {
        mountNode.props.onmount(container);
        return () => mountNode.props.onunmount(container);
      },
      "#/plugins/other": () => {},
    },
    { fallbackPath: "#/plugins/async" },
  );
  await settle();
  assert.equal(signal.aborted, false);

  shablon.navigate("#/plugins/other");
  await settle();
  assert.equal(signal.aborted, true);

  resolveMount(() => {
    cleanupCalls++;
  });
  await settle();
  assert.equal(cleanupCalls, 1);

  destroy();
  await settle();
  assert.equal(cleanupCalls, 1);
});
