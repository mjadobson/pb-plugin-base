package pluginbase

import (
	"io/fs"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbuilds/xpb"
)

const testSuperuserToken = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY"

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
	if icon := pluginIconName(p, p.Name()); icon != "ri-puzzle-2-line" {
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

type panickingMetadataPlugin struct{}

func (p *panickingMetadataPlugin) Init(core.App) error { return nil }
func (p *panickingMetadataPlugin) Name() string        { return "broken" }
func (p *panickingMetadataPlugin) Version() string     { return "v1.0.0" }
func (p *panickingMetadataPlugin) Description() string { panic("boom") }

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
	return "description"
}
func (p *configurableMetadataPlugin) Version() string {
	if p.panicMethod == "Version" {
		panic("version panic")
	}
	return "v1.0.0"
}

func TestPluginMetadataFallbacks(t *testing.T) {
	p := &minimalTestPlugin{name: "jsvm"}

	if got := pluginAuthorName(p); got != "mjadobson" {
		t.Fatalf("unexpected author fallback: %q", got)
	}
	if got := pluginIconName(p, p.Name()); got != "ri-javascript-line" {
		t.Fatalf("unexpected icon fallback: %q", got)
	}
	if got := pluginLabelName(p); got != "" {
		t.Fatalf("unexpected label fallback: %q", got)
	}
}

func TestPluginInfoForRecoversMetadataPanic(t *testing.T) {
	info, err := pluginInfoFor(&panickingMetadataPlugin{})
	if err == nil {
		t.Fatal("expected metadata panic to be converted to an error")
	}
	if info != (pluginInfo{}) {
		t.Fatalf("expected zero metadata after panic, got %#v", info)
	}
}

func TestPluginInfoForRejectsNilAndEmptyNames(t *testing.T) {
	if _, err := pluginInfoFor(nil); err == nil {
		t.Fatal("expected nil plugin to return an error")
	}

	if _, err := pluginInfoFor(&minimalTestPlugin{name: " \t"}); err == nil {
		t.Fatal("expected empty plugin name to return an error")
	}
}

func TestPluginInfoForIsolatesAllMetadataPanics(t *testing.T) {
	for _, method := range []string{"Name", "Author", "Icon", "Label", "Description", "Version"} {
		t.Run(method, func(t *testing.T) {
			info, err := pluginInfoFor(&configurableMetadataPlugin{
				name:        "test",
				panicMethod: method,
			})
			if err == nil {
				t.Fatalf("expected %s panic to return an error", method)
			}
			if info != (pluginInfo{}) {
				t.Fatalf("expected zero metadata after %s panic, got %#v", method, info)
			}
		})
	}
}

func TestPluginInfoForOptionalMetadata(t *testing.T) {
	info, err := pluginInfoFor(&configurableMetadataPlugin{name: " test "})
	if err != nil {
		t.Fatal(err)
	}

	if info.Name != "test" || info.Author != "author" || info.Icon != "ri-test-line" || info.Label != "Test" {
		t.Fatalf("unexpected normalized metadata: %#v", info)
	}
	if info.Description != "description" || info.Version != "v1.0.0" {
		t.Fatalf("unexpected metadata: %#v", info)
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
	scenarios := []tests.ApiScenario{
		{
			Name:            "requires superuser auth",
			Method:          http.MethodGet,
			URL:             pluginsAPIPath,
			ExpectedStatus:  http.StatusUnauthorized,
			ExpectedContent: []string{"requires valid record authorization token"},
			TestAppFactory:  newTestAppWithPlugin,
			BeforeTestFunc:  assertUIExtensionRegistered,
		},
		{
			Name:   "returns plugin metadata to a superuser",
			Method: http.MethodGet,
			URL:    pluginsAPIPath,
			Headers: map[string]string{
				"Authorization": testSuperuserToken,
			},
			ExpectedStatus: http.StatusOK,
			ExpectedContent: []string{
				`"name":"` + pluginName + `"`,
				`"label":"` + pluginLabel + `"`,
				`"author":"mjadobson"`,
				`"icon":"ri-puzzle-2-line"`,
			},
			TestAppFactory: newTestAppWithPlugin,
			BeforeTestFunc: assertUIExtensionRegistered,
		},
	}

	for i := range scenarios {
		scenarios[i].Test(t)
	}
}
