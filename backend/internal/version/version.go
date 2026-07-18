// Package version 应用版本号；发布构建时由 -ldflags 从 manifest 注入。
package version

// Version 默认与 manifest 同步；打包脚本通过 -X fancontrolserver/internal/version.Version=… 覆盖。
var Version = "1.3.6"
