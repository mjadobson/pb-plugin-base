package pluginbase

import (
	"io/fs"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbuilds/xpb"
)

func TestPluginMetadata(t *testing.T) {
	p := &plugin{}

	if p.Name() != pluginName {
		t.Fatalf("unexpected name: %q", p.Name())
	}
	if p.Label() != pluginLabel {
		t.Fatalf("unexpected label: %q", p.Label())
	}
	if p.Version() == "" {
		t.Fatal("version must not be empty")
	}
	if p.Author() != "mjadobson" {
		t.Fatalf("unexpected author: %q", p.Author())
	}
	icon, err := pluginIconName(p, "plugin", p.Name())
	if err != nil {
		t.Fatal(err)
	}
	if icon != "ri-puzzle-2-line" {
		t.Fatalf("unexpected icon: %q", icon)
	}
	if p.Description() == "" {
		t.Fatal("description must not be empty")
	}
}

func TestEmbeddedUI(t *testing.T) {
	uiFS, err := fs.Sub(embeddedUI, "ui")
	if err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"main.js", "style.css"} {
		if _, err := fs.Stat(uiFS, name); err != nil {
			t.Fatalf("missing embedded UI file %q: %v", name, err)
		}
	}
}

func TestRegisteredInXPB(t *testing.T) {
	for _, registeredPlugin := range xpb.GetPlugins() {
		if registeredPlugin.Name() == pluginName {
			return
		}
	}

	t.Fatalf("plugin %q was not registered with xpb", pluginName)
}

func TestRegisteredPluginInfoContainsSelf(t *testing.T) {
	infoList, metadataErrors := registeredPluginInfo()
	if len(metadataErrors) != 0 {
		t.Fatalf("unexpected metadata errors: %v", metadataErrors)
	}

	for _, info := range infoList {
		if info.Name == pluginName {
			if info.Label != pluginLabel {
				t.Fatalf("unexpected registered plugin label: %q", info.Label)
			}
			if info.Author != "mjadobson" {
				t.Fatalf("unexpected registered plugin author: %q", info.Author)
			}
			if info.Icon != "ri-puzzle-2-line" {
				t.Fatalf("unexpected registered plugin icon: %q", info.Icon)
			}
			if info.Description == "" {
				t.Fatal("registered plugin description must not be empty")
			}
			if info.Version == "" {
				t.Fatal("registered plugin version must not be empty")
			}
			return
		}
	}

	t.Fatalf("plugin metadata for %q was not returned", pluginName)
}

func TestAuthorFromPackagePath(t *testing.T) {
	tests := []struct {
		name        string
		packagePath string
		want        string
	}{
		{name: "xpb root", packagePath: "github.com/pocketbuilds/xpb", want: "xpb"},
		{name: "xpb child", packagePath: "github.com/pocketbuilds/xpb/plugins/cmd", want: "xpb"},
		{name: "xpb prefix lookalike", packagePath: "github.com/pocketbuilds/xpbfoo", want: "pocketbuilds"},
		{name: "github module", packagePath: "github.com/mjadobson/pb-plugin-slug", want: "mjadobson"},
		{name: "non github", packagePath: "example.com/acme/plugin", want: "other"},
		{name: "empty", packagePath: "", want: "other"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := authorFromPackagePath(tt.packagePath); got != tt.want {
				t.Fatalf("authorFromPackagePath(%q) = %q, want %q", tt.packagePath, got, tt.want)
			}
		})
	}
}

type minimalTestPlugin struct {
	name string
}

func (p *minimalTestPlugin) Init(core.App) error { return nil }
func (p *minimalTestPlugin) Name() string        { return p.name }
func (p *minimalTestPlugin) Version() string     { return "v1.0.0" }
func (p *minimalTestPlugin) Description() string { return "test plugin" }

type configurableMetadataPlugin struct {
	name        string
	panicMethod string
}

func (p *configurableMetadataPlugin) Init(core.App) error { return nil }
func (p *configurableMetadataPlugin) Name() string {
	if p.panicMethod == "Name" {
		panic("name panic")
	}
	return p.name
}
func (p *configurableMetadataPlugin) Author() string {
	if p.panicMethod == "Author" {
		panic("author panic")
	}
	return " author "
}
func (p *configurableMetadataPlugin) Icon() string {
	if p.panicMethod == "Icon" {
		panic("icon panic")
	}
	return " ri-test-line "
}
func (p *configurableMetadataPlugin) Label() string {
	if p.panicMethod == "Label" {
		panic("label panic")
	}
	return " Test "
}
func (p *configurableMetadataPlugin) Description() string {
	if p.panicMethod == "Description" {
		panic("description panic")
	}
	return "  line one\nline two  "
}
func (p *configurableMetadataPlugin) Version() string {
	if p.panicMethod == "Version" {
		panic("version panic")
	}
	return " v1.0.0 "
}

func TestPluginMetadataFallbacks(t *testing.T) {
	p := &minimalTestPlugin{name: "jsvm"}

	author, err := pluginAuthorName(p, "plugin")
	if err != nil {
		t.Fatal(err)
	}
	if author != "mjadobson" {
		t.Fatalf("unexpected author fallback: %q", author)
	}

	icon, err := pluginIconName(p, "plugin", p.Name())
	if err != nil {
		t.Fatal(err)
	}
	if icon != "ri-javascript-line" {
		t.Fatalf("unexpected icon fallback: %q", icon)
	}

	label, err := pluginLabelName(p, "plugin")
	if err != nil {
		t.Fatal(err)
	}
	if label != "" {
		t.Fatalf("unexpected label fallback: %q", label)
	}
}

func TestPluginInfoForRejectsInvalidNames(t *testing.T) {
	if info, err := pluginInfoFor(nil); err == nil || info != (pluginInfo{}) {
		t.Fatalf("expected nil plugin to fail with zero metadata, got %#v, %v", info, err)
	}

	if info, err := pluginInfoFor(&minimalTestPlugin{name: " \t"}); err == nil || info != (pluginInfo{}) {
		t.Fatalf("expected empty name to fail with zero metadata, got %#v, %v", info, err)
	}

	info, err := pluginInfoFor(&configurableMetadataPlugin{name: "test", panicMethod: "Name"})
	if err == nil || info != (pluginInfo{}) {
		t.Fatalf("expected Name panic to fail with zero metadata, got %#v, %v", info, err)
	}
	if !strings.Contains(err.Error(), "Name") {
		t.Fatalf("Name panic error does not identify the accessor: %v", err)
	}
}

func TestPluginInfoForIsolatesOptionalMetadataPanics(t *testing.T) {
	base := pluginInfo{
		Name:        "test",
		Author:      "author",
		Icon:        "ri-test-line",
		Label:       "Test",
		Description: "line one\nline two",
		Version:     "v1.0.0",
	}

	for _, method := range []string{"Author", "Icon", "Label", "Description", "Version"} {
		t.Run(method, func(t *testing.T) {
			info, err := pluginInfoFor(&configurableMetadataPlugin{
				name:        "test",
				panicMethod: method,
			})
			if err == nil {
				t.Fatalf("expected %s panic to return an error", method)
			}
			if !strings.Contains(err.Error(), method) || !strings.Contains(err.Error(), `"test"`) {
				t.Fatalf("metadata error does not identify plugin/accessor: %v", err)
			}

			want := base
			switch method {
			case "Author":
				want.Author = "mjadobson"
			case "Icon":
				want.Icon = "ri-puzzle-2-line"
			case "Label":
				want.Label = ""
			case "Description":
				want.Description = ""
			case "Version":
				want.Version = ""
			}
			if info != want {
				t.Fatalf("unexpected metadata after %s panic:\n got %#v\nwant %#v", method, info, want)
			}
		})
	}
}

func TestPluginInfoForNormalizesMetadata(t *testing.T) {
	info, err := pluginInfoFor(&configurableMetadataPlugin{name: " test "})
	if err != nil {
		t.Fatal(err)
	}

	want := pluginInfo{
		Name:        "test",
		Author:      "author",
		Icon:        "ri-test-line",
		Label:       "Test",
		Description: "line one\nline two",
		Version:     "v1.0.0",
	}
	if info != want {
		t.Fatalf("unexpected normalized metadata:\n got %#v\nwant %#v", info, want)
	}
}

func newTestAppWithPlugin(t testing.TB) *tests.TestApp {
	t.Helper()

	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("failed to initialize test app: %v", err)
	}
	if err := (&plugin{}).Init(app); err != nil {
		app.Cleanup()
		t.Fatalf("failed to initialize plugin: %v", err)
	}

	return app
}

func assertUIExtensionRegistered(t testing.TB, _ *tests.TestApp, e *core.ServeEvent) {
	t.Helper()

	for _, extension := range e.UIExtensions {
		if extension.Name == extensionName {
			if extension.FS == nil {
				t.Fatal("registered UI extension has a nil filesystem")
			}
			return
		}
	}

	t.Fatalf("UI extension %q was not registered", extensionName)
}

func TestPluginAPI(t *testing.T) {
	unauthenticated := tests.ApiScenario{
		Name:            "requires superuser auth",
		Method:          http.MethodGet,
		URL:             pluginsAPIPath,
		ExpectedStatus:  http.StatusUnauthorized,
		ExpectedContent: []string{"requires valid record authorization token"},
		TestAppFactory:  newTestAppWithPlugin,
		BeforeTestFunc:  assertUIExtensionRegistered,
	}
	unauthenticated.Test(t)

	authenticated := tests.ApiScenario{
		Name:           "returns plugin metadata to a superuser",
		Method:         http.MethodGet,
		URL:            pluginsAPIPath,
		Headers:        map[string]string{},
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"name":"` + pluginName + `"`,
			`"label":"` + pluginLabel + `"`,
			`"author":"mjadobson"`,
			`"icon":"ri-puzzle-2-line"`,
		},
		TestAppFactory: newTestAppWithPlugin,
	}
	authenticated.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		assertUIExtensionRegistered(t, app, e)

		superusers, err := app.FindAllRecords(core.CollectionNameSuperusers)
		if err != nil {
			t.Fatalf("failed to list test superusers: %v", err)
		}
		if len(superusers) == 0 {
			t.Fatal("test app has no superuser records")
		}
		token, err := superusers[0].NewAuthToken()
		if err != nil {
			t.Fatalf("failed to create test superuser auth token: %v", err)
		}
		authenticated.Headers["Authorization"] = token
	}
	authenticated.Test(t)
}

func TestExtensionETagsChangeWithAssetContent(t *testing.T) {
	extensions := []core.UIExtension{
		{
			Name: "example",
			FS: fstest.MapFS{
				"main.js":   &fstest.MapFile{Data: []byte("console.log('one')")},
				"style.css": &fstest.MapFile{Data: []byte("body { color: red; }")},
			},
		},
	}

	first, err := extensionETags(extensions)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		extensionsPath,
		"/_/extensions/example/main.js",
		"/_/extensions/example/style.css",
	} {
		if !strings.HasPrefix(first[path], `W/"`) {
			t.Fatalf("missing weak ETag for %q: %q", path, first[path])
		}
	}

	extensions[0].FS = fstest.MapFS{
		"main.js":   &fstest.MapFile{Data: []byte("console.log('two')")},
		"style.css": &fstest.MapFile{Data: []byte("body { color: red; }")},
	}
	second, err := extensionETags(extensions)
	if err != nil {
		t.Fatal(err)
	}

	for path, etag := range first {
		if second[path] == etag {
			t.Fatalf("ETag for %q did not change after an extension asset changed", path)
		}
	}
}

func TestRequestETagMatches(t *testing.T) {
	etag := `W/"abc"`
	for _, header := range []string{`W/"abc"`, `"abc"`, `"other", W/"abc"`, "*"} {
		if !requestETagMatches(header, etag) {
			t.Fatalf("expected %q to match %q", header, etag)
		}
	}
	for _, header := range []string{"", `W/"other"`, `"ab"`} {
		if requestETagMatches(header, etag) {
			t.Fatalf("did not expect %q to match %q", header, etag)
		}
	}
}

func TestExtensionBundleCacheHeaders(t *testing.T) {
	uiFS, err := fs.Sub(embeddedUI, "ui")
	if err != nil {
		t.Fatal(err)
	}
	etags, err := extensionETags([]core.UIExtension{{Name: extensionName, FS: uiFS}})
	if err != nil {
		t.Fatal(err)
	}

	revalidation := tests.ApiScenario{
		Name:            "extension bundle is revalidated",
		Method:          http.MethodGet,
		URL:             extensionsPath,
		ExpectedStatus:  http.StatusOK,
		ExpectedContent: []string{"XPB_PLUGINS_API"},
		TestAppFactory:  newTestAppWithPlugin,
		AfterTestFunc: func(t testing.TB, _ *tests.TestApp, response *http.Response) {
			if got := response.Header.Get("Cache-Control"); got != "no-cache" {
				t.Fatalf("unexpected Cache-Control: %q", got)
			}
			if got := response.Header.Get("ETag"); got != etags[extensionsPath] {
				t.Fatalf("unexpected ETag: %q", got)
			}
		},
	}
	revalidation.Test(t)

	notModified := tests.ApiScenario{
		Name:           "matching extension bundle is not transferred",
		Method:         http.MethodGet,
		URL:            extensionsPath,
		Headers:        map[string]string{"If-None-Match": etags[extensionsPath]},
		ExpectedStatus: http.StatusNotModified,
		TestAppFactory: newTestAppWithPlugin,
	}
	notModified.Test(t)
}
