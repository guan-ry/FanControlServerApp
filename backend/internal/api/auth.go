package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// AuthManager 管理 API Key 的生成、持久化、校验与确认状态。
type AuthManager struct {
	mu            sync.RWMutex
	requireAuth   bool
	token         string
	confirmed     bool
	tokenPath     string
	confirmedPath string
	gatewayMode   bool
}

func NewAuthManager(tokenPath string, requireAuth bool) (*AuthManager, error) {
	am := &AuthManager{
		requireAuth:   requireAuth,
		tokenPath:     tokenPath,
		confirmedPath: tokenPath + ".confirmed",
	}
	if err := am.load(); err != nil {
		return nil, err
	}
	return am, nil
}

// NewGatewayAuthManager 创建网关模式鉴权管理器（不使用 API Key）。
func NewGatewayAuthManager() *AuthManager {
	return &AuthManager{
		requireAuth: true,
		confirmed:   true,
		gatewayMode: true,
	}
}

// GatewayMode 返回是否为网关模式。
func (am *AuthManager) GatewayMode() bool {
	return am.gatewayMode
}

func (am *AuthManager) RequireAuth() bool {
	return am.requireAuth
}

func (am *AuthManager) load() error {
	if !am.requireAuth {
		am.token = ""
		am.confirmed = true
		logrus.Infof("[鉴权] 已关闭 API Key 要求,不创建 api_token 文件")
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(am.tokenPath), 0o755); err != nil {
		return err
	}

	raw, err := os.ReadFile(am.tokenPath)
	if errors.Is(err, os.ErrNotExist) {
		token, genErr := generateToken()
		if genErr != nil {
			return fmt.Errorf("生成 API Key 失败：%w", genErr)
		}
		am.token = token
		am.confirmed = false
		if writeErr := os.WriteFile(am.tokenPath, []byte(token), 0o600); writeErr != nil {
			return writeErr
		}
		logrus.Infof("[鉴权] 已生成新的 API Key，文件：%s", am.tokenPath)
		return nil
	}
	if err != nil {
		return err
	}

	am.token = strings.TrimSpace(string(raw))
	_, statErr := os.Stat(am.confirmedPath)
	am.confirmed = statErr == nil

	status := "待确认"
	if am.confirmed {
		status = "已确认"
	}
	logrus.Infof("[鉴权] 已加载 API Key（%s），文件：%s", status, am.tokenPath)
	return nil
}

func (am *AuthManager) IsConfirmed() bool {
	am.mu.RLock()
	defer am.mu.RUnlock()
	return am.confirmed
}

func (am *AuthManager) confirm(newToken string) error {
	am.mu.Lock()
	defer am.mu.Unlock()
	if newToken != "" && newToken != am.token {
		am.token = newToken
		if err := os.WriteFile(am.tokenPath, []byte(newToken), 0o600); err != nil {
			return err
		}
	}
	am.confirmed = true
	if err := os.WriteFile(am.confirmedPath, []byte{}, 0o600); err != nil {
		return err
	}
	logrus.Info("[鉴权] API Key 已确认")
	return nil
}

func (am *AuthManager) resetToken(newToken string) error {
	am.mu.Lock()
	defer am.mu.Unlock()
	am.token = newToken
	if err := os.WriteFile(am.tokenPath, []byte(newToken), 0o600); err != nil {
		return err
	}
	logrus.Info("[鉴权] API Key 已重置")
	return nil
}

func (am *AuthManager) getToken() string {
	am.mu.RLock()
	defer am.mu.RUnlock()
	return am.token
}

func (am *AuthManager) validateToken(provided string) bool {
	am.mu.RLock()
	defer am.mu.RUnlock()
	if provided == "" || am.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(am.token), []byte(provided)) == 1
}

// Middleware 返回 Gin 鉴权中间件，所有受保护的 /api 路由必须通过此中间件。
func (am *AuthManager) Middleware() gin.HandlerFunc {
	if am.gatewayMode {
		return GatewayMiddleware()
	}
	return func(c *gin.Context) {
		if !am.requireAuth {
			c.Next()
			return
		}
		clientIP := c.ClientIP()
		if !am.IsConfirmed() {
			logrus.Debugf("[鉴权] 拒绝请求 %s %s (来自 %s)：API Key 尚未确认", c.Request.Method, c.Request.URL.Path, clientIP)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "API Key 尚未确认，请先完成初始设置",
			})
			return
		}
		token := extractToken(c)
		if token == "" {
			logrus.Warnf("[鉴权] 拒绝请求 %s %s (来自 %s)：未提供 API Key", c.Request.Method, c.Request.URL.Path, clientIP)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未提供 API Key"})
			return
		}
		if !am.validateToken(token) {
			logrus.Warnf("[鉴权] 拒绝请求 %s %s (来自 %s)：API Key 无效", c.Request.Method, c.Request.URL.Path, clientIP)
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "API Key 无效"})
			return
		}
		c.Next()
	}
}

func extractToken(c *gin.Context) string {
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return c.Query("token")
}

// ---------- Setup / Reset 接口 ----------
func (h *handler) authStatus(c *gin.Context) {
	if h.auth.gatewayMode {
		// 调试：打印所有请求头
		//logrus.Infof("[调试] authStatus - 所有 Headers: %v", c.Request.Header)

		user, ok := GatewayUserFromRequest(c)
		if !ok {
			c.JSON(http.StatusOK, gin.H{
				"gateway_mode": true,
				"logged_in":    false,
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"gateway_mode": true,
			"logged_in":    true,
			"user": gin.H{
				"uid":      user.UID,
				"username": user.Username,
				"is_admin": user.IsAdmin,
			},
		})
		return
	}
	req := h.auth.RequireAuth()
	setupPending := req && !h.auth.IsConfirmed()
	c.JSON(http.StatusOK, gin.H{
		"auth_required": req,
		"setup_pending": setupPending,
	})
}

func (h *handler) authSetupGet(c *gin.Context) {
	if h.auth.gatewayMode {
		c.JSON(http.StatusNotFound, gin.H{"error": "网关模式下不支持此接口"})
		return
	}
	if !h.auth.RequireAuth() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "鉴权已关闭"})
		return
	}
	if h.auth.IsConfirmed() {
		logrus.Debugf("[鉴权] Setup GET 被拒绝 (来自 %s)：已确认", c.ClientIP())
		c.JSON(http.StatusForbidden, gin.H{"error": "初始设置已完成，无法再次获取"})
		return
	}
	logrus.Infof("[鉴权] Setup GET：向 %s 返回默认 API Key", c.ClientIP())
	c.JSON(http.StatusOK, gin.H{"token": h.auth.getToken()})
}

func (h *handler) authSetupPost(c *gin.Context) {
	if h.auth.gatewayMode {
		c.JSON(http.StatusNotFound, gin.H{"error": "网关模式下不支持此接口"})
		return
	}
	if !h.auth.RequireAuth() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "鉴权已关闭"})
		return
	}
	if h.auth.IsConfirmed() {
		logrus.Debugf("[鉴权] Setup POST 被拒绝 (来自 %s)：已确认", c.ClientIP())
		c.JSON(http.StatusForbidden, gin.H{"error": "初始设置已完成"})
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if req.Token != "" && len(req.Token) < 32 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "API Key 长度不得少于 32 个字符"})
		return
	}
	if err := h.auth.confirm(req.Token); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "确认失败"})
		logrus.Errorf("[鉴权] 确认 API Key 失败：%v", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *handler) authReset(c *gin.Context) {
	if h.auth.gatewayMode {
		c.JSON(http.StatusNotFound, gin.H{"error": "网关模式下不支持此接口"})
		return
	}
	if !h.auth.RequireAuth() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "鉴权已关闭"})
		return
	}
	token := extractToken(c)
	if token == "" || !h.auth.validateToken(token) {
		logrus.Warnf("[鉴权] Reset 被拒绝 (来自 %s)：当前 API Key 无效", c.ClientIP())
		c.JSON(http.StatusUnauthorized, gin.H{"error": "当前 API Key 无效"})
		return
	}
	var req struct {
		NewToken string `json:"new_token" binding:"required"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if len(req.NewToken) < 32 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "新 API Key 长度不得少于 32 个字符"})
		return
	}
	if err := h.auth.resetToken(req.NewToken); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "重置失败"})
		logrus.Errorf("[鉴权] 重置 API Key 失败：%v", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
