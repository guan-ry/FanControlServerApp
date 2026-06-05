import axios from "axios";
import type {ConfigPayload, CurvePoint, GlobalConfig, ScannedFan, Telemetry} from "./types";

export let gatewayMode = false;

function apiBase(): string {
    const base = import.meta.env.BASE_URL;
    return base.endsWith("/") ? base.slice(0, -1) : base;
}

export async function initAuthMode(): Promise<void> {
    try {
        const {data} = await axios.get<{ gateway_mode?: boolean }>(`${apiBase()}/api/auth/status`);
        gatewayMode = !!data.gateway_mode;
    } catch {
        gatewayMode = false;
    }
}

const client = axios.create({
    baseURL: `${apiBase()}/api`,
    withCredentials: true  // 网关模式下需要携带 Cookie/Session
});

client.interceptors.response.use(
    res => res,
    err => {
        const status = err.response?.status;
        const backendMsg = err.response?.data?.error;
        if (status === 403) {
            err.message = backendMsg || "需要管理员权限";
        } else if (backendMsg) {
            err.message = backendMsg;
        }
        return Promise.reject(err);
    }
);

export async function fetchScanFans() {
    const {data} = await client.get<{ fans: ScannedFan[] | null }>("/device/scan");
    return data.fans ?? [];
}

export async function fetchInfo() {
    const {data} = await client.get<Telemetry>("/device/info");
    return data;
}

export async function fetchConfig() {
    const {data} = await client.get<ConfigPayload>("/fan/config");
    return data;
}

export async function saveConfig(payload: ConfigPayload) {
    await client.post("/fan/config", payload);
}

export async function setFanMode(id: string, mode: "manual" | "curve") {
    await client.post("/fan/mode", {id, mode});
}

export async function setFanManualPWM(id: string, pwm: number) {
    await client.post("/fan/set", {id, pwm});
}

export async function setFanCurve(id: string, curve: CurvePoint[]) {
    await client.post("/fan/curve", {id, curve});
}

export async function removeFan(id: string) {
    await client.post("/fan/remove", {id});
}

export async function setGlobalConfig(payload: GlobalConfig) {
    await client.post("/global/config", payload);
}
