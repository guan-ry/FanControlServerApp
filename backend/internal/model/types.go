package model

import "time"

type FanMode string

const (
	FanModeManual FanMode = "manual"
	FanModeCurve  FanMode = "curve"
)

type FanStatus string

const (
	FanStatusNormal  FanStatus = "normal"
	FanStatusStopped FanStatus = "stopped"
)

type DiskStatus string

const (
	DiskStatusActive DiskStatus = "active"
	DiskStatusSleep  DiskStatus = "sleep"
)

type StopBehavior string

const (
	StopBehaviorKeep StopBehavior = "keep"
	StopBehaviorSet  StopBehavior = "set"
)

type CurvePoint struct {
	Temp float64 `json:"temp"`
	PWM  int     `json:"pwm"`
}

type FanConfig struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	PWMPath    string       `json:"pwm_path"`
	RPMPath    string       `json:"rpm_path"`
	EnablePath string       `json:"enable_path"`
	Mode       FanMode      `json:"mode"`
	Source     string       `json:"source"`
	ManualPWM  int          `json:"manual_pwm"`
	Curve      []CurvePoint `json:"curve"`
}

type GlobalConfig struct {
	PWMDeadzone      int               `json:"pwm_deadzone"`
	UpdateIntervalMS int               `json:"update_interval_ms"`
	EmergencyTemp    float64           `json:"emergency_temp"`
	StopBehavior     StopBehavior      `json:"stop_behavior"`
	StopPWM          int               `json:"stop_pwm"`
	StopHysteresis   float64           `json:"stop_hysteresis"` // 停转滞回温度（°C）
	LogLevel         string            `json:"log_level"`
	SourceMode       string            `json:"source_mode,omitempty"`    // 温度源选择模式：simple（小白）/ advanced（极客）
	SensorAliases    map[string]string `json:"sensor_aliases,omitempty"` // 传感器ID → 用户别名
	SensorHidden     []string          `json:"sensor_hidden,omitempty"`  // 隐藏的传感器ID列表
}

const CurrentConfigVersion = 1

type Config struct {
	Version int          `json:"version"`
	Fans    []FanConfig  `json:"fans"`
	Global  GlobalConfig `json:"global"`
}

type DiskInfo struct {
	Name   string     `json:"name"`
	Temp   *float64   `json:"temp,omitempty"`
	Status DiskStatus `json:"status"`
}

type DiskPayload struct {
	AvgTemp *float64   `json:"avg_temp,omitempty"`
	Details []DiskInfo `json:"details"`
}

type FanRuntime struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	PWM       int       `json:"pwm"`
	RPM       int       `json:"rpm"`
	Status    FanStatus `json:"status"`
	Source    string    `json:"source"`
	Mode      FanMode   `json:"mode"`
	TargetPWM int       `json:"target_pwm"`
}

type Telemetry struct {
	CPUTemp   *float64        `json:"cpu_temp,omitempty"`
	CPUUsage  float64         `json:"cpu_usage"`
	MemUsage  float64         `json:"mem_usage"`
	MemTotal  *float64        `json:"mem_total,omitempty"`
	GPUTemp   *float64        `json:"gpu_temp,omitempty"`
	Uptime    int64           `json:"uptime"`
	Disks     DiskPayload     `json:"disks"`
	Fans      []FanRuntime    `json:"fans"`
	Sensors   []SensorReading `json:"sensors"`
	Timestamp time.Time       `json:"timestamp"`
	History   HistorySeries   `json:"history"`
}

type SensorReading struct {
	ID     string   `json:"id"`               // chip/device/key，全局稳定 ID
	Chip   string   `json:"chip"`             // 来自 hwmonX/name
	Device string   `json:"device,omitempty"` // 来自 hwmonX/device 软链终端：nvme0、sda、PCI 地址等
	Key    string   `json:"key"`              // 例：temp1
	Label  string   `json:"label"`            // 来自 tempN_label，可能为空
	Temp   *float64 `json:"temp,omitempty"`
}

type HistoryPoint struct {
	Time  string   `json:"time"`
	Value *float64 `json:"value,omitempty"`
}

type FanHistoryPoint struct {
	Time string `json:"time"`
	RPM  int    `json:"rpm"`
	PWM  int    `json:"pwm"`
}

type HistorySeries struct {
	CPUTemp []HistoryPoint               `json:"cpu_temp"`
	GPUTemp []HistoryPoint               `json:"gpu_temp"`
	DiskAvg []HistoryPoint               `json:"disk_avg"`
	Fans    map[string][]FanHistoryPoint `json:"fans"`
}
