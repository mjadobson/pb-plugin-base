import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.join(testDir, "../ui/main.js"), "utf8");

function createHarness({ pending = [], sendResult = [], stored = {} } = {}) {
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
    store(value) {
      return value;
    },
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
      pluginMount,
      pluginPageState,
      requestedPluginName,
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

test("remote registry parsing is strict and local non-empty metadata wins", () => {
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
      name: "demo",
      author: "backend-author",
      icon: "ri-server-line",
      label: "Backend label",
      description: "Backend description",
      version: "v1.2.3",
    },
  ]);

  window.xpbPlugins.register({
    name: "demo",
    label: "Browser label",
    description: "",
  });

  const entry = window.xpbPlugins.get("demo");
  assert.equal(entry.label, "Browser label");
  assert.equal(entry.description, "Backend description");
  assert.equal(entry.version, "v1.2.3");
});

test("malformed backend responses become explicit retryable registry errors", async () => {
  const harness = createHarness({ sendResult: { unexpected: true } });

  assert.equal(await harness.testApi.loadPluginInfo(), false);

  assert.equal(harness.testApi.registry.loaded, false);
  assert.equal(harness.testApi.registry.loading, false);
  assert.match(harness.testApi.registry.error.message, /must be an array/);
  assert.equal(harness.apiErrors.length, 1);
});

test("registry loading can recover from a transient failure", async () => {
  let attempts = 0;
  const harness = createHarness({
    sendResult() {
      attempts++;
      if (attempts === 1) {
        throw new Error("temporary failure");
      }
      return [{ name: "recovered", label: "Recovered" }];
    },
  });

  assert.equal(await harness.testApi.loadPluginInfo(), false);
  assert.equal(harness.testApi.registry.loaded, false);
  assert.ok(harness.testApi.registry.error);

  assert.equal(await harness.testApi.loadPluginInfo(), true);
  assert.equal(harness.testApi.registry.loaded, true);
  assert.equal(harness.testApi.registry.error, null);
  assert.equal(harness.window.xpbPlugins.get("recovered").label, "Recovered");
  assert.equal(attempts, 2);
});

test("explicit unknown plugin routes do not fall back to another plugin", () => {
  const { testApi } = createHarness();

  testApi.registry.remote = testApi.parsePluginInfoResponse([
    { name: "known" },
  ]);
  testApi.registry.loaded = true;

  const state = testApi.pluginPageState("missing");
  assert.equal(state.selected, null);
  assert.equal(state.missing, true);

  const rootState = testApi.pluginPageState("");
  assert.equal(rootState.selected.name, "known");
  assert.equal(rootState.missing, false);
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

test("malformed encoded plugin routes are handled as missing", () => {
  const { testApi } = createHarness();
  testApi.registry.loaded = true;

  const requested = testApi.requestedPluginName({
    params: { plugin: "%E0%A4%A" },
  });
  assert.equal(requested, null);
  assert.equal(testApi.pluginPageState(requested).missing, true);
});
