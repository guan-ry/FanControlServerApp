// mockserver 提供一个跨平台（Windows / macOS / Linux 可跑）的假后端，
// 用于在不接入真实硬件的环境下调试前端 UI / 交互。
// 它复用真实后端的 model 类型，确保接口形态与生产 100% 一致。
//
// 运行方式（Windows PowerShell）：
//   cd backend
//   go run ./cmd/mockserver
// 默认监听 :19528，与 frontend/vite.config.ts 的 proxy 目标对齐。
package main

import (
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"fancontrolserver/internal/model"
)

// ============== 状态 ==============

type mockState struct {
	mu    sync.RWMutex
	cfg   model.Config
	tick  int
	start time.Time
	subs  map[chan model.Telemetry]struct{}
}

func newMockState() *mockState {
	return &mockState{
		cfg:   defaultConfig(),
		start: time.Now(),
		subs:  map[chan model.Telemetry]struct{}{},
	}
}

func defaultConfig() model.Config {
	return model.Config{
		Fans: []model.FanConfig{
			{
				ID:         "mock-pwm1",
				Name:       "CPU 风扇",
				PWMPath:    "/mock/hwmon0/pwm1",
				RPMPath:    "/mock/hwmon0/fan1_input",
				EnablePath: "/mock/hwmon0/pwm1_enable",
				Mode:       model.FanModeCurve,
				Source:     "cpu",
				ManualPWM:  128,
				Curve: []model.CurvePoint{
					{Temp: 35, PWM: 80},
					{Temp: 55, PWM: 150},
					{Temp: 75, PWM: 255},
				},
			},
			{
				ID:        "mock-pwm2",
				Name:      "机箱风扇",
				PWMPath:   "/mock/hwmon0/pwm2",
				Mode:      model.FanModeManual,
				Source:    "max",
				ManualPWM: 100,
				Curve: []model.CurvePoint{
					{Temp: 30, PWM: 60},
					{Temp: 60, PWM: 200},
				},
			},
		},
		Global: model.GlobalConfig{
			PWMDeadzone:      5,
			UpdateIntervalMS: 1000,
			EmergencyTemp:    80,
			StopBehavior:     model.StopBehaviorSet,
			StopPWM:          200,
			StopHysteresis:   2,
			LogLevel:         "info",
			SourceMode:       "simple",
			SensorAliases:    map[string]string{},
			SensorHidden:     []string{},
		},
	}
}

// ============== 数据生成 ==============

func wave(base, amp float64, tick, period int) float64 {
	return base + amp*math.Sin(float64(tick)/float64(period))
}

func makeSensor(id, chip, dev, key, label string, t float64) model.SensorReading {
	v := t
	return model.SensorReading{ID: id, Chip: chip, Device: dev, Key: key, Label: label, Temp: &v}
}

func interpCurve(curve []model.CurvePoint, t float64) int {
	if len(curve) == 0 {
		return 0
	}
	if t < curve[0].Temp {
		return 0
	}
	for i := 1; i < len(curve); i++ {
		if t <= curve[i].Temp {
			prev, next := curve[i-1], curve[i]
			if next.Temp == prev.Temp {
				return prev.PWM
			}
			r := (t - prev.Temp) / (next.Temp - prev.Temp)
			return int(float64(prev.PWM) + r*float64(next.PWM-prev.PWM))
		}
	}
	return curve[len(curve)-1].PWM
}

func (s *mockState) buildTelemetry() model.Telemetry {
	s.mu.Lock()
	s.tick++
	tick := s.tick
	cfg := s.cfg
	s.mu.Unlock()

	cpuTemp := wave(50, 15, tick, 12)
	gpuTemp := wave(55, 10, tick, 8)
	cpuUse := wave(40, 25, tick, 10)
	memUse := wave(55, 5, tick, 15)
	memTot := 16.0
	diskAvg := wave(38, 4, tick, 20)
	nvmeTemp := wave(45, 6, tick, 15)

	mbBase := wave(40, 5, tick, 25)
	sensors := []model.SensorReading{
		// CPU 温度（Intel coretemp）
		makeSensor("coretemp//temp1", "coretemp", "", "temp1", "Package id 0", cpuTemp),
		makeSensor("coretemp//temp2", "coretemp", "", "temp2", "Core 0", cpuTemp-2),
		makeSensor("coretemp//temp3", "coretemp", "", "temp3", "Core 1", cpuTemp-1),
		makeSensor("coretemp//temp4", "coretemp", "", "temp4", "Core 2", cpuTemp-3),
		makeSensor("coretemp//temp5", "coretemp", "", "temp5", "Core 3", cpuTemp-2),

		// 主板 Super-IO（Nuvoton nct6798）
		makeSensor("nct6798//temp1", "nct6798", "", "temp1", "SYSTIN", mbBase),
		makeSensor("nct6798//temp2", "nct6798", "", "temp2", "CPUTIN", cpuTemp+1),
		makeSensor("nct6798//temp3", "nct6798", "", "temp3", "AUXTIN0", wave(35, 3, tick, 30)),
		makeSensor("nct6798//temp4", "nct6798", "", "temp4", "AUXTIN1", wave(33, 4, tick, 35)),

		// 芯片组（Intel PCH）
		makeSensor("pch_cannonlake//temp1", "pch_cannonlake", "", "temp1", "", wave(55, 3, tick, 18)),

		// ACPI 热区（几乎所有 x86 都有）
		makeSensor("acpitz//temp1", "acpitz", "", "temp1", "", wave(45, 4, tick, 22)),

		// Intel 集成 GPU
		makeSensor("i915/0000:00:02.0/temp1", "i915", "0000:00:02.0", "temp1", "", wave(48, 6, tick, 14)),

		// NVMe 多盘
		makeSensor("nvme/nvme0/temp1", "nvme", "nvme0", "temp1", "Composite", nvmeTemp),
		makeSensor("nvme/nvme1/temp1", "nvme", "nvme1", "temp1", "Composite", nvmeTemp-3),
		makeSensor("nvme/nvme1/temp2", "nvme", "nvme1", "temp2", "Sensor 1", nvmeTemp-2),

		// SATA 硬盘（drivetemp 内核 5.6+）
		makeSensor("drivetemp/sda/temp1", "drivetemp", "sda", "temp1", "", wave(38, 3, tick, 28)),
		makeSensor("drivetemp/sdb/temp1", "drivetemp", "sdb", "temp1", "", wave(36, 3, tick, 32)),

		// WiFi 网卡
		makeSensor("iwlwifi_1//temp1", "iwlwifi_1", "", "temp1", "", wave(50, 4, tick, 16)),
	}

	fans := make([]model.FanRuntime, 0, len(cfg.Fans))
	for _, f := range cfg.Fans {
		target := f.ManualPWM
		if f.Mode == model.FanModeCurve {
			target = interpCurve(f.Curve, cpuTemp)
		}
		rpm := target * 12
		status := model.FanStatusNormal
		if target == 0 {
			rpm = 0
			status = model.FanStatusStopped
		}
		fans = append(fans, model.FanRuntime{
			ID:        f.ID,
			Name:      f.Name,
			PWM:       target,
			RPM:       rpm,
			Status:    status,
			Source:    f.Source,
			Mode:      f.Mode,
			TargetPWM: target,
		})
	}

	cp, gp, da, mt := cpuTemp, gpuTemp, diskAvg, memTot
	dskA := diskAvg + 1
	nvm := nvmeTemp

	return model.Telemetry{
		CPUTemp:  &cp,
		CPUUsage: cpuUse,
		MemUsage: memUse,
		MemTotal: &mt,
		GPUTemp:  &gp,
		Uptime:   int64(time.Since(s.start).Seconds()),
		Disks: model.DiskPayload{
			AvgTemp: &da,
			Details: []model.DiskInfo{
				{Name: "sda", Temp: &dskA, Status: model.DiskStatusActive},
				{Name: "sdb", Status: model.DiskStatusSleep},
				{Name: "nvme0n1", Temp: &nvm, Status: model.DiskStatusActive},
			},
		},
		Fans:      fans,
		Sensors:   sensors,
		Timestamp: time.Now(),
		History: model.HistorySeries{
			CPUTemp: []model.HistoryPoint{},
			GPUTemp: []model.HistoryPoint{},
			DiskAvg: []model.HistoryPoint{},
			Fans:    map[string][]model.FanHistoryPoint{},
		},
	}
}

// ============== WebSocket 推送循环 ==============

func (s *mockState) loop() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for range t.C {
		tel := s.buildTelemetry()
		s.mu.RLock()
		for ch := range s.subs {
			select {
			case ch <- tel:
			default:
			}
		}
		s.mu.RUnlock()
	}
}

// ============== HTTP 路由 ==============

func okHandler(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) }

func main() {
	state := newMockState()
	go state.loop()

	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	r.GET("/api/auth/status", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"auth_required": false, "setup_pending": false})
	})
	r.GET("/api/auth/setup", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"token": "mock-token"})
	})
	r.POST("/api/auth/setup", okHandler)
	r.POST("/api/auth/reset", okHandler)

	api := r.Group("/api")

	api.GET("/device/info", func(c *gin.Context) {
		c.JSON(http.StatusOK, state.buildTelemetry())
	})

	api.GET("/device/scan", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"fans": []map[string]string{
			{"id": "mock-pwm1", "name": "CPU 风扇", "pwm_path": "/mock/hwmon0/pwm1", "rpm_path": "/mock/hwmon0/fan1_input", "enable_path": "/mock/hwmon0/pwm1_enable"},
			{"id": "mock-pwm2", "name": "机箱风扇", "pwm_path": "/mock/hwmon0/pwm2", "rpm_path": "", "enable_path": ""},
			{"id": "mock-pwm3", "name": "Mock 新风扇", "pwm_path": "/mock/hwmon1/pwm1", "rpm_path": "/mock/hwmon1/fan1_input", "enable_path": ""},
		}})
	})

	api.GET("/fan/config", func(c *gin.Context) {
		state.mu.RLock()
		cfg := state.cfg
		state.mu.RUnlock()
		c.JSON(http.StatusOK, cfg)
	})

	api.POST("/fan/config", func(c *gin.Context) {
		var cfg model.Config
		if err := c.ShouldBindJSON(&cfg); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		state.cfg = cfg
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/fan/set", func(c *gin.Context) {
		var req struct {
			ID  string `json:"id"`
			PWM int    `json:"pwm"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		for i := range state.cfg.Fans {
			if state.cfg.Fans[i].ID == req.ID {
				state.cfg.Fans[i].ManualPWM = req.PWM
				state.cfg.Fans[i].Mode = model.FanModeManual
			}
		}
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/fan/mode", func(c *gin.Context) {
		var req struct {
			ID   string        `json:"id"`
			Mode model.FanMode `json:"mode"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		for i := range state.cfg.Fans {
			if state.cfg.Fans[i].ID == req.ID {
				state.cfg.Fans[i].Mode = req.Mode
			}
		}
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/fan/source", func(c *gin.Context) {
		var req struct {
			ID     string `json:"id"`
			Source string `json:"source"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		for i := range state.cfg.Fans {
			if state.cfg.Fans[i].ID == req.ID {
				state.cfg.Fans[i].Source = req.Source
			}
		}
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/fan/curve", func(c *gin.Context) {
		var req struct {
			ID    string             `json:"id"`
			Curve []model.CurvePoint `json:"curve"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		for i := range state.cfg.Fans {
			if state.cfg.Fans[i].ID == req.ID {
				state.cfg.Fans[i].Curve = req.Curve
				state.cfg.Fans[i].Mode = model.FanModeCurve
			}
		}
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/fan/remove", func(c *gin.Context) {
		var req struct {
			ID string `json:"id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		out := make([]model.FanConfig, 0, len(state.cfg.Fans))
		for _, f := range state.cfg.Fans {
			if f.ID != req.ID {
				out = append(out, f)
			}
		}
		state.cfg.Fans = out
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/global/config", func(c *gin.Context) {
		var g model.GlobalConfig
		if err := c.ShouldBindJSON(&g); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		state.mu.Lock()
		state.cfg.Global = g
		state.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	api.GET("/ws", func(c *gin.Context) {
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()

		ch := make(chan model.Telemetry, 4)
		state.mu.Lock()
		state.subs[ch] = struct{}{}
		state.mu.Unlock()
		defer func() {
			state.mu.Lock()
			delete(state.subs, ch)
			close(ch)
			state.mu.Unlock()
		}()

		if err := conn.WriteJSON(state.buildTelemetry()); err != nil {
			return
		}
		for tel := range ch {
			if err := conn.WriteJSON(tel); err != nil {
				return
			}
		}
	})

	addr := ":19528"
	println("[mock] 监听 http://127.0.0.1" + addr)
	_ = r.Run(addr)
}
