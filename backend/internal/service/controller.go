package service

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/driver"
	"fancontrolserver/internal/model"
)

type Controller struct {
	store               *Store
	hwmon               *driver.HWMONDriver
	system              *driver.SystemDriver
	smartctl            *driver.SmartCtlDriver
	gpu                 *driver.GPUDriver
	mu                  sync.RWMutex
	telemetry           model.Telemetry
	history             model.HistorySeries
	lastPWM             map[string]int
	lastValidPWM        map[string]int // 滞回区间保留的最后有效PWM
	subs                map[chan model.Telemetry]struct{}
	stopCh              chan struct{}
	stopped             bool
	loopDoneCh          chan struct{}
	startTime           time.Time
	lastCPUHistoryTime  time.Time // CPU 历史上次记录时间
	lastGPUHistoryTime  time.Time // GPU 历史上次记录时间
	lastDiskHistoryTime time.Time // 磁盘历史上次记录时间
	lastFanHistoryTime  time.Time // 风扇历史上次记录时间
	sensorChans         []driver.TempChannel // 缓存 hwmon 温度通道列表
	lastSensorScan      time.Time            // 上次扫描时间
}

func NewController(store *Store) *Controller {
	return &Controller{
		store:        store,
		hwmon:        driver.NewHWMONDriver(),
		system:       driver.NewSystemDriver(),
		smartctl:     driver.NewSmartCtlDriver(),
		gpu:          driver.NewGPUDriver(),
		lastPWM:      map[string]int{},
		lastValidPWM: map[string]int{},
		subs:         map[chan model.Telemetry]struct{}{},
		stopCh:       make(chan struct{}),
		loopDoneCh:   make(chan struct{}),
		startTime:    time.Now(),
		history: model.HistorySeries{
			CPUTemp: []model.HistoryPoint{},
			GPUTemp: []model.HistoryPoint{},
			DiskAvg: []model.HistoryPoint{},
			Fans:    map[string][]model.FanHistoryPoint{},
		},
	}
}

func (c *Controller) Start() error {
	c.autoDiscoverFansOnFirstRun()
	go c.loop()
	return nil
}

func (c *Controller) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	close(c.stopCh)
	c.mu.Unlock()

	<-c.loopDoneCh
	c.applyStopBehavior()
}

func (c *Controller) Telemetry() model.Telemetry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.telemetry
}

func (c *Controller) Subscribe() chan model.Telemetry {
	ch := make(chan model.Telemetry, 4)
	c.mu.Lock()
	c.subs[ch] = struct{}{}
	c.mu.Unlock()
	return ch
}

func (c *Controller) Unsubscribe(ch chan model.Telemetry) {
	c.mu.Lock()
	delete(c.subs, ch)
	close(ch)
	c.mu.Unlock()
}

func (c *Controller) loop() {
	defer close(c.loopDoneCh)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
		case <-c.stopCh:
			return
		}

		cfg := c.store.Get()
		t := c.collectAndApply(cfg)
		c.mu.Lock()
		c.pushTempHistory(&c.history.CPUTemp, &c.lastCPUHistoryTime, t.Timestamp, t.CPUTemp)
		c.pushTempHistory(&c.history.GPUTemp, &c.lastGPUHistoryTime, t.Timestamp, t.GPUTemp)
		c.pushTempHistory(&c.history.DiskAvg, &c.lastDiskHistoryTime, t.Timestamp, t.Disks.AvgTemp)
		t.History = c.history
		c.telemetry = t
		for sub := range c.subs {
			select {
			case sub <- t:
			default:
			}
		}
		c.mu.Unlock()

		wait := time.Duration(cfg.Global.UpdateIntervalMS) * time.Millisecond
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
	}
}

func (c *Controller) collectAndApply(cfg model.Config) model.Telemetry {
	now := time.Now()
	cpuTemp, _ := c.system.CPUTemp()
	cpuUsage, _ := c.system.CPUUsage()
	memUsage, memTotal, _ := c.system.MemInfo()
	gpuTemp, _ := c.gpu.Temp()
	logrus.Debugf("[温度] CPU=%.1f°C GPU=%.1f°C", ptrOrNil(cpuTemp), ptrOrNil(gpuTemp))

	// 计算系统运行时间（秒）
	uptime := int64(now.Sub(c.startTime).Seconds())

	disks := c.readDisks()
	sensors := c.readSensors()
	fans := make([]model.FanRuntime, 0, len(cfg.Fans))
	for _, fan := range cfg.Fans {
		target, controlTemp := c.calculateTargetPWM(fan, cfg.Global, cpuTemp, gpuTemp, disks, sensors)
		var applied int
		if target < 0 {
			// 温度源不可用（如硬盘休眠），保持上次 PWM 不动
			if v, ok := c.lastPWM[fan.ID]; ok {
				applied = v
			}
		} else {
			applied = c.applyPWM(fan, cfg.Global, target)
		}
		rpm := 0
		if fan.RPMPath != "" {
			if value, err := c.hwmon.ReadRPM(fan.RPMPath); err == nil {
				rpm = value
			}
		}
		status := evaluateFanStatus(rpm)
		fans = append(fans, model.FanRuntime{
			ID:        fan.ID,
			Name:      fan.Name,
			PWM:       applied,
			RPM:       rpm,
			Status:    status,
			Source:    fan.Source,
			Mode:      fan.Mode,
			TargetPWM: target,
		})
		//  前端尚未展示风扇历史图表，暂时禁用采集以减少开销
		// c.pushFanHistory(fan.ID, now, rpm, applied)
		_ = controlTemp
	}

	return model.Telemetry{
		CPUTemp:   cpuTemp,
		CPUUsage:  round(cpuUsage),
		MemUsage:  round(memUsage),
		MemTotal:  memTotal,
		GPUTemp:   gpuTemp,
		Uptime:    uptime,
		Disks:     disks,
		Fans:      fans,
		Sensors:   sensors,
		Timestamp: now,
	}
}

// readSensors 读取所有 hwmon 温度通道。通道列表每分钟刷新一次，避免每秒 Glob。
func (c *Controller) readSensors() []model.SensorReading {
	if time.Since(c.lastSensorScan) > time.Minute || c.sensorChans == nil {
		if chans, err := c.hwmon.ScanTempChannels(); err == nil {
			c.sensorChans = chans
			c.lastSensorScan = time.Now()
		} else {
			logrus.Debugf("[传感器] 扫描温度通道失败：%v", err)
		}
	}
	out := make([]model.SensorReading, 0, len(c.sensorChans))
	for _, ch := range c.sensorChans {
		v, _ := c.hwmon.ReadTemp(ch.Path)
		out = append(out, model.SensorReading{
			ID:     ch.ID,
			Chip:   ch.Chip,
			Device: ch.Device,
			Key:    ch.Key,
			Label:  ch.Label,
			Temp:   v,
		})
	}
	return out
}

func (c *Controller) readDisks() model.DiskPayload {
	names, err := c.smartctl.ScanDisks()
	if err != nil {
		logrus.Debugf("[磁盘] 扫描磁盘失败: %v", err)
		return model.DiskPayload{}
	}
	details := make([]model.DiskInfo, 0, len(names))
	var sum float64
	var count int
	for _, name := range names {
		info := c.smartctl.ReadDisk(name)
		details = append(details, info)
		if info.Status == model.DiskStatusActive && info.Temp != nil {
			sum += *info.Temp
			count++
		}
	}
	var avg *float64
	if count > 0 {
		v := round(sum / float64(count))
		avg = &v
		logrus.Debugf("[磁盘] 发现%d个活跃磁盘，平均温度%.1f°C", count, *avg)
	}
	return model.DiskPayload{AvgTemp: avg, Details: details}
}

func (c *Controller) calculateTargetPWM(
	fan model.FanConfig, global model.GlobalConfig,
	cpuTemp, gpuTemp *float64, disks model.DiskPayload, sensors []model.SensorReading,
) (int, *float64) {
	if fan.Mode == model.FanModeManual {
		logrus.Debugf("[控制器] 风扇 %s 手动模式 PWM=%d", fan.Name, fan.ManualPWM)
		return clampPWM(fan.ManualPWM), nil
	}

	temp := c.resolveSourceTemp(fan.Source, cpuTemp, gpuTemp, disks, sensors)
	if temp == nil {
		logrus.Warnf("[控制器] 风扇 %s 无法获取温度(源=%s)，保持当前转速", fan.Name, fan.Source)
		return -1, nil
	}
	if *temp >= global.EmergencyTemp {
		logrus.Warnf("[控制器] 风扇 %s 温度%.1f°C ≥ 紧急温度%.1f°C，全速!", fan.Name, *temp, global.EmergencyTemp)
		return 255, temp
	}

	// 计算曲线基础 PWM 值
	basePWM := interpolateCurve(fan.Curve, *temp)

	// 滞回逻辑：防止温度临界点时频繁启停
	pwm := c.applyStopHysteresis(fan.ID, fan.Curve, *temp, basePWM, global.StopHysteresis)
	logrus.Debugf("[控制器] 风扇 %s | 温度=%.1f°C | 曲线PWM=%d | 最终PWM=%d", fan.Name, *temp, basePWM, pwm)
	return clampPWM(pwm), temp
}

// applyStopHysteresis 滞回停转逻辑
// 启动温度：曲线首点温度
// 停止温度：曲线首点温度 - 滞回值
// 滞回区间内保持最后有效 PWM
func (c *Controller) applyStopHysteresis(fanID string, curve []model.CurvePoint, temp float64, basePWM int, hysteresis float64) int {
	if len(curve) == 0 || hysteresis <= 0 {
		return basePWM
	}

	firstTemp := curve[0].Temp
	stopThreshold := firstTemp - hysteresis

	// 温度低于停止阈值
	if temp < stopThreshold {
		// 风扇正在转动 -> 记录当前PWM为最后有效值，然后停转
		c.mu.Lock()
		if basePWM > 0 {
			c.lastValidPWM[fanID] = basePWM
		}
		c.mu.Unlock()
		logrus.Debugf("[滞回] 温度%.1f°C < 停转阈值%.1f°C，停转", temp, stopThreshold)
		return 0
	}

	// 温度在滞回区间（stopThreshold <= temp < firstTemp）
	if temp < firstTemp && basePWM == 0 {
		// 风扇已停转，滞回区间内保持停转
		logrus.Debugf("[滞回] 温度%.1f°C 在滞回区间[%.1f~%.1f]，保持停转", temp, stopThreshold, firstTemp)
		return 0
	}

	// 温度在滞回区间内，但曲线计算值非0
	if temp < firstTemp {
		// 返回最后有效 PWM（防止启停）
		c.mu.Lock()
		if lastValid, ok := c.lastValidPWM[fanID]; ok && lastValid > 0 {
			c.mu.Unlock()
			logrus.Debugf("[滞回] 温度%.1f°C 在滞回区间，保留最后有效PWM=%d", temp, lastValid)
			return lastValid
		}
		c.mu.Unlock()
		return basePWM
	}

	// 温度 >= 首点温度，正常按曲线计算
	c.mu.Lock()
	if basePWM > 0 {
		c.lastValidPWM[fanID] = basePWM
	}
	c.mu.Unlock()
	return basePWM
}

func (c *Controller) resolveSourceTemp(
	source string, cpuTemp, gpuTemp *float64,
	disks model.DiskPayload, sensors []model.SensorReading,
) *float64 {
	switch {
	case source == "cpu":
		return cpuTemp
	case source == "gpu":
		return gpuTemp
	case source == "disk_avg":
		return disks.AvgTemp
	case source == "disk_max":
		var best *float64
		for _, disk := range disks.Details {
			if disk.Temp != nil && (best == nil || *disk.Temp > *best) {
				v := *disk.Temp
				best = &v
			}
		}
		return best
	case source == "max":
		var best *float64
		consider := func(v *float64) {
			if v != nil && (best == nil || *v > *best) {
				cp := *v
				best = &cp
			}
		}
		consider(cpuTemp)
		consider(gpuTemp)
		consider(disks.AvgTemp)
		for _, disk := range disks.Details {
			consider(disk.Temp)
		}
		for _, s := range sensors {
			consider(s.Temp)
		}
		return best
	case strings.HasPrefix(source, "disk:"):
		name := source[len("disk:"):]
		for _, disk := range disks.Details {
			if disk.Name == name && disk.Status == model.DiskStatusActive && disk.Temp != nil {
				v := *disk.Temp
				return &v
			}
		}
	case strings.HasPrefix(source, "sensor:"):
		id := source[len("sensor:"):]
		for _, s := range sensors {
			if s.ID == id && s.Temp != nil {
				v := *s.Temp
				return &v
			}
		}
	case strings.HasPrefix(source, "combo_avg:"):
		keys := strings.Split(source[len("combo_avg:"):], ",")
		var sum float64
		var count int
		for _, k := range keys {
			if t := c.resolveSourceTemp(strings.TrimSpace(k), cpuTemp, gpuTemp, disks, sensors); t != nil {
				sum += *t
				count++
			}
		}
		if count == 0 {
			return nil
		}
		v := sum / float64(count)
		return &v
	case strings.HasPrefix(source, "combo_max:"):
		keys := strings.Split(source[len("combo_max:"):], ",")
		var best *float64
		for _, k := range keys {
			if t := c.resolveSourceTemp(strings.TrimSpace(k), cpuTemp, gpuTemp, disks, sensors); t != nil {
				if best == nil || *t > *best {
					v := *t
					best = &v
				}
			}
		}
		return best
	}
	return nil
}

func (c *Controller) applyPWM(fan model.FanConfig, global model.GlobalConfig, target int) int {
	target = clampPWM(target)

	// 获取真实当前 PWM（从缓存或硬件读取）
	current, ok := c.lastPWM[fan.ID]
	if !ok {
		// 首次：从硬件读取
		if val, err := c.hwmon.ReadPWM(fan.PWMPath); err == nil {
			current = val
		} else {
			current = 0 // 读取失败时保守设为0
		}
		c.lastPWM[fan.ID] = current
	}

	if abs(target-current) < global.PWMDeadzone {
		return current
	}

	// 写入硬件
	if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, target); err != nil {
		logrus.Warnf("[PWM] 风扇 %s 写入失败: %v", fan.ID, err)
		return current
	}

	// 更新缓存
	c.lastPWM[fan.ID] = target
	logrus.Infof("[PWM] 风扇 %s: PWM %d(%d%%) → %d(%d%%)", fan.Name, current, current*100/255, target, target*100/255)
	return target
}

func (c *Controller) applyStopBehavior() {
	cfg := c.store.Get()
	if cfg.Global.StopBehavior != model.StopBehaviorSet {
		logrus.Info("[控制器] 退出行为：保持当前 PWM")
		return
	}
	targetPWM := clampPWM(cfg.Global.StopPWM)
	logrus.Infof("[控制器] 退出行为：将所有风扇设为 PWM=%d", targetPWM)
	for _, fan := range cfg.Fans {
		if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, targetPWM); err != nil {
			logrus.Warnf("[控制器] 退出写入 PWM 失败，风扇 %s（%s）：%v", fan.Name, fan.ID, err)
		} else {
			logrus.Infof("[控制器] 退出写入成功，风扇 %s → PWM=%d", fan.Name, targetPWM)
		}
	}
}

func (c *Controller) SaveConfig(cfg model.Config) error {
	return c.store.Save(cfg)
}

func (c *Controller) SetFanMode(id string, mode model.FanMode) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Mode = mode
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanSource(id, source string) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Source = source
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanManualPWM(id string, pwm int) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].ManualPWM = clampPWM(pwm)
			cfg.Fans[i].Mode = model.FanModeManual
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanCurve(id string, curve []model.CurvePoint) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Curve = curve
			cfg.Fans[i].Mode = model.FanModeCurve
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

// RemoveFan 从配置中移除指定风扇，并清理该风扇的历史曲线缓存。
func (c *Controller) RemoveFan(id string) error {
	cfg := c.store.Get()
	newFans := make([]model.FanConfig, 0, len(cfg.Fans))
	found := false
	for _, f := range cfg.Fans {
		if f.ID != id {
			newFans = append(newFans, f)
		} else {
			found = true
		}
	}
	if !found {
		return errors.New("未找到指定风扇")
	}
	cfg.Fans = newFans
	if err := c.store.Save(cfg); err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.history.Fans, id)
	delete(c.lastPWM, id)
	delete(c.lastValidPWM, id)
	c.mu.Unlock()
	return nil
}

func (c *Controller) ScanFans() ([]map[string]string, error) {
	return c.hwmon.ScanFans()
}

func (c *Controller) autoDiscoverFansOnFirstRun() {
	if !c.store.IsFirstRun() {
		return
	}

	cfg := c.store.Get()
	if len(cfg.Fans) > 0 {
		return
	}

	scanned, err := c.ScanFans()
	if err != nil {
		logrus.Warnf("[controller] first-run fan scan failed: %v", err)
		return
	}
	if len(scanned) == 0 {
		logrus.Infof("[controller] first-run fan scan found no PWM channels")
		return
	}

	cfg.Fans = make([]model.FanConfig, 0, len(scanned))
	for i, item := range scanned {
		id := strings.TrimSpace(item["id"])
		if id == "" {
			id = fmt.Sprintf("fan%d", i+1)
		}

		name := strings.TrimSpace(item["name"])
		if name == "" {
			name = fmt.Sprintf("Fan %d", i+1)
		}

		cfg.Fans = append(cfg.Fans, model.FanConfig{
			ID:         id,
			Name:       name,
			PWMPath:    strings.TrimSpace(item["pwm_path"]),
			RPMPath:    strings.TrimSpace(item["rpm_path"]),
			EnablePath: strings.TrimSpace(item["enable_path"]),
			Mode:       model.FanModeCurve,
			Source:     "cpu",
			Curve: []model.CurvePoint{
				{Temp: 35, PWM: 80},
				{Temp: 45, PWM: 120},
				{Temp: 60, PWM: 180},
				{Temp: 75, PWM: 255},
			},
		})
	}

	if err = c.store.Save(cfg); err != nil {
		logrus.Warnf("[controller] save auto-discovered fans failed: %v", err)
		return
	}
	logrus.Infof("[controller] first-run auto-discovered %d fan(s)", len(cfg.Fans))
}

func (c *Controller) pushTempHistory(dst *[]model.HistoryPoint, lastTime *time.Time, now time.Time, value *float64) {
	// 每1分钟记录一次历史数据
	if now.Sub(*lastTime) < time.Minute {
		return
	}
	*lastTime = now
	*dst = append(*dst, model.HistoryPoint{Time: now.Format("15:04"), Value: value})
	if len(*dst) > 60 {
		*dst = (*dst)[len(*dst)-60:]
	}
}

func (c *Controller) pushFanHistory(id string, now time.Time, rpm, pwm int) {
	if now.Sub(c.lastFanHistoryTime) < time.Minute {
		return
	}
	series := append(c.history.Fans[id], model.FanHistoryPoint{Time: now.Format("15:04"), RPM: rpm, PWM: pwm})
	if len(series) > 60 {
		series = series[len(series)-60:]
	}
	c.history.Fans[id] = series
}

func evaluateFanStatus(rpm int) model.FanStatus {
	if rpm == 0 {
		return model.FanStatusStopped
	}
	return model.FanStatusNormal
}

func interpolateCurve(points []model.CurvePoint, temp float64) int {
	if len(points) == 0 {
		return 0
	}
	if temp < points[0].Temp {
		logrus.Debugf("[曲线] 温度%.1f°C < 首点%.1f°C，停转", temp, points[0].Temp)
		return 0
	}
	for i := 1; i < len(points); i++ {
		if temp <= points[i].Temp {
			prev := points[i-1]
			next := points[i]
			if next.Temp == prev.Temp {
				return prev.PWM
			}
			ratio := (temp - prev.Temp) / (next.Temp - prev.Temp)
			result := int(math.Round(float64(prev.PWM) + ratio*float64(next.PWM-prev.PWM)))
			logrus.Debugf("[曲线] %.1f°C → [%d%%, %d%%] 插值 → PWM=%d", temp, prev.PWM, next.PWM, result)
			return result
		}
	}
	result := points[len(points)-1].PWM
	return result
}

func clampPWM(v int) int {
	return maxInt(0, minInt(255, v))
}

func round(v float64) float64 {
	return math.Round(v*10) / 10
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// ptrOrNil 安全获取指针值
func ptrOrNil(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}
