# pb-plugin-base

An [xpb](https://github.com/pocketbuilds/xpb) plugin that adds a **Plugins** tab to the PocketBase Superuser UI.

Compiled xpb plugins are listed in a sidebar and the selected plugin is shown on the right. The host displays metadata supplied by each plugin and gives plugins an optional browser mount point for settings, status, or other controls.

The host deliberately does **not** define configuration persistence or generic enable/disable behaviour. Those belong to each individual plugin.

## Compatibility

| Dependency | Compatible versions |
| ---------- | ------------------- |
| PocketBase | `v0.40.x`           |
| xpb        | `v0.0.5`            |
| Go         | `1.27+`             |

PocketBase's Superuser UI extension API is experimental. Compatibility follows PocketBase's minor release line and should be rechecked before moving to a newer minor version.

## Install

For a reproducible build, pin the plugin version:

```sh
xpb build v0.40.4 --with github.com/mjadobson/pb-plugin-base@v0.1.0
```

For a custom Go application, blank-import it alongside your other xpb plugins so its `init()` registers it:

```go
import (
    _ "github.com/mjadobson/pb-plugin-base"
    _ "github.com/author/plugin-name"
)
```

Then initialize xpb as normal in your PocketBase application.

## Plugin identity and display names

The host keeps machine identity separate from what users see in the UI.

This package uses the xpb machine name `mjadobson_pb_plugin_base`, but implements `Label() string` so its visible label is simply **base**. Its PocketBase UI extension namespace is `pb-plugin-base`.

Other plugins can implement any combination of these optional methods on their plugin type:

```go
func (p *Plugin) Author() string {
    return "author"
}

func (p *Plugin) Icon() string {
    return "ri-puzzle-line"
}

func (p *Plugin) Label() string {
    return "My Plugin"
}
```

They are independent: a plugin may provide just a label, just an icon, or whichever combination it needs.

`Label()` affects display only; browser registrations and routes continue to use the plugin's xpb `Name()` as the stable identifier.

When `Author()` is absent, GitHub-hosted plugins are grouped by the repository owner inferred from their package path. xpb's own packages are grouped under `xpb`.

When `Icon()` is absent, the host uses `ri-puzzle-2-line`, with built-in fallbacks for xpb's `jsvm`, `cmd`, `migratecmd`, and `public_dir` plugins. Icons are [Remix Icon](https://remixicon.com/) class names.

## Browser registration API

Every compiled xpb plugin appears automatically because the page reads xpb's in-process registry through a local, superuser-only PocketBase endpoint. It does not query GitHub, a package registry, or another online service.

A plugin only needs browser-side registration when it wants to override display metadata or mount custom UI.

### Order-independent registration

UI extensions do not need to care whether this host's `main.js` executes before or after theirs. Queue the definition and ask the host to flush the queue if it is already available:

```js
const definition = {
  name: "slugify", // must match the Go plugin Name()
  author: "mjadobson", // optional
  icon: "ri-links-line", // optional Remix Icon class
  label: "Slugify", // optional display label

  async mount(container, { app, t, store, watch, signal, plugin, registry }) {
    const data = await loadSettings({ signal });

    return t.div(
      { className: "grid" },
      t.div(
        { className: "col-12" },
        t.p(null, `Custom settings for ${plugin.name}: ${data.summary}`),
      ),
    );
  },
};

(window.xpbPluginsPending ??= []).push(definition);
window.xpbPlugins?.flushPending();
```

The host drains `window.xpbPluginsPending` when it starts. If the host is already running, `flushPending()` registers anything just queued. Each queued definition is consumed once: invalid entries are logged and discarded so they cannot block or repeatedly poison later flushes. Duplicate browser registrations for the same plugin name are rejected rather than silently replacing one another.

For dynamic registrations made after the host exists, `register()` returns an idempotent disposer:

```js
const unregister = window.xpbPlugins.register(definition);

// Later:
unregister();
```

A stale disposer cannot remove a newer registration with the same name.

### Browser API version

`window.xpbPlugins.apiVersion` is currently `1`.

Within API version 1, new optional fields or methods may be added compatibly. A breaking change to registration semantics, mount lifecycle, or required fields will increment `apiVersion`.

The public API is:

```text
window.xpbPlugins.apiVersion
window.xpbPlugins.register(definition) -> disposer
window.xpbPlugins.unregister(name) -> boolean
window.xpbPlugins.flushPending()
window.xpbPlugins.get(name) -> plugin | null
window.xpbPlugins.all() -> plugin[]
```

## Mount lifecycle

`mount(container, context)` owns everything inside `container`.

It may return, either synchronously or through a Promise:

- nothing, after mutating `container` directly;
- a single DOM `Node`;
- an array containing only DOM `Node` values; or
- a cleanup function.

The context contains:

```text
app       PocketBase Superuser UI app object
t         PocketBase/Shablon element helpers
store     Shablon store helper, when available
watch     Shablon watch helper, when available
signal    AbortSignal for the current mount lifecycle
plugin    merged metadata for the selected plugin
registry  window.xpbPlugins
```

The host aborts `signal` when the plugin is unmounted. Async mount results that arrive after unmount are ignored, while a cleanup function that resolves late is executed immediately. Cleanup exceptions and rejected cleanup Promises are logged and isolated so they cannot break navigation.

A frontend registration may set `author`, `icon`, `label`, `description`, or `version`. Non-empty browser values override backend metadata; empty values leave backend metadata intact.

## Mounting UI from another Go plugin

A plugin that wants controls on the Plugins page should register its own PocketBase UI extension and enqueue a browser definition from that extension's `main.js`. The host deliberately does not own the other plugin's markup, state, or settings transport.

Example Go registration inside another plugin's `Init` method:

```go
//go:embed all:ui
var ui embed.FS

func (p *Plugin) Init(app core.App) error {
    uiFS, err := fs.Sub(ui, "ui")
    if err != nil {
        return err
    }

    app.OnServe().BindFunc(func(e *core.ServeEvent) error {
        e.UIExtensions = append(e.UIExtensions, core.UIExtension{
            Name: "slugify",
            FS:   uiFS,
        })
        return e.Next()
    })

    return nil
}
```

Its `ui/main.js` can use the order-independent queue example above.

## Metadata endpoint

The host exposes:

```text
GET /api/xpb/plugin-base
```

The route is protected by PocketBase's `RequireSuperuserAuth()` middleware.

Metadata is collected independently for each compiled plugin. If one third-party plugin panics while returning metadata, that plugin is skipped and the failure is logged instead of taking down the entire registry response.

## Security and trust model

This is a **trusted-code extension mechanism**, not a sandbox.

An installed xpb plugin already executes Go code inside the PocketBase process. A plugin that registers browser UI additionally executes JavaScript in the authenticated Superuser UI and receives the Superuser app object. Only compile and install plugins whose code you trust.

## Version injection

The package follows xpb's `var version = "dev"` convention. During `xpb build`, xpb injects each resolved module version into its package with linker flags. The Plugins page therefore displays versions from the modules actually compiled into the PocketBase executable.

No version or metadata lookup is performed over the network when PocketBase starts or when the Plugins page opens.

## Development

Run the Go and browser regression suites before publishing:

```sh
gofmt -w plugin.go plugin_test.go
git diff --check
go mod tidy
git diff --exit-code go.mod go.sum
go vet ./...
go test ./...
go test -race ./...
node --check ui/main.js
node --test webtest/main.test.mjs
govulncheck ./...
```

CI runs this validation on every push and pull request. It installs `govulncheck` from `golang.org/x/vuln/cmd/govulncheck@latest` before running the final scan.

The browser tests execute the production `ui/main.js` in a small VM harness and cover queued registration, special-name safety, duplicate registration/disposal, metadata merging and validation, missing routes, async mount cancellation, cleanup isolation, and invalid mount results.

## License

MIT
