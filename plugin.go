// Package pluginbase registers the pb-plugin-base xpb plugin when imported.
package pluginbase

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"reflect"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbuilds/xpb"
)

var version = "dev"

const (
	pluginName     = "mjadobson_pb_plugin_base"
	pluginLabel    = "base"
	extensionName  = "pb-plugin-base"
	pluginsAPIPath = "/api/xpb/plugin-base"
)

//go:embed all:ui
var embeddedUI embed.FS

type plugin struct{}

var _ xpb.Plugin = (*plugin)(nil)

type pluginInfo struct {
	Name        string `json:"name"`
	Author      string `json:"author"`
	Icon        string `json:"icon"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

type pluginAuthor interface {
	Author() string
}

type pluginIcon interface {
	Icon() string
}

type pluginLabeler interface {
	Label() string
}

var pluginIconDefaults = map[string]string{
	"jsvm":       "ri-javascript-line",
	"cmd":        "ri-terminal-box-line",
	"migratecmd": "ri-terminal-box-line",
	"public_dir": "ri-folder-line",
}

func init() {
	xpb.Register(&plugin{})
}

func (p *plugin) Name() string {
	return pluginName
}

func (p *plugin) Label() string {
	return pluginLabel
}

func (p *plugin) Version() string {
	return version
}

func (p *plugin) Author() string {
	return "mjadobson"
}

func (p *plugin) Icon() string {
	return "ri-puzzle-2-line"
}

func (p *plugin) Description() string {
	return "Adds a Plugins page to the PocketBase Superuser UI and provides mount hooks for xpb plugin settings and information."
}

func (p *plugin) Init(app core.App) error {
	uiFS, err := fs.Sub(embeddedUI, "ui")
	if err != nil {
		return err
	}

	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.UIExtensions = append(e.UIExtensions, core.UIExtension{
			Name: extensionName,
			FS:   uiFS,
		})

		e.Router.GET(pluginsAPIPath, func(re *core.RequestEvent) error {
			info, metadataErrors := registeredPluginInfo()
			for _, err := range metadataErrors {
				re.App.Logger().Warn("Skipping invalid xpb plugin metadata", "error", err)
			}

			return re.JSON(http.StatusOK, info)
		}).Bind(apis.RequireSuperuserAuth())

		return e.Next()
	})

	return nil
}

func registeredPluginInfo() ([]pluginInfo, []error) {
	registered := xpb.GetPlugins()
	result := make([]pluginInfo, 0, len(registered))
	var metadataErrors []error

	for _, registeredPlugin := range registered {
		info, err := pluginInfoFor(registeredPlugin)
		if err != nil {
			metadataErrors = append(metadataErrors, err)
			continue
		}

		result = append(result, info)
	}

	sort.SliceStable(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})

	return result, metadataErrors
}

func pluginInfoFor(registeredPlugin xpb.Plugin) (info pluginInfo, err error) {
	pluginType := fmt.Sprintf("%T", registeredPlugin)

	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("plugin %s metadata panicked: %v", pluginType, recovered)
			info = pluginInfo{}
		}
	}()

	if registeredPlugin == nil {
		return pluginInfo{}, fmt.Errorf("plugin %s is nil", pluginType)
	}

	name := strings.TrimSpace(registeredPlugin.Name())
	if name == "" {
		return pluginInfo{}, fmt.Errorf("plugin %s returned an empty name", pluginType)
	}

	return pluginInfo{
		Name:        name,
		Author:      pluginAuthorName(registeredPlugin),
		Icon:        pluginIconName(registeredPlugin, name),
		Label:       pluginLabelName(registeredPlugin),
		Description: registeredPlugin.Description(),
		Version:     registeredPlugin.Version(),
	}, nil
}

func pluginLabelName(registeredPlugin xpb.Plugin) string {
	if labeled, ok := registeredPlugin.(pluginLabeler); ok {
		return strings.TrimSpace(labeled.Label())
	}

	return ""
}

func pluginIconName(registeredPlugin xpb.Plugin, name string) string {
	if iconPlugin, ok := registeredPlugin.(pluginIcon); ok {
		if icon := strings.TrimSpace(iconPlugin.Icon()); icon != "" {
			return icon
		}
	}

	if icon := pluginIconDefaults[name]; icon != "" {
		return icon
	}

	return "ri-puzzle-2-line"
}

func pluginAuthorName(registeredPlugin xpb.Plugin) string {
	if authored, ok := registeredPlugin.(pluginAuthor); ok {
		if author := strings.TrimSpace(authored.Author()); author != "" {
			return author
		}
	}

	typ := reflect.TypeOf(registeredPlugin)
	if typ == nil {
		return "other"
	}

	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}

	return authorFromPackagePath(typ.PkgPath())
}

func authorFromPackagePath(packagePath string) string {
	const xpbPackagePath = "github.com/pocketbuilds/xpb"

	if packagePath == xpbPackagePath || strings.HasPrefix(packagePath, xpbPackagePath+"/") {
		return "xpb"
	}

	parts := strings.Split(packagePath, "/")
	if len(parts) >= 3 && parts[0] == "github.com" && parts[1] != "" {
		return parts[1]
	}

	return "other"
}
