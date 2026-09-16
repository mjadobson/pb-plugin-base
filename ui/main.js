const XPB_PLUGINS_API = "/api/xpb/plugin-base";
const XPB_PLUGINS_ROUTE = "#/plugins";
const XPB_PLUGINS_EXTENSION = "pb-plugin-base";
const XPB_LAST_PLUGIN_STORAGE_KEY = "xpbPlugins.lastViewed";

// Load extension-specific styles once.
if (!document.querySelector("link[data-xpb-plugins-style]")) {
  document.head.appendChild(
    t.link({
      rel: "stylesheet",
      href: `/_/extensions/${XPB_PLUGINS_EXTENSION}/style.css`,
      "html-data-xpb-plugins-style": "true",
    }),
  );
}

const registry = store({
  remote: [],
  revision: 0,
  loading: false,
  loaded: false,
  error: null,
});

const localRegistrations = new Map();
const pendingRegistrations = Array.isArray(window.xpbPluginsPending)
  ? window.xpbPluginsPending
  : [];
window.xpbPluginsPending = pendingRegistrations;

function optionalRegistrationString(definition, field, { trim = false } = {}) {
  const value = definition[field];
  if (value == null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `xpbPlugins registration ${definition.name || "<unknown>"}: ${field} must be a string`,
    );
  }
  return trim ? value.trim() : value;
}

function normalizeRegistration(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError(
      "xpbPlugins.register() requires a plugin definition object",
    );
  }

  if (typeof definition.name !== "string") {
    throw new TypeError("xpbPlugins.register() requires name to be a string");
  }

  const name = definition.name.trim();
  if (!name) {
    throw new TypeError("xpbPlugins.register() requires a non-empty name");
  }

  if (definition.mount != null && typeof definition.mount !== "function") {
    throw new TypeError(
      `xpbPlugins registration ${name}: mount must be a function`,
    );
  }

  return {
    name,
    author: optionalRegistrationString(definition, "author", { trim: true }),
    icon: optionalRegistrationString(definition, "icon", { trim: true }),
    label: optionalRegistrationString(definition, "label"),
    description: optionalRegistrationString(definition, "description"),
    version: optionalRegistrationString(definition, "version"),
    mount: definition.mount || null,
  };
}

function register(definition) {
  const normalized = normalizeRegistration(definition);
  if (localRegistrations.has(normalized.name)) {
    throw new Error(
      `xpbPlugins registration ${normalized.name}: a local registration already exists`,
    );
  }

  const registration = {
    definition: normalized,
    token: Symbol(normalized.name),
  };
  localRegistrations.set(normalized.name, registration);
  registry.revision++;

  return () => {
    if (localRegistrations.get(normalized.name) !== registration) {
      return false;
    }

    localRegistrations.delete(normalized.name);
    registry.revision++;
    return true;
  };
}

function unregister(name) {
  name = String(name || "").trim();
  if (!name || !localRegistrations.has(name)) {
    return false;
  }

  localRegistrations.delete(name);
  registry.revision++;
  return true;
}

function parsePluginInfoResponse(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("xpb plugin registry response must be an array");
  }

  const result = [];
  const names = new Set();
  const optionalFields = ["author", "icon", "label", "description", "version"];

  for (const [index, valueEntry] of value.entries()) {
    if (
      valueEntry === null ||
      typeof valueEntry !== "object" ||
      Array.isArray(valueEntry)
    ) {
      throw new TypeError(
        `xpb plugin registry entry ${index} must be a non-null object`,
      );
    }
    if (typeof valueEntry.name !== "string" || !valueEntry.name.trim()) {
      throw new TypeError(
        `xpb plugin registry entry ${index} name must be a non-empty string`,
      );
    }

    const name = valueEntry.name.trim();
    if (names.has(name)) {
      throw new TypeError(
        `xpb plugin registry response contains duplicate name ${name}`,
      );
    }
    names.add(name);

    const entry = { name };
    for (const field of optionalFields) {
      if (!Object.prototype.hasOwnProperty.call(valueEntry, field)) {
        entry[field] = "";
        continue;
      }
      const fieldValue = valueEntry[field];
      if (typeof fieldValue !== "string") {
        throw new TypeError(
          `xpb plugin registry entry ${name}: ${field} must be a string`,
        );
      }
      entry[field] =
        field === "author" || field === "icon" ? fieldValue.trim() : fieldValue;
    }

    result.push(entry);
  }

  return result;
}

function entries() {
  // Explicitly depend on revision so registrations update an already-open page.
  registry.revision;

  const byName = new Map();

  for (const info of registry.remote) {
    if (!info?.name) {
      continue;
    }

    byName.set(info.name, {
      name: info.name,
      author: info.author || "other",
      icon: info.icon || "ri-puzzle-2-line",
      label: info.label || "",
      description: info.description || "",
      version: info.version || "",
      mount: null,
    });
  }

  for (const [name, registration] of localRegistrations) {
    const local = registration.definition;
    const current = byName.get(name) || {
      name,
      author: "other",
      icon: "ri-puzzle-2-line",
      label: "",
      description: "",
      version: "",
      mount: null,
    };

    byName.set(name, {
      ...current,
      ...local,
      // Empty optional metadata does not erase xpb-provided metadata.
      author: local.author || current.author,
      icon: local.icon || current.icon,
      label: local.label || current.label,
      description: local.description || current.description,
      version: local.version || current.version,
    });
  }

  return [...byName.values()].sort((a, b) => {
    return displayName(a).localeCompare(displayName(b));
  });
}

function displayName(plugin) {
  return plugin.label || plugin.name;
}

function multilineText(value) {
  const lines = String(value).split(/\r?\n/);
  const result = [];

  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      result.push(t.br());
    }
    result.push(document.createTextNode(line));
  }

  return result;
}

function groupedEntries() {
  const groups = new Map();

  for (const plugin of entries()) {
    const author = plugin.author || "other";
    const group = groups.get(author) || [];
    group.push(plugin);
    groups.set(author, group);
  }

  return [...groups.entries()].sort(([authorA], [authorB]) =>
    authorA.localeCompare(authorB),
  );
}

window.xpbPlugins = {
  apiVersion: 1,
  register,
  unregister,
  get(name) {
    return entries().find((entry) => entry.name === name) || null;
  },
  all() {
    return entries();
  },
  flushPending: flushPendingRegistrations,
};

function flushPendingRegistrations() {
  let registered = 0;

  while (pendingRegistrations.length) {
    const definition = pendingRegistrations.shift();
    try {
      register(definition);
      registered++;
    } catch (err) {
      console.error(
        "Failed to register pending xpb plugin UI",
        err,
        definition,
      );
    }
  }

  return registered;
}

flushPendingRegistrations();

async function loadPluginInfo() {
  if (registry.loading) {
    return false;
  }

  registry.loading = true;
  registry.error = null;

  try {
    const result = await app.pb.send(XPB_PLUGINS_API, { method: "GET" });
    registry.remote = parsePluginInfoResponse(result);
    registry.loaded = true;
    return true;
  } catch (err) {
    registry.loaded = false;
    registry.error = err;
    if (!err?.isAbort) {
      app.checkApiError?.(err);
    }
    return false;
  } finally {
    registry.loading = false;
  }
}

function pluginSidebar(selectedName) {
  return app.components.pageSidebar(
    {
      pbEvent: "xpbPluginsSidebar",
      className: "xpb-plugins-sidebar",
    },
    t.nav({ className: "sidebar-content scrollable" }, () => {
      const result = entries();

      if (!result.length && registry.loading) {
        return t.div(
          { className: "xpb-plugins-sidebar-state" },
          t.span({ className: "loader" }),
        );
      }

      if (!result.length) {
        return t.div(
          { className: "xpb-plugins-sidebar-state txt-hint" },
          "No plugins registered.",
        );
      }

      return groupedEntries().map(([author, plugins]) => {
        return t.details(
          {
            className: "nav-group",
            "html-data-group": author,
            open: true,
          },
          t.summary(
            {
              tabIndex: -1,
              onfocusout: () => false,
              onclick: () => false,
              onkeyup: () => false,
            },
            author,
          ),
          () =>
            plugins.map((plugin) => {
              const href = `${XPB_PLUGINS_ROUTE}/${encodeURIComponent(plugin.name)}`;
              return t.a(
                {
                  rid: plugin.name,
                  href,
                  className: () =>
                    `nav-item ${selectedName === plugin.name ? "active" : ""}`,
                },
                t.i({ className: plugin.icon, ariaHidden: true }),
                t.span({ className: "txt", textContent: displayName(plugin) }),
              );
            }),
        );
      });
    }),
  );
}

function pluginMetadata(plugin) {
  const current = () => window.xpbPlugins.get(plugin.name) || plugin;

  return t.div(
    { className: "xpb-plugin-meta" },
    () => {
      const description = current().description;
      return description
        ? t.p({ className: "txt-hint" }, ...multilineText(description))
        : null;
    },
  );
}

function pluginMountError(container) {
  container.replaceChildren(
    t.div(
      { className: "alert danger" },
      "This plugin's UI failed to mount. Check the browser console for details.",
    ),
  );
}

function runCleanup(cleanup, pluginName, container) {
  if (typeof cleanup !== "function") {
    return;
  }

  try {
    const result = cleanup(container);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch((err) => {
        console.error(
          `Failed to clean up xpb plugin UI for ${pluginName}`,
          err,
        );
      });
    }
  } catch (err) {
    console.error(`Failed to clean up xpb plugin UI for ${pluginName}`, err);
  }
}

function applyMountResult(result, container, lifecycle, pluginName) {
  if (result == null) {
    return;
  }

  if (typeof result === "function") {
    if (lifecycle.mounted) {
      lifecycle.cleanup = result;
    } else {
      runCleanup(result, pluginName, container);
    }
    return;
  }

  if (result instanceof Node) {
    if (lifecycle.mounted) {
      container.replaceChildren(result);
    }
    return;
  }

  if (Array.isArray(result)) {
    if (!result.every((item) => item instanceof Node)) {
      throw new TypeError(
        `xpb plugin UI mount for ${pluginName} returned an array containing a non-Node value`,
      );
    }
    if (lifecycle.mounted) {
      container.replaceChildren(...result);
    }
    return;
  }

  throw new TypeError(
    `xpb plugin UI mount for ${pluginName} returned an unsupported value`,
  );
}

function isAbortFailure(err, signal) {
  return (
    signal.aborted && (err === signal.reason || err?.name === "AbortError")
  );
}

function pluginMount(plugin) {
  if (!plugin?.mount) {
    return null;
  }

  let lifecycle;

  return t.div({
    className: "xpb-plugin-mount",
    "html-data-plugin": plugin.name,
    onmount: (container) => {
      const controller = new AbortController();
      const instance = {
        cleanup: null,
        controller,
        mounted: true,
      };
      lifecycle = instance;

      const context = {
        app,
        t,
        store: typeof store === "function" ? store : undefined,
        watch: typeof watch === "function" ? watch : undefined,
        signal: controller.signal,
        plugin,
        registry: window.xpbPlugins,
      };

      const handleFailure = (err) => {
        if (isAbortFailure(err, controller.signal)) {
          return;
        }
        console.error(`Failed to mount xpb plugin UI for ${plugin.name}`, err);
        if (instance.mounted) {
          pluginMountError(container);
        }
      };

      try {
        const result = plugin.mount(container, context);

        if (result && typeof result.then === "function") {
          Promise.resolve(result)
            .then((resolved) => {
              try {
                applyMountResult(resolved, container, instance, plugin.name);
              } catch (err) {
                handleFailure(err);
              }
            })
            .catch(handleFailure);
        } else {
          applyMountResult(result, container, instance, plugin.name);
        }
      } catch (err) {
        handleFailure(err);
      }
    },
    onunmount: (container) => {
      if (!lifecycle || !lifecycle.mounted) {
        return;
      }

      lifecycle.mounted = false;
      lifecycle.controller.abort();
      const cleanup = lifecycle.cleanup;
      lifecycle.cleanup = null;
      runCleanup(cleanup, plugin.name, container);
    },
  });
}

function requestedPluginName(route) {
  const routeValue = route?.params?.plugin;
  if (routeValue == null || routeValue === "") {
    return "";
  }
  if (typeof routeValue !== "string") {
    return null;
  }

  try {
    return decodeURIComponent(routeValue) || null;
  } catch (_err) {
    return null;
  }
}

function lastViewedPluginName() {
  try {
    return window.localStorage?.getItem(XPB_LAST_PLUGIN_STORAGE_KEY) || "";
  } catch (_err) {
    return "";
  }
}

function rememberPluginName(name) {
  try {
    window.localStorage?.setItem(XPB_LAST_PLUGIN_STORAGE_KEY, name);
  } catch (_err) {
    // Storage may be unavailable (for example in a restricted browser context).
  }
}

function pluginPageState(requestedName) {
  const available = entries();

  if (requestedName === "") {
    const rememberedName = lastViewedPluginName();
    return {
      available,
      selected:
        available.find((plugin) => plugin.name === rememberedName) ||
        available[0] ||
        null,
      missing: false,
    };
  }

  const selected =
    typeof requestedName === "string"
      ? available.find((plugin) => plugin.name === requestedName) || null
      : null;

  if (selected) {
    rememberPluginName(selected.name);
  }

  return {
    available,
    selected,
    missing: registry.loaded && !registry.loading && !selected,
  };
}

function pagePlugins(route) {
  app.store.title = "Plugins";

  if (!registry.loaded && !registry.loading) {
    loadPluginInfo();
  }

  const requestedName = requestedPluginName(route);

  return t.div(
    {
      pbEvent: "pageXpbPlugins",
      className: "page page-xpb-plugins",
    },
    () => {
      const state = pluginPageState(requestedName);
      return pluginSidebar(state.selected?.name || "");
    },
    t.div(
      { className: "page-content full-height" },
      t.header(
        { className: "page-header" },
        t.nav(
          { className: "breadcrumbs" },
          t.div({ className: "breadcrumb-item" }, "Plugins"),
          () => {
            const state = pluginPageState(requestedName);
            return state.selected
              ? t.div(
                  { className: "breadcrumb-item" },
                  displayName(state.selected),
                  " ",
                  state.selected.version
                    ? t.span({
                        className: "label",
                        textContent: state.selected.version,
                      })
                    : null,
                )
              : null;
          },
        ),
      ),
      t.div({ className: "wrapper m-b-base" }, () => {
        if (registry.loading && !entries().length) {
          return t.div(
            { className: "block txt-center" },
            t.span({ className: "loader lg" }),
          );
        }

        const state = pluginPageState(requestedName);

        if (registry.error) {
          return t.div(
            { className: "block" },
            t.h4(null, "Plugin registry failed to load"),
            t.p(
              { className: "txt-hint" },
              "The plugin registry response was unavailable or invalid.",
            ),
            t.button(
              {
                className: "btn",
                type: "button",
                disabled: () => registry.loading,
                onclick: () => {
                  void loadPluginInfo();
                },
              },
              "Retry",
            ),
          );
        }

        if (state.missing) {
          return t.div(
            { className: "block" },
            t.h4(null, "Plugin not found"),
            t.p({
              className: "txt-hint",
              textContent:
                typeof requestedName === "string"
                  ? `No registered plugin matches "${requestedName}".`
                  : "The requested plugin name is invalid.",
            }),
          );
        }

        if (!state.selected) {
          return t.div(
            { className: "block" },
            t.h4(null, "No plugins registered"),
            t.p(
              { className: "txt-hint" },
              "No xpb plugins are currently registered.",
            ),
          );
        }

        return t.div(
          { rid: state.selected.name, className: "block xpb-plugin-panel" },
          pluginMetadata(state.selected),
          () =>
            state.selected.mount
              ? t.div(
                  { className: "xpb-plugin-base" },
                  t.hr(),
                  pluginMount(state.selected),
                )
              : null,
        );
      }),
      t.footer({ className: "page-footer" }, app.components.credits()),
    ),
  );
}

app.store.headerLinks.push({
  href: XPB_PLUGINS_ROUTE,
  icon: "ri-puzzle-2-line",
  label: "Plugins",
});

app.routes.superuserOnly(XPB_PLUGINS_ROUTE, pagePlugins);
app.routes.superuserOnly(`${XPB_PLUGINS_ROUTE}/{plugin}`, pagePlugins);
