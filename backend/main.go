package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/api"
	"fancontrolserver/internal/logging"
	"fancontrolserver/internal/service"
)

//go:embed web
var staticFS embed.FS

func resolveConfigPath() string {
	if cfgDir := os.Getenv("TRIM_PKGETC"); cfgDir != "" {
		return filepath.Join(cfgDir, "config.json")
	}
	return "config.json"
}

func resolveTokenPath() string {
	if tokenDir := os.Getenv("TRIM_PKGVAR"); tokenDir != "" {
		return filepath.Join(tokenDir, "run", "api_token")
	}
	return "run/api_token"
}

func listenAddr() string {
	bind := "127.0.0.1"
	if os.Getenv("external_access") == "true" {
		bind = "0.0.0.0"
	}
	port := os.Getenv("service_port")
	if port == "" {
		port = "19527"
	}
	return bind + ":" + port
}

func requireAuthFromEnv() bool {
	v := os.Getenv("require_auth")
	if v == "false" {
		return false
	}
	return true
}

func main() {
	logging.Init()
	gin.SetMode(gin.ReleaseMode)

	webFS, err := fs.Sub(staticFS, "web")
	if err != nil {
		logrus.Fatalf("获取嵌入的 web 子目录失败: %v", err)
	}

	cfgPath := resolveConfigPath()
	store, err := service.NewStore(cfgPath)
	if err != nil {
		logrus.Fatalf("[主程序] 加载配置失败：%v", err)
	}
	if logLevel := store.Get().Global.LogLevel; logLevel != "" {
		logging.SetLevel(logLevel)
	}

	tokenPath := resolveTokenPath()
	requireAuth := requireAuthFromEnv()
	auth, err := api.NewAuthManager(tokenPath, requireAuth)
	if err != nil {
		logrus.Fatalf("[主程序] 初始化鉴权失败：%v", err)
	}
	if requireAuth {
		logrus.Info("[主程序] API 鉴权：已启用（Bearer + 首次确认）")
	} else {
		logrus.Warn("[主程序] API 鉴权：已关闭（require_auth=false）；任何能访问 HTTP 端口的客户端均可操作风扇配置")
	}

	controller := service.NewController(store)
	if err = controller.Start(); err != nil {
		logrus.Fatalf("[主程序] 启动控制器失败：%v", err)
	}

	router := api.NewRouter(webFS, controller, store, auth)
	addr := listenAddr()
	server := &http.Server{
		Addr:    addr,
		Handler: router,
	}

	go func() {
		logrus.Infof("[主程序] HTTP 服务已监听，地址：%s，配置文件：%q", addr, cfgPath)
		if requireAuth && !auth.IsConfirmed() {
			logrus.Warn("[主程序] API Key 尚未确认，请打开浏览器完成初始设置")
		}
		if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logrus.Fatalf("[主程序] HTTP 服务异常退出：%v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	logrus.Infof("[主程序] 收到信号 %s，开始优雅关机…", sig)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	controller.Stop()
	if err = server.Shutdown(ctx); err != nil {
		logrus.Warnf("[主程序] 关闭 HTTP 服务时出错：%v", err)
	}
	logrus.Info("[主程序] 已退出")
}
