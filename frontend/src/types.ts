export interface CurvePoint {
    temp: number;
    pwm: number;
}

/** GET /api/device/scan 单条结果（与后端 hwmon.ScanFans 字段一致） */
export interface ScannedFan {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
}

export interface FanConfig {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
    mode: "manual" | "curve";
    source: string;
    manual_pwm: number;
    curve: CurvePoint[];
}

export interface GlobalConfig {
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
}

export interface HistoryPoint {
    time: string;
    value?: number;
}

export interface FanHistoryPoint {
    time: string;
    rpm: number;
    pwm: number;
}

export interface Telemetry {
    cpu_temp?: number;
    cpu_usage: number;
    mem_usage: number;
    mem_total?: number;  // 内存总量（GB）
    gpu_temp?: number;
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
        fans: Record<string, FanHistoryPoint[]>;
    };
}
