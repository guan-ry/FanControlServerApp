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

// 主温度源不可用（如 SATA 休眠）时的风扇降级策略。
const (
	FallbackKeepLast    = "keep_last"
	FallbackStop        = "stop"
	FallbackMinPWM      = "min_pwm"
	FallbackFullSpeed   = "full_speed"
	FallbackFollowOther = "follow_other"
)

type CurvePoint struct {
	Temp float64 `json:"temp"`
	PWM  int     `json:"pwm"`
}

type FanConfig struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Chip       string       `json:"chip"`
	Device     string       `json:"device"`
	PWMIndex   int          `json:"pwm_index"`
	PWMPath    string       `json:"pwm_path"`
	RPMPath    string       `json:"rpm_path"`
	EnablePath string       `json:"enable_path"`
	Mode       FanMode      `json:"mode"`
	Source     string       `json:"source"`
	ManualPWM  int          `json:"manual_pwm"`
	Curve      []CurvePoint `json:"curve"`
	// 以下三项为可选覆盖：nil 表示使用 GlobalConfig 中的对应默认值。
	PWMDeadzone    *int     `json:"pwm_deadzone,omitempty"`
	StopHysteresis *float64 `json:"stop_hysteresis,omitempty"`
	EmergencyTemp  *float64 `json:"emergency_temp,omitempty"`
	// 主温度源无读数时的行为；空则等价 keep_last。
	FallbackPolicy       string `json:"fallback_policy,omitempty"`
	FallbackMinPWM       int    `json:"fallback_min_pwm,omitempty"`       // 策略 min_pwm 时使用，默认在规范化中保证 ≥1
	FallbackFollowSource string `json:"fallback_follow_source,omitempty"` // 策略 follow_other 时的后备温度源 ID
}

// GlobalConfig 全机共享；PWMDeadzone / StopHysteresis / EmergencyTemp 可被各 FanConfig 同名字段覆盖。
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
	CPUSensor        string            `json:"cpu_sensor,omitempty"`     // 自定义 CPU 温度传感器 ID
	GPUSensor        string            `json:"gpu_sensor,omitempty"`     // 自定义 GPU 温度传感器 ID
	HistoryRange     string            `json:"history_range,omitempty"`  // 温度历史图时间范围：1h/6h/24h/7d/custom
	HistorySensors   []string          `json:"history_sensors"`          // 历史曲线温度页选中的传感器；null=未配置，[]=全不选
	HistoryFans      []string          `json:"history_fans"`             // 历史曲线风扇页选中的风扇 ID；null=未配置，[]=全不选
	HistoryVolts     []string          `json:"history_volts"`            // 历史曲线电压页选中的电压传感器；null=未配置，[]=全不选
	HistoryFrom      string            `json:"history_from,omitempty"`   // 自定义范围起始（datetime-local）
	HistoryTo        string            `json:"history_to,omitempty"`     // 自定义范围结束（datetime-local）
}

const CurrentConfigVersion = 3

type Config struct {
	Version int          `json:"version"`
	Fans    []FanConfig  `json:"fans"`
	Global  GlobalConfig `json:"global"`
}

type DiskInfo struct {
	Name   string     `json:"name"`
	Serial string     `json:"serial,omitempty"`
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
	CPUTemp        *float64        `json:"cpu_temp,omitempty"`
	CPUSensorLabel string          `json:"cpu_sensor_label,omitempty"`
	CPUUsage       float64         `json:"cpu_usage"`
	MemUsage       float64         `json:"mem_usage"`
	MemTotal       *float64        `json:"mem_total,omitempty"`
	GPUTemp        *float64        `json:"gpu_temp,omitempty"`
	GPUSensorLabel string          `json:"gpu_sensor_label,omitempty"`
	Uptime         int64           `json:"uptime"`
	Disks          DiskPayload     `json:"disks"`
	Fans           []FanRuntime    `json:"fans"`
	Sensors        []SensorReading `json:"sensors"`
	Timestamp      time.Time       `json:"timestamp"`
}

const (
	SensorKindTemp = "temp"
	SensorKindVolt = "volt"
)

type SensorReading struct {
	ID     string   `json:"id"`               // chip/device/key，全局稳定 ID
	Chip   string   `json:"chip"`             // 来自 hwmonX/name
	Device string   `json:"device,omitempty"` // 来自 hwmonX/device 软链终端：nvme0、sda、PCI 地址等
	Key    string   `json:"key"`              // 例：temp1 / in1
	Label  string   `json:"label"`            // 来自 *_label，可能为空
	Kind   string   `json:"kind"`             // temp | volt
	Temp   *float64 `json:"temp,omitempty"`   // °C（kind=temp）
	Volt   *float64 `json:"volt,omitempty"`   // V（kind=volt）
}

type HistoryPoint struct {
	Time  time.Time `json:"time"`
	Value *float64  `json:"value,omitempty"`
}

type HistorySeries struct {
	CPUTemp []HistoryPoint            `json:"cpu_temp"`
	GPUTemp []HistoryPoint            `json:"gpu_temp"`
	DiskAvg []HistoryPoint            `json:"disk_avg"`
	Sensors map[string][]HistoryPoint `json:"sensors,omitempty"`
	FansPWM map[string][]HistoryPoint `json:"fans_pwm,omitempty"`
	FansRPM map[string][]HistoryPoint `json:"fans_rpm,omitempty"`
}
