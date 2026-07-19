// Package update 检查 GitHub Release 是否有新版本。
package update

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/version"
)

const (
	githubLatestURL  = "https://api.github.com/repos/guan-ry/FanControlServerApp/releases/latest"
	successCacheTTL  = 6 * time.Hour
	failureCacheTTL  = 10 * time.Minute
	forceMinInterval = 30 * time.Second
	httpTimeout      = 8 * time.Second
	maxNotesBytes    = 8 * 1024
	userAgent        = "FanControlServer"
)

// Result 检查更新结果（始终可 JSON 序列化返回给前端）。
type Result struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest,omitempty"`
	HasUpdate bool      `json:"has_update"`
	URL       string    `json:"url,omitempty"`
	Notes     string    `json:"notes,omitempty"`
	CheckedAt time.Time `json:"checked_at"`
	CheckOK   bool      `json:"check_ok"`
	Error     string    `json:"error,omitempty"`
}

type cacheEntry struct {
	result    Result
	expiresAt time.Time
	ok        bool // 成功拉取过 GitHub
}

// Checker 进程内单例检查器：缓存 + 飞行中请求合并。
type Checker struct {
	client *http.Client

	mu            sync.Mutex
	cache         *cacheEntry
	inflight      chan struct{} // 非 nil 表示有请求在飞；关闭时表示完成
	inflightRes   Result
	lastForceOKAt time.Time
}

// NewChecker 创建检查器。
func NewChecker() *Checker {
	return &Checker{
		client: &http.Client{Timeout: httpTimeout},
	}
}

// Check 检查是否有新版本。force 时尽量跳过成功缓存（仍受飞行合并与 30s 最短间隔约束）。
func (c *Checker) Check(force bool) Result {
	c.mu.Lock()

	now := time.Now()
	current := strings.TrimSpace(version.Version)

	// 非 force：命中未过期缓存
	if !force && c.cache != nil && now.Before(c.cache.expiresAt) {
		out := c.cache.result
		c.mu.Unlock()
		out.Current = current
		out.HasUpdate = isNewer(out.Latest, current)
		return out
	}

	// force：成功后 30s 内仍用刚写入的成功缓存，避免连点
	if force && c.cache != nil && c.cache.ok && !c.lastForceOKAt.IsZero() && now.Sub(c.lastForceOKAt) < forceMinInterval {
		out := c.cache.result
		c.mu.Unlock()
		out.Current = current
		out.HasUpdate = isNewer(out.Latest, current)
		return out
	}

	// 已有飞行中请求：等待同一结果
	if c.inflight != nil {
		ch := c.inflight
		c.mu.Unlock()
		<-ch
		c.mu.Lock()
		out := c.inflightRes
		c.mu.Unlock()
		out.Current = current
		out.HasUpdate = isNewer(out.Latest, current)
		return out
	}

	ch := make(chan struct{})
	c.inflight = ch
	c.mu.Unlock()

	res := c.fetchLatest(current)

	c.mu.Lock()
	c.inflightRes = res
	ttl := failureCacheTTL
	if res.CheckOK {
		ttl = successCacheTTL
		if force {
			c.lastForceOKAt = time.Now()
		}
	}
	c.cache = &cacheEntry{result: res, expiresAt: time.Now().Add(ttl), ok: res.CheckOK}
	c.inflight = nil
	close(ch)
	c.mu.Unlock()

	return res
}

type githubRelease struct {
	TagName    string `json:"tag_name"`
	HTMLURL    string `json:"html_url"`
	Body       string `json:"body"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

func (c *Checker) fetchLatest(current string) Result {
	now := time.Now()
	base := Result{
		Current:   current,
		CheckedAt: now,
		CheckOK:   false,
		HasUpdate: false,
	}

	req, err := http.NewRequest(http.MethodGet, githubLatestURL, nil)
	if err != nil {
		base.Error = err.Error()
		logrus.Warnf("[更新检查] 创建请求失败：%v", err)
		return base
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.client.Do(req)
	if err != nil {
		base.Error = "无法连接 GitHub：" + err.Error()
		logrus.Warnf("[更新检查] 请求失败：%v", err)
		return base
	}
	defer func(Body io.ReadCloser) {
		err = Body.Close()
		if err != nil {

		}
	}(resp.Body)

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxNotesBytes+64*1024))
	if err != nil {
		base.Error = "读取响应失败：" + err.Error()
		logrus.Warnf("[更新检查] 读取响应失败：%v", err)
		return base
	}
	if resp.StatusCode != http.StatusOK {
		base.Error = fmt.Sprintf("GitHub 返回 HTTP %d", resp.StatusCode)
		logrus.Warnf("[更新检查] %s", base.Error)
		return base
	}

	var rel githubRelease
	if err := json.Unmarshal(body, &rel); err != nil {
		base.Error = "解析 Release 失败"
		logrus.Warnf("[更新检查] JSON 解析失败：%v", err)
		return base
	}
	if rel.Draft || rel.Prerelease {
		base.Error = "最新 Release 为预发布/草稿，已忽略"
		base.CheckOK = true
		base.Latest = normalizeVersion(rel.TagName)
		base.URL = rel.HTMLURL
		return base
	}

	latest := normalizeVersion(rel.TagName)
	notes := rel.Body
	if len(notes) > maxNotesBytes {
		notes = notes[:maxNotesBytes] + "\n…"
	}
	if strings.TrimSpace(notes) == "" {
		notes = "暂无更新说明"
	}

	base.CheckOK = true
	base.Latest = latest
	base.URL = rel.HTMLURL
	base.Notes = notes
	base.HasUpdate = isNewer(latest, current)
	base.Error = ""
	logrus.Debugf("[更新检查] current=%s latest=%s has_update=%v", current, latest, base.HasUpdate)
	return base
}

func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	// 只取 x.y.z，去掉 -beta 等后缀
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	return v
}

func parseSemver(v string) (parts []int, ok bool) {
	v = normalizeVersion(v)
	if v == "" {
		return nil, false
	}
	segs := strings.Split(v, ".")
	parts = make([]int, len(segs))
	for i, s := range segs {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return nil, false
		}
		parts[i] = n
	}
	return parts, true
}

// isNewer 当 latest > current 时返回 true（按点分段从左到右比较，支持 1.3.6.1 这类四段版本）。
func isNewer(latest, current string) bool {
	lp, ok1 := parseSemver(latest)
	cp, ok2 := parseSemver(current)
	if !ok1 || !ok2 {
		return false
	}
	n := len(lp)
	if len(cp) > n {
		n = len(cp)
	}
	for i := 0; i < n; i++ {
		var a, b int
		if i < len(lp) {
			a = lp[i]
		}
		if i < len(cp) {
			b = cp[i]
		}
		if a != b {
			return a > b
		}
	}
	return false
}
