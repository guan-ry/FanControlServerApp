package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// AuthManager 负责区分运行模式：统一网关模式 vs 独立模式。
//
// 统一网关模式：由 fnOS 统一网关完成登录态校验，并透传 X-Trim-* Header，
// 应用据此识别用户并做权限判断（写操作要求管理员）。
//
// 独立模式：不经过网关（如本地调试 / 受信任内网直连），不做鉴权。
type AuthManager struct {
	gatewayMode bool
}

// NewGatewayAuthManager 创建统一网关模式鉴权管理器。
func NewGatewayAuthManager() *AuthManager {
	return &AuthManager{gatewayMode: true}
}

// NewStandaloneAuthManager 创建独立模式鉴权管理器（不做鉴权）。
func NewStandaloneAuthManager() *AuthManager {
	return &AuthManager{gatewayMode: false}
}

// GatewayMode 返回是否运行在统一网关模式下。
func (am *AuthManager) GatewayMode() bool {
	return am.gatewayMode
}

// Middleware 返回鉴权中间件：网关模式校验 X-Trim-* Header，独立模式直接放行。
func (am *AuthManager) Middleware() gin.HandlerFunc {
	if am.gatewayMode {
		return GatewayMiddleware()
	}
	return func(c *gin.Context) { c.Next() }
}

// authStatus 返回当前鉴权模式及登录用户信息，供前端初始化使用。
func (h *handler) authStatus(c *gin.Context) {
	if !h.auth.gatewayMode {
		c.JSON(http.StatusOK, gin.H{"gateway_mode": false})
		return
	}
	user, ok := GatewayUserFromRequest(c)
	if !ok {
		c.JSON(http.StatusOK, gin.H{"gateway_mode": true, "logged_in": false})
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
}
