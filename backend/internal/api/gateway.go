package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const gatewayUserKey = "gateway_user"

// GatewayUser 统一网关认证后的当前用户。
type GatewayUser struct {
	UID      string
	Username string
	IsAdmin  bool
}

// GatewayUserFromRequest 从请求中提取网关用户信息。
func GatewayUserFromRequest(c *gin.Context) (*GatewayUser, bool) {
	// 飞牛网关传递的 Header 名称
	uid := strings.TrimSpace(c.GetHeader("X-Trim-Userid"))
	if uid == "" {
		return nil, false
	}
	return &GatewayUser{
		UID:      uid,
		Username: c.GetHeader("X-Trim-Username"),
		IsAdmin:  strings.EqualFold(strings.TrimSpace(c.GetHeader("X-Trim-Isadmin")), "true"),
	}, true
}

// GatewayMiddleware 网关模式鉴权中间件，验证 X-Trim-* Header。
func GatewayMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := GatewayUserFromRequest(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录或网关未透传用户信息"})
			return
		}
		c.Set(gatewayUserKey, user)
		c.Next()
	}
}

// RequireAdminMiddleware 要求管理员权限的中间件。
func RequireAdminMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		v, exists := c.Get(gatewayUserKey)
		if !exists {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		user := v.(*GatewayUser)
		if !user.IsAdmin {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "需要管理员权限"})
			return
		}
		c.Next()
	}
}

// GetGatewayUser 从上下文中获取网关用户。
func GetGatewayUser(c *gin.Context) *GatewayUser {
	v, ok := c.Get(gatewayUserKey)
	if !ok {
		return nil
	}
	return v.(*GatewayUser)
}
