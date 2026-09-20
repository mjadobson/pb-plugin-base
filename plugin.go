// Package pluginbase registers the pb-plugin-base xpb plugin when imported.
package pluginbase

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"reflect"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbuilds/xpb"
)

var version = "v0.2.0"

const (
	pluginName     = "mjadobson_pb_plugin_base"
	pluginLabel    = "base"
	extensionName  = "pb-plugin-base"
	pluginsAPIPath = "/api/xpb/plugin-base"
	extensionsPath = "/_/extensions.js"
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

	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Priority: 9998,
		Func: func(e *core.ServeEvent) error {
			e.UIExtensions = append(e.UIExtensions, core.UIExtension{
				Name: extensionName,
				FS:   uiFS,
			})

			if e.App.IsDev() {
				e.Router.BindFunc(extensionDevelopmentCacheMiddleware)
			} else {
				etags, err := extensionETags(e.UIExtensions)
				if err != nil {
					return fmt.Errorf("generate UI extension cache fingerprints: %w", err)
				}
				e.Router.BindFunc(extensionCacheMiddleware(etags))
			}

			e.Router.GET(pluginsAPIPath, func(re *core.RequestEvent) error {
				info, metadataErrors := registeredPluginInfo()
				for _, err := range metadataErrors {
					re.App.Logger().Warn("Using fallback xpb plugin metadata", "error", err)
				}

				return re.JSON(http.StatusOK, info)
			}).Bind(apis.RequireSuperuserAuth())

			return e.Next()
		},
	})

	return nil
}

func extensionDevelopmentCacheMiddleware(e *core.RequestEvent) error {
	if isExtensionAssetPath(e.Request.URL.Path) {
		e.Response.Header().Set("Cache-Control", "no-store")
	}
	return e.Next()
}

func extensionCacheMiddleware(etags map[string]string) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Request.Method != http.MethodGet && e.Request.Method != http.MethodHead {
			return e.Next()
		}

		etag, ok := etags[e.Request.URL.Path]
		if !ok {
			return e.Next()
		}

		e.Response.Header().Set("Cache-Control", "no-cache")
		e.Response.Header().Set("ETag", etag)
		if requestETagMatches(e.Request.Header.Get("If-None-Match"), etag) {
			e.Response.WriteHeader(http.StatusNotModified)
			return nil
		}

		return e.Next()
	}
}

func isExtensionAssetPath(path string) bool {
	return path == extensionsPath || strings.HasPrefix(path, "/_/extensions/")
}

func requestETagMatches(header, etag string) bool {
	etag = strings.TrimPrefix(etag, "W/")
	for value := range strings.SplitSeq(header, ",") {
		value = strings.TrimSpace(value)
		if value == "*" || strings.TrimPrefix(value, "W/") == etag {
			return true
		}
	}
	return false
}

func extensionETags(extensions []core.UIExtension) (map[string]string, error) {
	type asset struct {
		path    string
		content []byte
	}

	var assets []asset
	var bundle bytes.Buffer
	global := sha256.New()
	writeFingerprintField(global, "pocketbase", pocketBaseBuildVersion())

	pluginInfo, _ := registeredPluginInfo()
	for _, info := range pluginInfo {
		writeFingerprintField(global, "plugin", info.Name, info.Version)
	}

	for _, extension := range extensions {
		if extension.Name == "" || extension.FS == nil {
			continue
		}

		err := fs.WalkDir(extension.FS, ".", func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}

			content, err := fs.ReadFile(extension.FS, path)
			if err != nil {
				return err
			}

			assetPath := "/_/extensions/" + extension.Name + "/" + path
			assets = append(assets, asset{path: assetPath, content: content})
			writeFingerprintField(global, "asset", extension.Name, path, string(content))

			if path == "main.js" {
				bundle.WriteString("await (async function(){")
				bundle.Write(content)
				bundle.WriteString("})();")
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("read UI extension %q: %w", extension.Name, err)
		}
	}

	globalFingerprint := global.Sum(nil)
	etags := make(map[string]string, len(assets)+1)
	etags[extensionsPath] = extensionETag(globalFingerprint, bundle.Bytes())
	for _, asset := range assets {
		etags[asset.path] = extensionETag(globalFingerprint, asset.content)
	}

	return etags, nil
}

func writeFingerprintField(target interface{ Write([]byte) (int, error) }, values ...string) {
	for _, value := range values {
		_, _ = fmt.Fprintf(target, "%d:%s", len(value), value)
	}
}

func extensionETag(globalFingerprint, content []byte) string {
	hash := sha256.New()
	hash.Write(globalFingerprint)
	hash.Write(content)
	return `W/"` + hex.EncodeToString(hash.Sum(nil)) + `"`
}

func pocketBaseBuildVersion() string {
	buildInfo, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}

	for _, dependency := range buildInfo.Deps {
		if dependency.Path != "github.com/pocketbase/pocketbase" {
			continue
		}
		if dependency.Replace != nil {
			return dependency.Version + "=>" + dependency.Replace.Path + "@" + dependency.Replace.Version
		}
		return dependency.Version
	}

	return "unknown"
}

func registeredPluginInfo() ([]pluginInfo, []error) {
	registered := xpb.GetPlugins()
	result := make([]pluginInfo, 0, len(registered))
	var metadataErrors []error

	for _, registeredPlugin := range registered {
		info, err := pluginInfoFor(registeredPlugin)
		if err != nil {
			metadataErrors = append(metadataErrors, err)
		}
		if info.Name == "" {
			continue
		}

		result = append(result, info)
	}

	sort.SliceStable(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})

	return result, metadataErrors
}

func pluginInfoFor(registeredPlugin xpb.Plugin) (pluginInfo, error) {
	pluginType := fmt.Sprintf("%T", registeredPlugin)
	if registeredPlugin == nil {
		return pluginInfo{}, fmt.Errorf("plugin %s is nil", pluginType)
	}

	name, err := pluginNameValue(registeredPlugin, pluginType)
	if err != nil {
		return pluginInfo{}, err
	}

	metadataSource := fmt.Sprintf("%s %q", pluginType, name)
	var metadataErrors []error
	author, err := pluginAuthorName(registeredPlugin, metadataSource)
	if err != nil {
		metadataErrors = append(metadataErrors, err)
	}
	icon, err := pluginIconName(registeredPlugin, metadataSource, name)
	if err != nil {
		metadataErrors = append(metadataErrors, err)
	}
	label, err := pluginLabelName(registeredPlugin, metadataSource)
	if err != nil {
		metadataErrors = append(metadataErrors, err)
	}
	description, err := metadataString(metadataSource, "Description", "", registeredPlugin.Description)
	if err != nil {
		metadataErrors = append(metadataErrors, err)
	}
	pluginVersion, err := metadataString(metadataSource, "Version", "", registeredPlugin.Version)
	if err != nil {
		metadataErrors = append(metadataErrors, err)
	}

	return pluginInfo{
		Name:        name,
		Author:      author,
		Icon:        icon,
		Label:       label,
		Description: description,
		Version:     pluginVersion,
	}, errors.Join(metadataErrors...)
}

func pluginNameValue(registeredPlugin xpb.Plugin, pluginType string) (name string, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			name = ""
			err = fmt.Errorf("plugin %s Name metadata panicked: %v", pluginType, recovered)
		}
	}()

	name = strings.TrimSpace(registeredPlugin.Name())
	if name == "" {
		return "", fmt.Errorf("plugin %s returned an empty name", pluginType)
	}

	return name, nil
}

func metadataString(pluginType, accessor, fallback string, read func() string) (value string, err error) {
	value = fallback
	defer func() {
		if recovered := recover(); recovered != nil {
			value = fallback
			err = fmt.Errorf("plugin %s %s metadata panicked: %v", pluginType, accessor, recovered)
		}
	}()

	if result := strings.TrimSpace(read()); result != "" {
		value = result
	}
	return value, nil
}

func pluginLabelName(registeredPlugin xpb.Plugin, pluginType string) (string, error) {
	labeled, ok := registeredPlugin.(pluginLabeler)
	if !ok {
		return "", nil
	}

	return metadataString(pluginType, "Label", "", labeled.Label)
}

func pluginIconName(registeredPlugin xpb.Plugin, pluginType, name string) (string, error) {
	fallback := pluginIconDefaults[name]
	if fallback == "" {
		fallback = "ri-puzzle-2-line"
	}

	iconPlugin, ok := registeredPlugin.(pluginIcon)
	if !ok {
		return fallback, nil
	}

	return metadataString(pluginType, "Icon", fallback, iconPlugin.Icon)
}

func pluginAuthorName(registeredPlugin xpb.Plugin, pluginType string) (string, error) {
	fallback := pluginAuthorFallback(registeredPlugin)
	authored, ok := registeredPlugin.(pluginAuthor)
	if !ok {
		return fallback, nil
	}

	return metadataString(pluginType, "Author", fallback, authored.Author)
}

func pluginAuthorFallback(registeredPlugin xpb.Plugin) string {
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
