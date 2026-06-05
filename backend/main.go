package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
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

func listenAddr() string {
	bind := "127.0.0.1"
	if os.Getenv("external_access") == "true" {
		bind = "0.0.0.0"
	}
	port := os.Getenv("service_port")
	if port == "" {
		port = "19527"
	} else {
		// 验证端口合法性：必须是 1-65535 之间的整数
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			logrus.Warnf("[主程序] 环境变量 service_port=%s 无效，使用默认端口 19527", port)
			port = "19527"
		}
	}
	return bind + ":" + port
}

// isGatewayMode 是否在飞牛应用环境中运行（由统一网关转发）。
func isGatewayMode() bool {
	return os.Getenv("TRIM_APPDEST") != ""
}

func resolveSocketPath() string {
	appDest := os.Getenv("TRIM_APPDEST")
	if appDest == "" {
		return ""
	}
	return filepath.Join(appDest, "target", "app.sock")
}

func prepareUnixSocket(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	// 设置 Socket 文件权限为 0660 确保网关可以访问
	if err = os.Chmod(path, 0o660); err != nil {
		logrus.Warnf("[主程序] 设置 Socket 权限失败：%v", err)
	}
	return ln, nil
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

	// 根据运行模式选择鉴权方式
	gatewayMode := isGatewayMode()
	var auth *api.AuthManager
	if gatewayMode {
		auth = api.NewGatewayAuthManager()
		logrus.Info("[主程序] 鉴权：统一网关模式（X-Trim-* Header）")
	} else {
		auth = api.NewStandaloneAuthManager()
		logrus.Warn("[主程序] 鉴权：独立模式，未启用鉴权，请仅在受信任网络中使用")
	}

	controller := service.NewController(store)
	if err = controller.Start(); err != nil {
		logrus.Fatalf("[主程序] 启动控制器失败：%v", err)
	}

	router := api.NewRouter(webFS, controller, store, auth)
	server := &http.Server{Handler: router}

	go func() {
		var listenErr error
		if gatewayMode {
			sock := resolveSocketPath()
			ln, err := prepareUnixSocket(sock)
			if err != nil {
				logrus.Fatalf("[主程序] 创建 Unix Socket 失败：%v", err)
			}
			logrus.Infof("[主程序] 统一网关模式，监听 Unix Socket：%s，配置：%q", sock, cfgPath)
			listenErr = server.Serve(ln)
		} else {
			// 非网关模式下才监听 TCP 端口
			addr := listenAddr()
			server.Addr = addr
			logrus.Infof("[主程序] 独立模式，HTTP 监听：%s，配置：%q", addr, cfgPath)
			listenErr = server.ListenAndServe()
		}
		if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
			logrus.Fatalf("[主程序] HTTP 服务异常退出：%v", listenErr)
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
