import axios from "axios";
import type {ConfigPayload, CurvePoint, GlobalConfig, ScannedFan, Telemetry} from "./types";

const TOKEN_KEY = "fancontrol_api_token";

export function getStoredToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken() {
    localStorage.removeItem(TOKEN_KEY);
}

export let authRequired = true;
export let gatewayMode = false;
export let currentUser: { uid: string; username: string; is_admin: boolean } | null = null;

function apiBase(): string {
    const base = import.meta.env.BASE_URL;
    return base.endsWith("/") ? base.slice(0, -1) : base;
}

export async function initAuthMode(): Promise<void> {
    try {
        const {data} = await axios.get<{
            gateway_mode?: boolean;
            logged_in?: boolean;
            auth_required?: boolean;
            setup_pending?: boolean;
            user?: { uid: string; username: string; is_admin: boolean };
        }>(`${apiBase()}/api/auth/status`);
        if (data.gateway_mode) {
            gatewayMode = true;
            authRequired = false;
            currentUser = data.logged_in && data.user ? data.user : null;
            return;
        }
        authRequired = data.auth_required ?? true;
    } catch {
        authRequired = true;
    }
}

const client = axios.create({
    baseURL: `${apiBase()}/api`,
    withCredentials: true  // 网关模式下需要携带 Cookie/Session
});

client.interceptors.request.use(config => {
    if (!gatewayMode) {
        const token = getStoredToken();
        if (authRequired && token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    // 网关模式下不添加任何 Header，完全依赖飞牛网关透传
    return config;
});

client.interceptors.response.use(
    res => res,
    err => {
        const status = err.response?.status;
        const backendMsg = err.response?.data?.error;
        
        if (gatewayMode && status === 403) {
            err.message = backendMsg || "需要管理员权限";
        } else if (status === 401 && authRequired) {
            err.message = backendMsg || "认证失效，请重新登录";
            clearStoredToken();
            window.dispatchEvent(new CustomEvent("auth-required"));
        } else if (backendMsg) {
            err.message = backendMsg;
        }
        
        return Promise.reject(err);
    }
);

export async function fetchAuthSetup(): Promise<{ token: string } | null> {
    try {
        const {data} = await axios.get<{ token: string }>("/api/auth/setup");
        return data;
    } catch {
        return null;
    }
}

export async function confirmAuthSetup(token: string): Promise<boolean> {
    try {
        await axios.post("/api/auth/setup", {token});
        return true;
    } catch {
        return false;
    }
}

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

export async function setFanSource(id: string, source: string) {
    await client.post("/fan/source", {id, source});
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
