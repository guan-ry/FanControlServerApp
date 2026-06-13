export interface CurvePoint {
    temp: number;
    pwm: number;
}

/** GET /api/device/scan 单条结果（与后端 hwmon.ScanFans 字段一致） */
export type FanControlType = "pwm" | "thermal_binary";

export interface ScannedFan {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
    chip: string;
    device: string;
    pwm_index: number;
    control_type?: FanControlType;
    thermal_zone_path?: string;
    thermal_trip_path?: string;
    thermal_hyst_path?: string;
    thermal_policy_path?: string;
    thermal_zone_type?: string;
    thermal_policy?: string;
    thermal_hysteresis?: number;
    nominal_rpm?: number;
    cooling_device_path?: string;
    rpm_is_nominal?: boolean;
}

export interface FanConfig {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
    chip: string;
    device: string;
    pwm_index: number;
    control_type?: FanControlType;
    thermal_zone_path?: string;
    thermal_trip_path?: string;
    thermal_hyst_path?: string;
    thermal_policy_path?: string;
    thermal_zone_type?: string;
    thermal_policy?: string;
    thermal_hysteresis?: number;
    nominal_rpm?: number;
    rpm_is_nominal?: boolean;
    mode: "manual" | "curve";
    source: string;
    manual_pwm: number;
    curve: CurvePoint[];
    /** 非空则覆盖全局：最小 PWM 调整死区（0–255） */
    pwm_deadzone?: number;
    /** 非空则覆盖全局：停转滞回温差（°C） */
    stop_hysteresis?: number;
    /** 非空则覆盖全局：过热全速阈值（°C） */
    emergency_temp?: number;
    /** 主温度源无读数时：keep_last | stop | min_pwm | full_speed | follow_other */
    fallback_policy?: string;
    fallback_min_pwm?: number;
    fallback_follow_source?: string;
}

export interface GlobalConfig {
    cpu_sensor?: string;
    gpu_sensor?: string;
    pwm_deadzone: number;
    update_interval_ms: number;
    emergency_temp: number;
    stop_behavior: "keep" | "set";
    stop_pwm: number;
    stop_hysteresis: number;
    log_level: string;
    source_mode?: "simple" | "advanced";
    sensor_aliases?: Record<string, string>;
    sensor_hidden?: string[];
}

export interface SensorReading {
    id: string;
    chip: string;
    device?: string;
    key: string;
    label: string;
    temp?: number;
}

export interface ConfigPayload {
    fans: FanConfig[];
    global: GlobalConfig;
}

export interface DiskInfo {
    name: string;
    temp?: number;
    status: "active" | "sleep";
}

export interface FanRuntime {
    id: string;
    name: string;
    pwm: number;
    rpm: number;
    status: "normal" | "stopped";
    source: string;
    mode: "manual" | "curve";
    target_pwm: number;
    control_type?: FanControlType;
    thermal_zone_type?: string;
    thermal_policy?: string;
    thermal_hysteresis?: number;
    nominal_rpm?: number;
    rpm_is_nominal?: boolean;
}

export interface HistoryPoint {
    time: string;
    value?: number;
}

export interface Telemetry {
    cpu_temp?: number;
    cpu_usage: number;
    mem_usage: number;
    mem_total?: number;  // 内存总量（GB）
    gpu_temp?: number;
    cpu_sensor_label?: string;
    gpu_sensor_label?: string;
    disks: {
        avg_temp?: number;
        details: DiskInfo[];
    };
    fans: FanRuntime[];
    sensors: SensorReading[];
    timestamp: string;
    uptime?: number;  // 系统运行时间（秒）
    history: {
        cpu_temp: HistoryPoint[];
        gpu_temp: HistoryPoint[];
        disk_avg: HistoryPoint[];
    };
}
