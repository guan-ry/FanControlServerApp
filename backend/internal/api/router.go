package api

import (
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"fancontrolserver/internal/model"
	"fancontrolserver/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

type handler struct {
	controller *service.Controller
	store      *service.Store
	auth       *AuthManager
	upgrader   websocket.Upgrader
}

func NewRouter(staticFS fs.FS, controller *service.Controller, store *service.Store, auth *AuthManager) *gin.Engine {
	logrus.Info("[路由] 开始初始化路由器")

	if staticFS == nil {
		logrus.Warn("[路由] 静态文件系统为空，将不提供前端页面")
	}

	h := &handler{
		controller: controller,
		store:      store,
		auth:       auth,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}

	router := gin.Default()

	var indexData []byte

	if staticFS != nil {
		if sub, err := fs.Sub(staticFS, "assets"); err == nil {
			router.StaticFS("/app/FanControlServer/assets", http.FS(sub))
		} else {
			logrus.Warn("assets directory not found in embedded filesystem, static assets will not be served")
		}

		var err error
		indexData, err = fs.ReadFile(staticFS, "index.html")
		if err != nil {
			panic("无法读取 index.html: " + err.Error())
		}

		router.GET("/app/FanControlServer/", func(c *gin.Context) {
			c.Data(http.StatusOK, "text/html; charset=utf-8", indexData)
		})
	}

	router.GET("/app/FanControlServer/api/auth/status", h.authStatus)

	// 读接口：网关模式下所有登录用户都可访问（网关已鉴权）
	apiRead := router.Group("/app/FanControlServer/api")
	{
		apiRead.GET("/device/info", h.deviceInfo)
		apiRead.GET("/device/scan", h.deviceScan)
		apiRead.GET("/fan/config", h.fanConfig)
		apiRead.GET("/ws", h.ws)
	}

	// 写接口：网关模式下仅管理员可访问
	apiWrite := router.Group("/app/FanControlServer/api", auth.Middleware())
	if h.auth.GatewayMode() {
		apiWrite.Use(RequireAdminMiddleware())
	}
	{
		apiWrite.POST("/fan/config", h.saveFanConfig)
		apiWrite.POST("/fan/set", h.setFanPWM)
		apiWrite.POST("/fan/mode", h.setFanMode)
		apiWrite.POST("/fan/curve", h.setFanCurve)
		apiWrite.POST("/fan/remove", h.removeFan)
		apiWrite.POST("/global/config", h.setGlobalConfig)
	}

	if staticFS != nil {
		router.NoRoute(func(c *gin.Context) {
			path := c.Request.URL.Path
			// 防目录穿越
			clean := filepath.Clean(path)
			if strings.Contains(clean, "..") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "非法路径"})
				return
			}
			if strings.HasPrefix(path, "/app/FanControlServer/api") {
				c.JSON(http.StatusNotFound, gin.H{"error": "未找到接口"})
				return
			}
			f, err := staticFS.Open(strings.TrimPrefix(path, "/app/FanControlServer/"))
			if err == nil {
				defer func(f fs.File) {
					_ = f.Close()
				}(f)
				if seeker, ok := f.(io.ReadSeeker); ok {
					http.ServeContent(c.Writer, c.Request, path, time.Time{}, seeker)
				} else {
					data, _ := io.ReadAll(f)
					c.Data(http.StatusOK, http.DetectContentType(data), data)
				}
				return
			}
			c.Data(http.StatusOK, "text/html; charset=utf-8", indexData)
		})
	}

	return router
}

func bindJSON(c *gin.Context, obj any) bool {
	if err := c.ShouldBindJSON(obj); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("请求参数无效：%v", err)})
		return false
	}
	return true
}

func abortWithError(c *gin.Context, status int, err error) bool {
	if err == nil {
		return false
	}
	if status == http.StatusInternalServerError {
		logrus.Errorf("[API] 内部错误：%v", err)
		c.JSON(status, gin.H{"error": "服务器内部错误"})
	} else {
		c.JSON(status, gin.H{"error": err.Error()})
	}
	return true
}

func (h *handler) deviceInfo(c *gin.Context) {
	c.JSON(http.StatusOK, h.controller.Telemetry())
}

func (h *handler) deviceScan(c *gin.Context) {
	fans, err := h.controller.ScanFans()
	if abortWithError(c, http.StatusInternalServerError, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"fans": fans})
}

func (h *handler) fanConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.Get())
}

func (h *handler) saveFanConfig(c *gin.Context) {
	var cfg model.Config
	if !bindJSON(c, &cfg) {
		return
	}
	if abortWithError(c, http.StatusInternalServerError, h.controller.SaveConfig(cfg)) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) setFanPWM(c *gin.Context) {
	var req struct {
		ID  string `json:"id" binding:"required"`
		PWM int    `json:"pwm" binding:"gte=0,lte=255"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if abortWithError(c, http.StatusBadRequest, h.controller.SetFanManualPWM(req.ID, req.PWM)) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) setFanMode(c *gin.Context) {
	var req struct {
		ID   string        `json:"id" binding:"required"`
		Mode model.FanMode `json:"mode" binding:"required"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if abortWithError(c, http.StatusBadRequest, h.controller.SetFanMode(req.ID, req.Mode)) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) setFanCurve(c *gin.Context) {
	var req struct {
		ID    string             `json:"id" binding:"required"`
		Curve []model.CurvePoint `json:"curve" binding:"required"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if abortWithError(c, http.StatusBadRequest, h.controller.SetFanCurve(req.ID, req.Curve)) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) removeFan(c *gin.Context) {
	var req struct {
		ID string `json:"id" binding:"required"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if abortWithError(c, http.StatusBadRequest, h.controller.RemoveFan(req.ID)) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) setGlobalConfig(c *gin.Context) {
	var req model.GlobalConfig
	if !bindJSON(c, &req) {
		return
	}
	cfg := h.store.Get()
	cfg.Global = req
	if abortWithError(c, http.StatusInternalServerError, h.controller.SaveConfig(cfg)) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) ws(c *gin.Context) {
	clientIP := c.ClientIP()
	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		logrus.Warnf("[WebSocket] 升级失败 (来自 %s)：%v", clientIP, err)
		return
	}
	// 网关模式下记录用户信息
	if h.auth.GatewayMode() {
		if user := GetGatewayUser(c); user != nil {
			logrus.Infof("[WebSocket] 用户 UID=%s 已连接：%s", user.UID, clientIP)
		}
	} else {
		logrus.Infof("[WebSocket] 客户端已连接：%s", clientIP)
	}
	sub := h.controller.Subscribe()
	defer h.controller.Unsubscribe(sub)
	defer func() {
		_ = conn.Close()
		logrus.Infof("[WebSocket] 客户端已断开：%s", clientIP)
	}()

	if err = conn.WriteJSON(h.controller.Telemetry()); err != nil {
		return
	}
	for msg := range sub {
		if err = conn.WriteJSON(msg); err != nil {
			return
		}
	}
}
