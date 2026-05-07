import "iconify-icon";
import "./style.css";
import * as echarts from "echarts";
import {
    authRequired,
    confirmAuthSetup,
    fetchAuthSetup,
    fetchConfig,
    fetchInfo,
    fetchScanFans,
    getStoredToken,
    initAuthMode,
    removeFan,
    saveConfig,
    setFanCurve,
    setFanManualPWM,
    setFanMode,
    setGlobalConfig,
    setStoredToken,
} from "./api";
import type {ConfigPayload, CurvePoint, FanConfig, GlobalConfig, ScannedFan, SensorReading, Telemetry} from "./types";

const DEFAULT_CURVE: CurvePoint[] = [
    {temp: 30, pwm: 80},
    {temp: 55, pwm: 140},
    {temp: 75, pwm: 255}
];

const emptyGlobal = (): GlobalConfig => ({
    pwm_deadzone: 5,
    update_interval_ms: 2000,
    emergency_temp: 80,
    stop_behavior: "set",
    stop_pwm: 200,
    stop_hysteresis: 2,
    log_level: "info"
});

let config: ConfigPayload = {fans: [], global: emptyGlobal()};
let telemetry: Telemetry | undefined;

let fanCurveChart: echarts.ECharts | null = null;
let fanCurveChartBound = false;
let curveData: number[][] = [];
let selectedCurveFanId = "";
let historyChart: echarts.ECharts | null = null;
let lastChartUpdate = 0;

// 圆环周长 (2 * PI * 15.5 ≈ 97.4)
const RING_CIRCUMFERENCE = 97.4;

function formatTime(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${min}:${s}`;
}

function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}年${m}月${day}日`;
}

function updateSystemTime() {
    const now = new Date();
    $("system-date").textContent = formatDate(now);
    $("system-time").textContent = formatTime(now);
}

function formatUptime(seconds?: number): string {
    if (seconds === undefined || seconds <= 0) return "--";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

    return parts.join(" ");
}

function updateRingProgress(ringId: string, percentage: number) {
    const ring = document.getElementById(ringId) as SVGCircleElement | null;
    if (ring) {
        const offset = RING_CIRCUMFERENCE - (percentage / 100) * RING_CIRCUMFERENCE;
        ring.style.strokeDashoffset = String(offset);
    }
}

function updateSubtitleDate() {
    updateSystemTime();
    // 每秒更新运行时间（基于后端最后一次推送的时间计算）
    updateUptimeFromServer();
}

// 存储服务器最后一次推送时的 uptime 和本地时间
let lastUptime = 0;
let lastUptimeReceived = 0;

function updateUptimeFromServer() {
    if (lastUptime > 0) {
        // 计算从收到服务器数据到现在过了多少秒
        const elapsed = Math.floor((Date.now() - lastUptimeReceived) / 1000);
        const currentUptime = lastUptime + elapsed;
        $("uptime-text").textContent = formatUptime(currentUptime);
    }
}

// 在收到后端遥测数据时更新
function onTelemetryReceived(t: Telemetry) {
    lastUptime = t.uptime ?? 0;
    lastUptimeReceived = Date.now();
}

let editFanIdx: number | null = null;
let lastScanResults: ScannedFan[] = [];
type SourceMode = "simple" | "advanced";

// 风扇编辑对话框打开时的 source_mode 快照；用于"取消未保存"时回滚。
let originalSourceMode: SourceMode | null = null;

function $(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el;
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

type ToastKind = "success" | "error" | "info";

const TOAST_ICON: Record<ToastKind, string> = {
    success: "mdi:check-circle",
    error: "mdi:alert-circle",
    info: "mdi:information"
};

const TOAST_CLASS: Record<ToastKind, string> = {
    success: "border-emerald-500/35 bg-emerald-950/85 text-emerald-50",
    error: "border-red-500/40 bg-red-950/85 text-red-50",
    info: "border-slate-500/40 bg-slate-900/92 text-slate-100"
};

/** 非阻塞提示（替代 window.alert） */
function toast(message: string, kind: ToastKind = "info") {
    const root = document.getElementById("toast-root");
    if (!root) {
        console.error("[toast]", message);
        return;
    }
    const el = document.createElement("div");
    el.setAttribute("role", "status");
    el.className = `toast-item pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur-sm ${TOAST_CLASS[kind]}`;
    const icon = document.createElement("iconify-icon");
    icon.className = "text-xl flex-shrink-0 mt-0.5";
    icon.setAttribute("icon", TOAST_ICON[kind]);
    const p = document.createElement("p");
    p.className = "flex-1 min-w-0 break-words leading-snug";
    p.textContent = message;
    el.append(icon, p);
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast-item-visible"));
    const ms = kind === "error" ? 6000 : 4200;
    window.setTimeout(() => {
        el.classList.remove("toast-item-visible");
        el.classList.add("toast-item-exit");
        window.setTimeout(() => el.remove(), 220);
    }, ms);
}

/** 确认框（替代 window.confirm），依赖 #confirm-action-dialog 内 form method=dialog */
function openConfirm(message: string): Promise<boolean> {
    const dlg = $("confirm-action-dialog") as HTMLDialogElement;
    $("confirm-action-message").textContent = message;
    return new Promise(resolve => {
        const onClose = () => {
            resolve(dlg.returnValue === "ok");
        };
        dlg.addEventListener("close", onClose, {once: true});
        dlg.showModal();
    });
}

function formatTemp(v?: number): string {
    return v === undefined ? "--" : `${v.toFixed(1)}`;
}

function curveToPairs(curve: CurvePoint[]): number[][] {
    return curve.map(p => [p.temp, p.pwm]);
}

function pairsToCurve(pairs: number[][]): CurvePoint[] {
    return pairs
        .map(([temp, pwm]) => ({
            temp: Math.round(Math.max(0, Math.min(100, temp)) * 10) / 10,
            pwm: Math.max(0, Math.min(255, Math.round(pwm)))
        }))
        .sort((a, b) => a.temp - b.temp);
}

function applyTelemetry(t: Telemetry) {
    telemetry = t;

    // CPU
    $("cpu-temp-text").textContent = formatTemp(t.cpu_temp);
    updateRingProgress("cpu-ring", t.cpu_usage);
    $("cpu-ring-text").textContent = `${t.cpu_usage.toFixed(0)}%`;

    // GPU
    $("gpu-temp-text").textContent = formatTemp(t.gpu_temp);
    updateRingProgress("gpu-ring", 0); // GPU使用率暂未提供
    $("gpu-ring-text").textContent = "--%";

    // 内存
    updateRingProgress("mem-ring", t.mem_usage);
    $("mem-ring-text").textContent = `${t.mem_usage.toFixed(0)}%`;
    // 计算可用内存
    if (t.mem_total && t.mem_total > 0) {
        const available = (t.mem_total * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = available;
    } else {
        // 估算可用内存（假设总内存为使用量的1.5倍）
        const estimated = (t.mem_usage * 0.01 * 16 * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = estimated;
    }

    // 硬盘
    $("disk-avg-text").textContent = formatTemp(t.disks.avg_temp);

    // 运行时间（收到后端数据时更新）
    onTelemetryReceived(t);


    syncFanCardsFromTelemetryOrRender();
    renderStorageList();
    updateSensorMgrTemps();
    const now = Date.now();
    if (now - lastChartUpdate >= 2000) {
        lastChartUpdate = now;
        updateHistoryChart();
    }
}

function renderStorageList() {
    const list = $("storage-list");
    const d = telemetry?.disks.details ?? [];

    // 如果列表为空且当前也为空，不重绘
    if (d.length === 0) {
        if (list.children.length === 0) return;
        list.innerHTML = "";
        return;
    }

    // 如果数量变化，完全重绘
    if (list.children.length !== d.length) {
        list.innerHTML = d
            .map(
                disk => `
      <div class="flex justify-between items-center text-xs" data-disk-name="${esc(disk.name)}">
        <span class="text-slate-400 flex items-center gap-2"><iconify-icon icon="mdi:harddisk"></iconify-icon> ${esc(disk.name)}</span>
        <span class="disk-temp font-mono">${
                    disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
                }</span>
      </div>`
            )
            .join("");
        return;
    }

    // 数量不变，只更新温度值和状态，避免闪烁
    d.forEach((disk, idx) => {
        const item = list.children[idx] as HTMLElement;
        if (item.dataset.diskName !== disk.name) {
            // 名称变化，完全重绘
            list.innerHTML = d
                .map(
                    disk => `
        <div class="flex justify-between items-center text-xs" data-disk-name="${esc(disk.name)}">
          <span class="text-slate-400 flex items-center gap-2"><iconify-icon icon="mdi:harddisk"></iconify-icon> ${esc(disk.name)}</span>
          <span class="disk-temp font-mono">${
                        disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
                    }</span>
        </div>`
                )
                .join("");
            return;
        }
        // 更新温度和状态
        const tempSpan = item.querySelector(".disk-temp");
        if (tempSpan) {
            const isSleep = disk.status === "sleep";
            const iconEl = item.querySelector("iconify-icon") as HTMLElement | null;
            if (iconEl) {
                iconEl.setAttribute("icon", isSleep ? "mdi:harddisk" : "mdi:harddisk");
                iconEl.className = isSleep ? "text-slate-500" : "text-slate-400";
            }
            tempSpan.innerHTML = isSleep
                ? '<span class="text-slate-500 uppercase">休眠</span>'
                : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`;
        }
    });
}

function runtimeFor(id: string) {
    return telemetry?.fans.find(f => f.id === id);
}

/** 与 WebSocket 推送频率解耦：仅在结构变化时 innerHTML，否则就地更新，避免整卡重绘与动画重启导致闪烁 */
function syncFanCardsFromTelemetryOrRender() {
    const root = $("fan-root");
    const fans = config.fans;
    const cards = root.querySelectorAll(":scope > [data-fan-id]");

    if (fans.length === 0) {
        if (root.innerHTML !== "") root.innerHTML = "";
        return;
    }

    if (cards.length !== fans.length) {
        renderFanCards();
        return;
    }
    for (let i = 0; i < fans.length; i++) {
        if ((cards[i] as HTMLElement).dataset.fanId !== fans[i].id) {
            renderFanCards();
            return;
        }
    }

    fans.forEach((fan, idx) => {
        const card = cards[idx] as HTMLElement;
        const rt = runtimeFor(fan.id);
        const rpm = rt?.rpm ?? 0;
        const stopped = rpm <= 0 || rt?.status === "stopped";
        const manual = fan.mode === "manual";
        const pwmVal = fan.manual_pwm;

        // 更新风扇名称
        const fanName = card.querySelector("[data-fan-name]") as HTMLElement | null;
        if (fanName) fanName.textContent = fan.name;

        // 更新 PWM 路径
        const pwmPath = card.querySelector("[data-fan-pwm-path]") as HTMLElement | null;
        if (pwmPath) {
            pwmPath.textContent = fan.pwm_path || "未配置 PWM";
            pwmPath.setAttribute("title", fan.pwm_path || "");
        }

        const iconBg = card.querySelector("[data-fan-icon-bg]") as HTMLElement | null;
        const iconEl = card.querySelector("[data-fan-icon]") as HTMLElement | null;
        if (iconBg) {
            iconBg.className = `w-9 h-9 rounded-full ${stopped ? "bg-slate-700" : "bg-sky-500/10"} flex items-center justify-center flex-shrink-0`;
        }
        if (iconEl) {
            iconEl.setAttribute("icon", stopped ? "mdi:fan-off" : "mdi:fan");
            iconEl.className = stopped ? "text-slate-500" : "text-sky-400 animate-spin-slow";
        }

        const rpmRow = card.querySelector("[data-fan-rpm-row]") as HTMLElement | null;
        const rpmNum = card.querySelector("[data-fan-rpm]") as HTMLElement | null;
        const rpmUnit = card.querySelector("[data-fan-rpm-unit]") as HTMLElement | null;
        if (rpmNum) rpmNum.textContent = String(rpm);
        if (rpmUnit) rpmUnit.textContent = stopped ? "STOPPED" : "RPM";
        if (rpmRow) {
            rpmRow.className = `text-xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}`;
        }

        const curveBtn = card.querySelector('[data-mode="curve"]') as HTMLElement | null;
        const manualBtn = card.querySelector('[data-mode="manual"]') as HTMLElement | null;
        if (curveBtn) {
            curveBtn.className = `px-2.5 py-0.5 text-xs rounded-md ${!manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        }
        if (manualBtn) {
            manualBtn.className = `px-2.5 py-0.5 text-xs rounded-md ${manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        }

        const manualUi = card.querySelector("[data-manual-ui]") as HTMLElement | null;
        const autoUi = card.querySelector("[data-auto-ui]") as HTMLElement | null;
        if (manualUi) manualUi.classList.toggle("hidden", !manual);
        if (autoUi) autoUi.classList.toggle("hidden", manual);

        // 更新温度源显示（仅显示源名，温度只在下拉中展示）
        const fanSource = card.querySelector("[data-fan-source]") as HTMLElement | null;
        if (fanSource) {
            fanSource.textContent = getSourceLabel(fan.source);
            fanSource.setAttribute("data-source", fan.source);
        }

        const pwmDisplay = card.querySelector("[data-fan-pwm-display]") as HTMLElement | null;
        const range = card.querySelector('input[data-field="pwm-range"]') as HTMLInputElement | null;
        if (pwmDisplay) pwmDisplay.textContent = `${pwmVal} / 255`;
        if (range && document.activeElement !== range) {
            range.value = String(pwmVal);
        }
    });
}

function renderFanCards() {
    const root = $("fan-root");
    const fans = config.fans;
    root.innerHTML = fans
        .map((fan, idx) => {
            const rt = runtimeFor(fan.id);
            const rpm = rt?.rpm ?? 0;
            const stopped = rpm <= 0 || rt?.status === "stopped";
            const manual = fan.mode === "manual";
            const pwmVal = fan.manual_pwm;
            return `
<div class="bg-slate-900/40 rounded-2xl p-4 border border-slate-700/50" data-fan-idx="${idx}" data-fan-id="${esc(fan.id)}">
  <div class="flex justify-between items-start mb-3">
    <div class="flex items-center gap-2.5 min-w-0">
      <div data-fan-icon-bg class="w-9 h-9 rounded-full ${stopped ? "bg-slate-700" : "bg-sky-500/10"} flex items-center justify-center flex-shrink-0">
        <iconify-icon data-fan-icon class="${stopped ? "text-slate-500" : "text-sky-400 animate-spin-slow"}" icon="${stopped ? "mdi:fan-off" : "mdi:fan"}"></iconify-icon>
      </div>
      <div class="min-w-0">
        <h4 data-fan-name class="font-bold text-white text-sm truncate">${esc(fan.name)}</h4>
        <p data-fan-pwm-path class="text-[10px] text-slate-500 font-mono truncate leading-tight" title="${esc(fan.pwm_path)}">${esc(fan.pwm_path || "未配置 PWM")}</p>
      </div>
    </div>
    <div class="flex items-center gap-0.5 flex-shrink-0">
      <button type="button" class="p-1.5 hover:bg-red-900/40 rounded-md text-slate-400 hover:text-red-300 flex-shrink-0" data-act="fan-delete" title="从配置中删除此风扇">
        <iconify-icon class="text-lg" icon="mdi:delete-outline"></iconify-icon>
      </button>
      <button type="button" class="p-1.5 hover:bg-slate-700 rounded-md text-slate-400 flex-shrink-0" data-act="fan-settings" title="风扇设置">
        <iconify-icon class="text-lg" icon="mdi:cog-outline"></iconify-icon>
      </button>
    </div>
  </div>
  <div class="flex items-center justify-between mb-3">
    <div data-fan-rpm-row class="text-xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}">
      <span data-fan-rpm>${rpm}</span> <span data-fan-rpm-unit class="text-[10px] text-slate-500 font-normal not-italic">${stopped ? "STOPPED" : "RPM"}</span>
    </div>
    <div class="flex items-center p-0.5 bg-slate-800 rounded-lg">
      <button type="button" data-mode="curve" class="px-2.5 py-0.5 text-xs rounded-md ${!manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}">自动</button>
      <button type="button" data-mode="manual" class="px-2.5 py-0.5 text-xs rounded-md ${manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}">手动</button>
    </div>
  </div>
  <div class="${manual ? "" : "hidden"}" data-manual-ui>
    <div class="flex justify-between text-[10px] text-slate-500 mb-1.5 uppercase tracking-tighter">
      <span>PWM 输出</span>
      <span data-fan-pwm-display class="text-sky-400 font-bold">${pwmVal} / 255</span>
    </div>
    <input data-field="pwm-range" class="w-full" type="range" min="0" max="255" value="${pwmVal}" />
  </div>
  <div class="${manual ? "hidden" : ""} flex items-center gap-2 text-xs text-slate-400 bg-slate-800/40 py-1.5 px-2 rounded-lg mt-1" data-auto-ui>
    <iconify-icon class="text-sky-400 flex-shrink-0" icon="mdi:chart-bell-curve"></iconify-icon>
    <span class="leading-tight">温度源: </span>
    <span data-fan-source class="leading-tight text-sky-300" data-source="${fan.source}">${getSourceLabel(fan.source)}</span>
    <span class="leading-tight text-slate-500">· 齿轮编辑曲线</span>
  </div>
</div>`;
        })
        .join("");
}

// resolveSourceTemp 解析一个 source 字符串对应的当前温度（°C）。
// 与后端 controller.resolveSourceTemp 行为对齐，用于在 UI 上展示「源 + 当前温度」。
function resolveSourceTemp(source: string): number | undefined {
    const t = telemetry;
    if (!t) return undefined;

    if (source === "cpu") return t.cpu_temp;
    if (source === "gpu") return t.gpu_temp;
    if (source === "disk_avg") return t.disks?.avg_temp;
    if (source === "disk_max") {
        let best: number | undefined;
        for (const d of t.disks?.details ?? []) {
            if (d.temp != null && (best === undefined || d.temp > best)) best = d.temp;
        }
        return best;
    }
    if (source === "max") {
        const all: number[] = [];
        if (t.cpu_temp != null) all.push(t.cpu_temp);
        if (t.gpu_temp != null) all.push(t.gpu_temp);
        if (t.disks?.avg_temp != null) all.push(t.disks.avg_temp);
        for (const d of t.disks?.details ?? []) {
            if (d.temp != null) all.push(d.temp);
        }
        for (const s of t.sensors ?? []) {
            if (s.temp != null) all.push(s.temp);
        }
        return all.length ? Math.max(...all) : undefined;
    }
    if (source.startsWith("disk:")) {
        const name = source.slice(5);
        return (t.disks?.details ?? []).find(d => d.name === name)?.temp;
    }
    if (source.startsWith("sensor:")) {
        const id = source.slice(7);
        return (t.sensors ?? []).find(s => s.id === id)?.temp;
    }
    if (source.startsWith("combo_avg:")) {
        const vals = source.slice("combo_avg:".length).split(",")
            .map(k => resolveSourceTemp(k.trim()))
            .filter((v): v is number => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
    }
    if (source.startsWith("combo_max:")) {
        const vals = source.slice("combo_max:".length).split(",")
            .map(k => resolveSourceTemp(k.trim()))
            .filter((v): v is number => v != null);
        return vals.length ? Math.max(...vals) : undefined;
    }
    return undefined;
}

// 单个温度文本的辅助函数：有温度返回 "47.3°C"，休眠返回 "休眠"，其余返回 "—"
function fmtTemp(t: number | undefined, sleep?: boolean): string {
    if (sleep) return "休眠";
    return t != null ? `${t.toFixed(1)}°C` : "—";
}

interface SourceItem {
    v: string;
    name: string;
    temp?: number;
    sleep?: boolean;
}

interface SourceGroup {
    label: string;
    items: SourceItem[];
}

// 收集当前模式下要展示的源分组。简洁模式 1 组；极客模式按 chip+device 分组。
function collectSourceGroups(mode: "simple" | "advanced"): SourceGroup[] {
    const disks = telemetry?.disks.details ?? [];
    const allSensors = telemetry?.sensors ?? [];
    const hidden = new Set(config.global.sensor_hidden ?? []);
    const aliases = config.global.sensor_aliases ?? {};
    const sensors = allSensors.filter(s => !hidden.has(s.id));

    if (mode === "simple") {
        const items: SourceItem[] = [
            {v: "cpu", name: "CPU"},
            {v: "gpu", name: "GPU"},
        ];
        disks.forEach(d => items.push({
            v: `disk:${d.name}`, name: `硬盘 ${d.name}`,
            sleep: d.status === "sleep",
        }));
        items.push({v: "disk_avg", name: "硬盘平均"});
        items.push({v: "disk_max", name: "硬盘最大"});
        items.forEach(it => { if (!it.sleep) it.temp = resolveSourceTemp(it.v); });
        return [{label: "常用温度源", items}];
    }

    const groups = new Map<string, SourceItem[]>();
    for (const s of sensors) {
        const key = s.device ? `${s.chip} · ${s.device}` : s.chip;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({
            v: `sensor:${s.id}`,
            name: aliases[s.id] || s.label || s.key,
            temp: s.temp,
        });
    }
    return [...groups.entries()].map(([label, items]) => ({label, items}));
}

// renderSourceOptions 生成自定义下拉浮层的 innerHTML。
// 每行用 flex 实现真正的左右两端对齐：源名靠左、温度靠右。
function renderSourceOptions(current: string, mode: "simple" | "advanced"): string {
    const groups = collectSourceGroups(mode);
    let html = "";
    let currentInList = false;

    for (const g of groups) {
        html += `<div class="px-3 py-1 text-[10px] uppercase tracking-wider text-sky-400 bg-slate-900 sticky top-0 z-10 border-b border-slate-700/50">${esc(g.label)}</div>`;
        for (const it of g.items) {
            if (it.v === current) currentInList = true;
            const active = it.v === current;
            const nameCls = active ? "text-sky-300 font-medium" : "text-slate-200";
            const tempCls = active ? "text-sky-400" : "text-slate-400";
            const checkIcon = active
                ? `<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>`
                : "";
            const tempText = fmtTemp(it.temp, it.sleep);
            const sleepCls = it.sleep ? "text-slate-500 italic" : tempCls;
            html += `
<button type="button" data-source-value="${esc(it.v)}"
        class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-700/70 ${active ? "bg-slate-700/40" : ""}">
    <span class="${nameCls} truncate">${esc(it.name)}</span>
    <span class="flex items-center gap-1 flex-shrink-0">
        <span class="${sleepCls} font-mono tabular-nums text-xs">${esc(tempText)}</span>
        ${checkIcon}
    </span>
</button>`;
        }
    }

    // combo source 也算"在列表里"——它不是某个具体 option，但在高级模式的组合区域能回显。
    const isCombo = current.startsWith("combo_avg:") || current.startsWith("combo_max:");
    if (isCombo) currentInList = true;

    // 当前选中的源不在本模式的列表里（跨模式 / 硬件变化 / 被隐藏），加一条提示行。
    if (current && !currentInList) {
        const tip = `（当前选中：${esc(getSourceLabel(current))}）`;
        html = `<div class="px-3 py-2 text-xs text-amber-400 italic bg-amber-500/5 border-b border-amber-500/30">${tip}</div>` + html;
    }

    // 高级模式：在 sensor 列表下方追加组合温度源区域
    if (mode === "advanced") {
        html += renderComboSection(current);
    }

    return html;
}

// 渲染高级模式底部的"组合温度源"区域（内嵌在同一浮层中）。
function renderComboSection(currentSource: string): string {
    const items = collectAllSourceItems();
    const combo = parseComboSource(currentSource);
    const selected = new Set<string>(combo?.keys ?? []);
    const strategy = combo?.strategy ?? "avg";
    const isComboActive = combo !== null;

    const computedTemp = isComboActive ? resolveSourceTemp(currentSource) : undefined;
    const countSelected = selected.size;

    let html = `
<div class="border-t-2 border-sky-500/30 mt-1">
    <div class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-sky-400 bg-slate-900 sticky top-0 z-10 border-b border-slate-700/50 flex items-center justify-between">
        <span>组合温度源</span>
        <div class="flex items-center gap-3 normal-case tracking-normal">
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="combo-strategy" value="avg" ${strategy === "avg" ? "checked" : ""}
                       class="accent-sky-500 w-3 h-3"/>
                <span class="text-[11px] text-slate-300">平均</span>
            </label>
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="combo-strategy" value="max" ${strategy === "max" ? "checked" : ""}
                       class="accent-sky-500 w-3 h-3"/>
                <span class="text-[11px] text-slate-300">最大</span>
            </label>
        </div>
    </div>`;

    for (const it of items) {
        const checked = selected.has(it.v);
        html += `
<label data-combo-key="${esc(it.v)}"
       class="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-sm hover:bg-slate-700/70 cursor-pointer ${checked ? "bg-slate-700/40" : ""}">
    <span class="flex items-center gap-2 truncate">
        <input type="checkbox" data-combo-cb value="${esc(it.v)}" ${checked ? "checked" : ""}
               class="accent-sky-500 flex-shrink-0 w-3.5 h-3.5"/>
        <span class="${checked ? "text-sky-300" : "text-slate-200"} truncate text-xs">${esc(it.name)}</span>
    </span>
    <span class="${it.sleep ? "text-slate-500 italic" : "text-slate-400"} font-mono tabular-nums text-xs flex-shrink-0">${esc(fmtTemp(it.temp, it.sleep))}</span>
</label>`;
    }

    html += `
<div class="sticky bottom-0 bg-slate-900 border-t border-slate-700/50 px-3 py-2 flex items-center justify-between gap-3">
    <div class="text-xs text-slate-400">
        已选 <span id="combo-count" class="text-sky-400 font-bold">${countSelected}</span> 个
        <span class="mx-1">·</span>
        计算值: <span id="combo-preview" class="text-sky-400 font-mono">${esc(fmtTemp(computedTemp))}</span>
    </div>
    <button type="button" id="combo-confirm"
            class="px-4 py-1.5 rounded-lg text-xs font-medium ${countSelected >= 2 ? "bg-sky-600 text-white hover:bg-sky-500" : "bg-slate-700 text-slate-500 cursor-not-allowed"}"
            ${countSelected < 2 ? "disabled" : ""}>
        确定组合
    </button>
</div>
</div>`;

    return html;
}

// 检查 source 是否涉及 SATA 盘（可能休眠）。
function hasSataDisk(source: string): boolean {
    if (source.startsWith("disk:") && !source.slice(5).startsWith("nvme")) return true;
    if (source.startsWith("combo_avg:") || source.startsWith("combo_max:")) {
        const prefix = source.startsWith("combo_avg:") ? "combo_avg:" : "combo_max:";
        return source.slice(prefix.length).split(",").some(k => hasSataDisk(k.trim()));
    }
    return false;
}

// 写入隐藏 input.value 并刷新触发按钮的显示文本（源名 + 当前温度）。
function setSourceValue(value: string) {
    const input = document.getElementById("fe-source") as HTMLInputElement | null;
    if (input) input.value = value;

    const display = document.getElementById("fe-source-display");
    if (display) {
        const t = resolveSourceTemp(value);
        const tempPart = t != null ? ` · ${t.toFixed(1)}°C` : "";
        display.textContent = `${getSourceLabel(value)}${tempPart}`;
    }

    const warn = document.getElementById("fe-source-warn");
    if (warn) warn.classList.toggle("hidden", !hasSataDisk(value));
}

function getSourceLabel(source: string): string {
    const disks = telemetry?.disks.details ?? [];
    const sensors = telemetry?.sensors ?? [];
    const aliases = config.global.sensor_aliases ?? {};

    if (source === "cpu") return "CPU";
    if (source === "gpu") return "GPU";
    if (source === "disk_avg") return "硬盘平均";
    if (source === "disk_max") return "硬盘最大";
    if (source === "max") return "全部最大";
    if (source.startsWith("disk:")) {
        const name = source.slice(5);
        const disk = disks.find(d => d.name === name);
        return disk ? `硬盘 ${name}` : name;
    }
    if (source.startsWith("sensor:")) {
        const id = source.slice(7);
        const s = sensors.find(x => x.id === id);
        if (!s) return aliases[id] || id;
        const name = aliases[s.id] || s.label || s.key;
        return s.device ? `${s.chip}·${s.device}·${name}` : `${s.chip}·${name}`;
    }
    if (source.startsWith("combo_avg:")) {
        const keys = source.slice("combo_avg:".length).split(",").map(k => k.trim());
        return `平均(${keys.map(k => getSourceLabel(k)).join(", ")})`;
    }
    if (source.startsWith("combo_max:")) {
        const keys = source.slice("combo_max:".length).split(",").map(k => k.trim());
        return `最大(${keys.map(k => getSourceLabel(k)).join(", ")})`;
    }
    return source;
}

// 更新风扇编辑对话框上的"简洁/极客"切换按钮高亮状态，并刷新下拉浮层。
function resolveSourceMode(): SourceMode {
    return config.global.source_mode === "advanced" ? "advanced" : "simple";
}

// 组合模式：收集所有可选源（简洁 + 高级合并去重）。
function collectAllSourceItems(): SourceItem[] {
    const simpleGroups = collectSourceGroups("simple");
    const advancedGroups = collectSourceGroups("advanced");
    const seen = new Set<string>();
    const out: SourceItem[] = [];
    for (const g of [...simpleGroups, ...advancedGroups]) {
        for (const it of g.items) {
            if (!seen.has(it.v)) {
                seen.add(it.v);
                out.push(it);
            }
        }
    }
    return out;
}

// 解析 combo source 字符串，返回 {strategy, keys}。
function parseComboSource(source: string): { strategy: "avg" | "max"; keys: string[] } | null {
    if (source.startsWith("combo_avg:")) {
        return { strategy: "avg", keys: source.slice("combo_avg:".length).split(",").map(k => k.trim()).filter(Boolean) };
    }
    if (source.startsWith("combo_max:")) {
        return { strategy: "max", keys: source.slice("combo_max:".length).split(",").map(k => k.trim()).filter(Boolean) };
    }
    return null;
}



// 从面板当前勾选状态生成 combo source 字符串。
function buildComboSourceFromPanel(): string {
    const menu = document.getElementById("fe-source-menu");
    if (!menu) return "";
    const boxes = menu.querySelectorAll<HTMLInputElement>("input[data-combo-cb]:checked");
    const keys = Array.from(boxes).map(cb => cb.value);
    const strategyRadio = menu.querySelector<HTMLInputElement>("input[name='combo-strategy']:checked");
    const strategy = strategyRadio?.value === "max" ? "max" : "avg";
    if (keys.length < 2) return "";
    return `combo_${strategy}:${keys.join(",")}`;
}

// 更新面板底部预览（实时计算）。
function updateComboPreview() {
    const source = buildComboSourceFromPanel();
    const countEl = document.getElementById("combo-count");
    const previewEl = document.getElementById("combo-preview");
    const confirmBtn = document.getElementById("combo-confirm") as HTMLButtonElement | null;
    const menu = document.getElementById("fe-source-menu");
    if (!menu) return;
    const boxes = menu.querySelectorAll<HTMLInputElement>("input[data-combo-cb]:checked");
    const count = boxes.length;

    if (countEl) countEl.textContent = String(count);
    if (previewEl) {
        const temp = source ? resolveSourceTemp(source) : undefined;
        previewEl.textContent = fmtTemp(temp);
    }
    if (confirmBtn) {
        const ok = count >= 2;
        confirmBtn.disabled = !ok;
        confirmBtn.className = `px-4 py-1.5 rounded-lg text-xs font-medium ${ok ? "bg-sky-600 text-white hover:bg-sky-500" : "bg-slate-700 text-slate-500 cursor-not-allowed"}`;
    }
}

function applySourceModeUI(mode: SourceMode) {
    const switcher = document.getElementById("fe-source-mode");
    if (switcher) {
        switcher.querySelectorAll<HTMLButtonElement>("button[data-source-mode]").forEach(btn => {
            const active = btn.dataset.sourceMode === mode;
            btn.className = `px-3 py-1 text-xs rounded-md transition-colors ${
                active ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
            }`;
        });
    }
    const menu = document.getElementById("fe-source-menu");
    const input = document.getElementById("fe-source") as HTMLInputElement | null;
    if (menu && input) {
        menu.innerHTML = renderSourceOptions(input.value, mode);
    }
}

function updateHistoryChart() {
    if (!historyChart || !telemetry) return;
    const h = telemetry.history;

    // 后端 HistoryPoint.Value 带 omitempty，nil 时字段被省略，
    // 所以前端需要用 'in' 判断字段是否存在，而非只检查值
    function getValue(p: any): number | null {
        return ("value" in p && p.value != null) ? p.value : null;
    }

    // 计算所有温度数据的最大/最小值，用于 Y 轴自适应
    function getStats(arr: any[]): { min: number; max: number } {
        const vals = arr.map(getValue).filter((v): v is number => v !== null);
        if (vals.length === 0) return {min: Infinity, max: -Infinity};
        return {min: Math.min(...vals), max: Math.max(...vals)};
    }

    const cpuStats = getStats(h.cpu_temp);
    const gpuStats = getStats(h.gpu_temp);
    const diskStats = getStats(h.disk_avg);
    const dataMin = Math.min(cpuStats.min, gpuStats.min, diskStats.min);
    const dataMax = Math.max(cpuStats.max, gpuStats.max, diskStats.max);
    // Y 轴范围：最小值向下取整，最大值向上取整，留适当余量
    // 如果 dataMin 或 dataMax 是无穷大（所有数据源都为空），使用默认值
    const yMin = isFinite(dataMin) ? Math.floor(dataMin / 5) * 5 - 5 : 0;
    const yMax = isFinite(dataMax) ? Math.ceil(dataMax / 5) * 5 + 5 : 100;

    const x = h.cpu_temp.map((p: any) => p.time);
    historyChart.setOption({
        xAxis: {data: x},
        yAxis: {type: "value", min: Math.max(0, yMin), max: yMax},
        series: [
            {
                data: h.cpu_temp.map(getValue),
                color: "#38bdf8",
                showSymbol: false,
                lineStyle: {color: "#38bdf8", width: 2},
                emphasis: {scale: 2}
            },
            {
                data: h.gpu_temp.map(getValue),
                color: "#f97316",
                showSymbol: false,
                lineStyle: {color: "#f97316", width: 2},
                emphasis: {scale: 2}
            },
            {
                data: h.disk_avg.map(getValue),
                color: "#10b981",
                showSymbol: false,
                lineStyle: {color: "#10b981", width: 2},
                emphasis: {scale: 2}
            }
        ]
    });
}

function initHistoryChart() {
    const el = $("history-chart");
    historyChart = echarts.init(el);
    historyChart.setOption({
        backgroundColor: "transparent",
        textStyle: {color: "#cbd5e1"},
        legend: {top: 0, textStyle: {color: "#cbd5e1"}, data: ["CPU", "GPU", "硬盘平均"]},
        tooltip: {trigger: "axis"},
        grid: {left: 40, right: 20, top: 36, bottom: 24},
        xAxis: {
            type: "category",
            data: [],
            boundaryGap: false,
            axisLine: {lineStyle: {color: "rgba(148,163,184,0.4)"}}
        },
        yAxis: {
            type: "value",
            axisLine: {lineStyle: {color: "rgba(148,163,184,0.4)"}},
            splitLine: {lineStyle: {color: "rgba(148,163,184,0.12)"}}
        },
        series: [
            {
                name: "CPU",
                type: "line",
                smooth: true,
                data: [],
                color: "#38bdf8",
                lineStyle: {color: "#38bdf8", width: 2},
                showSymbol: false,
                emphasis: {scale: 2}
            },
            {
                name: "GPU",
                type: "line",
                smooth: true,
                data: [],
                color: "#f97316",
                lineStyle: {color: "#f97316", width: 2},
                showSymbol: false,
                emphasis: {scale: 2}
            },
            {
                name: "硬盘平均",
                type: "line",
                smooth: true,
                data: [],
                color: "#10b981",
                lineStyle: {color: "#10b981", width: 2},
                showSymbol: false,
                emphasis: {scale: 2}
            }
        ]
    });
    window.addEventListener("resize", () => historyChart?.resize());
}

const symbolSize = 16;

function initFanCurveChartShell() {
    if (fanCurveChart) return;
    const chartDom = $("fan-curve-editor");
    fanCurveChart = echarts.init(chartDom);
    const option: echarts.EChartsOption = {
        backgroundColor: "transparent",
        tooltip: {
            triggerOn: "none",
            formatter: (p: unknown) => {
                const item = p as { data: [number, number] };
                const d = item.data;
                return `温度: ${d[0].toFixed(1)}°C\nPWM: ${d[1].toFixed(0)}`;
            }
        },
        grid: {top: "10%", bottom: "15%", left: "10%", right: "10%"},
        xAxis: {
            min: 30,
            max: 80,
            type: "value",
            axisLine: {lineStyle: {color: "#334155"}},
            splitLine: {lineStyle: {color: "rgba(51, 65, 85, 0.3)", type: "dashed"}},
            name: "温度 (°C)",
            nameLocation: "middle",
            nameGap: 35,
            nameTextStyle: {color: "#64748b", fontSize: 12}
        },
        yAxis: {
            min: 0,
            max: 255,
            type: "value",
            axisLine: {lineStyle: {color: "#334155"}},
            splitLine: {lineStyle: {color: "rgba(51, 65, 85, 0.3)", type: "dashed"}},
            name: "PWM 值",
            nameLocation: "middle",
            nameGap: 45,
            nameTextStyle: {color: "#64748b", fontSize: 12}
        },
        series: [
            {
                id: "curve",
                type: "line",
                smooth: false,
                symbolSize,
                data: curveData,
                lineStyle: {color: "#0ea5e9", width: 4, shadowBlur: 15, shadowColor: "rgba(14, 165, 233, 0.4)"},
                itemStyle: {color: "#fff", borderColor: "#0ea5e9", borderWidth: 3},
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        {offset: 0, color: "rgba(14, 165, 233, 0.3)"},
                        {offset: 1, color: "rgba(14, 165, 233, 0)"}
                    ])
                }
            }
        ]
    };
    fanCurveChart.setOption(option);
    updateFanCurveGraphic();

    if (!fanCurveChartBound) {
        fanCurveChartBound = true;
        window.addEventListener("resize", () => {
            fanCurveChart?.resize();
            updateFanCurveGraphic();
        });

        fanCurveChart.getZr().on("dblclick", (params: { offsetX: number; offsetY: number }) => {
            if (!fanCurveChart) return;
            const pt = fanCurveChart.convertFromPixel("grid", [params.offsetX, params.offsetY]) as number[];
            if (pt[0] >= 0 && pt[0] <= 100 && pt[1] >= 0 && pt[1] <= 255) {
                curveData.push(pt);
                curveData.sort((a, b) => a[0] - b[0]);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });

        chartDom.addEventListener("contextmenu", e => {
            e.preventDefault();
            if (!fanCurveChart) return;
            const pt = fanCurveChart.convertFromPixel("grid", [e.offsetX, e.offsetY]) as number[];
            let idx = -1;
            curveData.forEach((d, i) => {
                if (Math.abs(d[0] - pt[0]) < 3 && Math.abs(d[1] - pt[1]) < 10) idx = i;
            });
            if (idx !== -1 && curveData.length > 2) {
                curveData.splice(idx, 1);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });
    }
}

function updateFanCurveDataAndGraphic() {
    if (!fanCurveChart) return;
    fanCurveChart.setOption({series: [{id: "curve", data: curveData}]});
    updateFanCurveGraphic();
}

function onFanPointDrag(dataIndex: number, pos: number[]) {
    if (!fanCurveChart) return;
    const pt = fanCurveChart.convertFromPixel("grid", pos) as number[];
    const newTemp = Math.round(Math.max(0, Math.min(100, pt[0])));
    const newPwm = Math.round(Math.max(0, Math.min(255, pt[1])));
    curveData[dataIndex] = [newTemp, newPwm];
    curveData.sort((a, b) => a[0] - b[0]);

    // 排序后重新查找当前拖动点的 dataIndex，确保 tooltip 显示正确数据
    const newDataIndex = curveData.findIndex(p => p[0] === newTemp && p[1] === newPwm);

    syncCurveToConfig();
    updateFanCurveDataAndGraphic();

    if (newDataIndex !== -1) {
        fanCurveChart.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex: newDataIndex});
    }
}

function updateFanCurveGraphic() {
    if (!fanCurveChart) return;
    const g: any[] = curveData.map((item, dataIndex) => ({
        type: "circle",
        position: fanCurveChart!.convertToPixel("grid", item) as number[],
        shape: {r: symbolSize / 1.5},
        invisible: true,
        draggable: true,
        z: 100,
        ondrag(this: any) {
            onFanPointDrag(dataIndex, [this.x, this.y]);
        },
        onmousemove() {
            fanCurveChart?.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex});
        },
        onmouseout() {
            fanCurveChart?.dispatchAction({type: "hideTip"});
        }
    }));
    fanCurveChart.setOption({graphic: g}, {replaceMerge: ["graphic"]});
}

function syncCurveToConfig() {
    const fan = config.fans.find(f => f.id === selectedCurveFanId);
    if (fan) fan.curve = pairsToCurve(curveData);
}

function loadCurveIntoEditor() {
    const fan = config.fans.find(f => f.id === selectedCurveFanId);
    curveData = fan ? curveToPairs(fan.curve?.length ? fan.curve : DEFAULT_CURVE) : [[35, 80], [75, 255]];
    updateFanCurveDataAndGraphic();
}

function fillGlobalForm() {
    const g = config.global;
    ($("g-deadzone") as HTMLInputElement).value = String(g.pwm_deadzone);
    ($("g-interval") as HTMLInputElement).value = String(Math.round(g.update_interval_ms / 1000));
    ($("g-emergency") as HTMLInputElement).value = String(g.emergency_temp);
    ($("g-stop-beh") as HTMLSelectElement).value = g.stop_behavior;
    ($("g-stop-pwm") as HTMLInputElement).value = String(g.stop_pwm);
    ($("g-hysteresis") as HTMLInputElement).value = String(g.stop_hysteresis);
    updateStopPWMRow();
}

// 渲染传感器管理面板的表格行
function renderSensorMgrTable() {
    const tbody = document.getElementById("sensor-mgr-tbody");
    if (!tbody) return;
    const sensors = telemetry?.sensors ?? [];
    const aliases = config.global.sensor_aliases ?? {};
    const hiddenSet = new Set(config.global.sensor_hidden ?? []);

    if (sensors.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">暂无传感器数据（等待后端推送）</td></tr>`;
        return;
    }

    tbody.innerHTML = sensors.map(s => {
        const chipLabel = s.device ? `${s.chip} · ${s.device}` : s.chip;
        const label = s.label || s.key;
        const temp = s.temp != null ? `${s.temp.toFixed(1)}°C` : "—";
        const alias = aliases[s.id] ?? "";
        const hidden = hiddenSet.has(s.id);
        return `
<tr class="border-b border-slate-700/30 ${hidden ? "opacity-50" : ""}" data-sensor-id="${esc(s.id)}">
    <td class="p-2 text-sky-400 font-mono whitespace-nowrap">${esc(chipLabel)}</td>
    <td class="p-2 text-slate-300 whitespace-nowrap">${esc(label)}</td>
    <td class="p-2 font-mono tabular-nums text-slate-400">${esc(temp)}</td>
    <td class="p-2">
        <input type="text" data-sensor-alias
               class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500 placeholder-slate-600"
               value="${esc(alias)}" placeholder="${esc(label)}"/>
    </td>
    <td class="p-2 text-center">
        <input type="checkbox" data-sensor-hidden ${hidden ? "checked" : ""}
               class="accent-sky-500 w-4 h-4 cursor-pointer"/>
    </td>
</tr>`;
    }).join("");
}

// 从传感器面板收集别名和隐藏列表，写回 config.global
function readSensorMgrIntoConfig() {
    const tbody = document.getElementById("sensor-mgr-tbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll<HTMLTableRowElement>("tr[data-sensor-id]");
    const aliases: Record<string, string> = {};
    const hidden: string[] = [];
    rows.forEach(row => {
        const id = row.dataset.sensorId!;
        const aliasInput = row.querySelector<HTMLInputElement>("input[data-sensor-alias]");
        const hiddenCb = row.querySelector<HTMLInputElement>("input[data-sensor-hidden]");
        const alias = aliasInput?.value.trim() ?? "";
        if (alias) aliases[id] = alias;
        if (hiddenCb?.checked) hidden.push(id);
    });
    config.global.sensor_aliases = aliases;
    config.global.sensor_hidden = hidden;
}

// 实时更新传感器面板的温度列（不重绘整表，避免干扰别名输入）
function updateSensorMgrTemps() {
    const panel = document.getElementById("sensor-mgr-panel");
    if (!panel || panel.classList.contains("hidden")) return;
    const sensors = telemetry?.sensors ?? [];
    const sensorMap = new Map(sensors.map(s => [s.id, s]));
    const rows = panel.querySelectorAll<HTMLTableRowElement>("tr[data-sensor-id]");
    rows.forEach(row => {
        const id = row.dataset.sensorId!;
        const s = sensorMap.get(id);
        const td = row.children[2] as HTMLElement | undefined;
        if (td) td.textContent = s?.temp != null ? `${s.temp.toFixed(1)}°C` : "—";
    });
}

// 通用折叠区绑定
function bindCollapsible(toggleId: string, panelId: string, chevronId: string, onOpen?: () => void) {
    const toggle = document.getElementById(toggleId);
    const panel = document.getElementById(panelId);
    const chevron = document.getElementById(chevronId);
    if (!toggle || !panel || !chevron) return;
    toggle.addEventListener("click", () => {
        const wasHidden = panel.classList.contains("hidden");
        panel.classList.toggle("hidden");
        chevron.style.transform = wasHidden ? "rotate(90deg)" : "";
        if (wasHidden && onOpen) onOpen();
    });
}

function updateStopPWMRow() {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    const row = $("g-stop-pwm-row");
    if (row) {
        row.classList.toggle("hidden", stopBeh !== "set");
    }
}

function clampPWM(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

function readGlobalForm(): GlobalConfig {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    return {
        ...config.global,
        pwm_deadzone: clampPWM(Number(($("g-deadzone") as HTMLInputElement).value) || 0),
        update_interval_ms: Math.max(1000, Number(($("g-interval") as HTMLInputElement).value) * 1000) || 2000,
        emergency_temp: Math.max(0, Number(($("g-emergency") as HTMLInputElement).value) || 80),
        stop_behavior: stopBeh === "set" ? "set" : "keep",
        stop_pwm: clampPWM(Number(($("g-stop-pwm") as HTMLInputElement).value) || 200),
        stop_hysteresis: Math.max(0, Number(($("g-hysteresis") as HTMLInputElement).value) || 2),
    };
}

function openFanSettingsDialog(idx: number) {
    editFanIdx = idx;
    const fan = config.fans[idx];
    if (!fan) return;
    selectedCurveFanId = fan.id;

    ($("fan-edit-title") as HTMLElement).textContent = `风扇设置 · ${fan.name}`;
    ($("fe-name") as HTMLInputElement).value = fan.name;
    ($("fe-pwm") as HTMLInputElement).value = fan.pwm_path;
    ($("fe-rpm") as HTMLInputElement).value = fan.rpm_path;
    ($("fe-en") as HTMLInputElement).value = fan.enable_path;
    setSourceValue(fan.source);
    closeSourceMenu();
    originalSourceMode = resolveSourceMode();
    // combo source 在高级模式中展示组合区域，自动切到 advanced
    const isCombo = fan.source.startsWith("combo_avg:") || fan.source.startsWith("combo_max:");
    const displayMode: SourceMode = isCombo ? "advanced" : originalSourceMode;
    applySourceModeUI(displayMode);

    initFanCurveChartShell();
    loadCurveIntoEditor();

    const dlg = $("fan-edit-dialog") as HTMLDialogElement;
    dlg.showModal();
    requestAnimationFrame(() => {
        fanCurveChart?.resize();
        updateFanCurveGraphic();
    });
}

function readFanFormIntoConfig(): FanConfig | null {
    if (editFanIdx === null) return null;
    const fan = config.fans[editFanIdx];
    if (!fan) return null;
    fan.name = ($("fe-name") as HTMLInputElement).value;
    fan.pwm_path = ($("fe-pwm") as HTMLInputElement).value.trim();
    fan.rpm_path = ($("fe-rpm") as HTMLInputElement).value.trim();
    fan.enable_path = ($("fe-en") as HTMLInputElement).value.trim();
    fan.source = ($("fe-source") as HTMLInputElement).value;
    return fan;
}

function bindFanRoot() {
    const root = $("fan-root");
    root.addEventListener("click", async ev => {
        const t = ev.target as HTMLElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        const del = t.closest("[data-act=fan-delete]");
        if (del && row) {
            const id = row.dataset.fanId!;
            const name = config.fans.find(f => f.id === id)?.name ?? id;
            if (!(await openConfirm(`确定从配置中删除风扇「${name}」吗？`))) return;
            try {
                await removeFan(id);
                await refresh();
                toast("已删除该风扇配置", "success");
            } catch (e) {
                console.error(e);
                toast(String(e), "error");
            }
            return;
        }
        const gear = t.closest("[data-act=fan-settings]");
        if (gear && row) {
            openFanSettingsDialog(Number(row.dataset.fanIdx));
            return;
        }
        const modeBtn = t.closest("[data-mode]") as HTMLElement | null;
        if (modeBtn && row) {
            const id = row.dataset.fanId!;
            const mode = modeBtn.dataset.mode as "manual" | "curve";
            const fan = config.fans.find(f => f.id === id);
            if (!fan || fan.mode === mode) return;
            fan.mode = mode;
            try {
                await setFanMode(id, mode);
                await refresh();
            } catch (e) {
                console.error(e);
                toast(String(e), "error");
            }
        }
    });

    root.addEventListener("input", ev => {
        const t = ev.target as HTMLInputElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const fan = config.fans.find(f => f.id === row.dataset.fanId);
        if (!fan) return;
        if (t.dataset.field === "pwm-range") {
            const v = Number(t.value);
            fan.manual_pwm = v;
            const span = row.querySelector("[data-fan-pwm-display]");
            if (span) span.textContent = `${v} / 255`;
        }
    });

    // 拖动结束（松开鼠标）时才调用接口
    root.addEventListener("pointerup", async ev => {
        const t = ev.target as HTMLInputElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.fanId!;
        const fan = config.fans.find(f => f.id === id);
        if (!fan) return;
        if (t.dataset.field === "pwm-range") {
            const v = Number(t.value);
            try {
                await setFanManualPWM(id, v);
            } catch (e) {
                console.error(e);
                toast(String(e), "error");
            }
        }
    });
}

// ===== 自定义温度源下拉的开关 / 选择 / 外部点击关闭 / Esc 关闭 =====

function openSourceMenu() {
    const menu = document.getElementById("fe-source-menu");
    const chevron = document.getElementById("fe-source-chevron");
    if (menu) {
        menu.classList.remove("hidden");
        menu.scrollTop = 0;
    }
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

function closeSourceMenu() {
    const menu = document.getElementById("fe-source-menu");
    const chevron = document.getElementById("fe-source-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

function isSourceMenuOpen(): boolean {
    const menu = document.getElementById("fe-source-menu");
    return !!menu && !menu.classList.contains("hidden");
}

function bindSourceDropdown() {
    const btn = document.getElementById("fe-source-btn");
    const menu = document.getElementById("fe-source-menu");
    const wrapper = document.getElementById("fe-source-wrapper");
    if (!btn || !menu || !wrapper) return;

    btn.addEventListener("click", ev => {
        ev.stopPropagation();
        if (isSourceMenuOpen()) {
            closeSourceMenu();
        } else {
            const mode = resolveSourceMode();
            const input = document.getElementById("fe-source") as HTMLInputElement | null;
            menu.innerHTML = renderSourceOptions(input?.value ?? "", mode);
            openSourceMenu();
        }
    });

    // 简洁/高级模式：点选单个源
    menu.addEventListener("click", ev => {
        const target = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-value]");
        if (target) {
            const v = target.dataset.sourceValue;
            if (v === undefined) return;
            setSourceValue(v);
            const mode = resolveSourceMode();
            menu.innerHTML = renderSourceOptions(v, mode);
            closeSourceMenu();
            return;
        }

        // 组合模式：确认按钮
        const confirm = (ev.target as HTMLElement).closest("#combo-confirm") as HTMLButtonElement | null;
        if (confirm && !confirm.disabled) {
            const src = buildComboSourceFromPanel();
            if (src) {
                setSourceValue(src);
                closeSourceMenu();
            }
        }
    });

    // 组合模式：checkbox / radio 变化 → 更新预览
    menu.addEventListener("change", ev => {
        const t = ev.target as HTMLInputElement;
        if (t.dataset.comboCb !== undefined || t.name === "combo-strategy") {
            updateComboPreview();
        }
    });

    // 点击外部关闭
    document.addEventListener("click", ev => {
        if (!isSourceMenuOpen()) return;
        if (wrapper.contains(ev.target as Node)) return;
        closeSourceMenu();
    });

    // Esc 关闭
    document.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && isSourceMenuOpen()) {
            closeSourceMenu();
            ev.stopPropagation();
        }
    });
}

// bindSourceModeSwitcher 绑定风扇编辑对话框中"简洁/极客"切换按钮的事件。
// 仅在本地 config 上修改 source_mode + 刷新下拉；持久化等到点"保存设置与曲线"时一起做，
// 这样"切换后未保存就关闭"会自动回滚，不会留下与 fan.source 不一致的脏状态。
function bindSourceModeSwitcher() {
    const switcher = document.getElementById("fe-source-mode");
    if (!switcher) return;
    switcher.addEventListener("click", ev => {
        const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-mode]");
        if (!btn) return;
        const mode: SourceMode = btn.dataset.sourceMode === "advanced" ? "advanced" : "simple";
        if (config.global.source_mode === mode) return;
        config.global.source_mode = mode;
        applySourceModeUI(mode);
    });
}

function pwmPathTaken(path: string): boolean {
    return config.fans.some(f => f.pwm_path === path);
}

async function runHardwareScan() {
    const status = $("scan-status");
    status.textContent = "正在扫描…";
    try {
        lastScanResults = await fetchScanFans();
        status.textContent = `共发现 ${lastScanResults?.length ?? 0} 个 PWM 通道`;
        renderScanTable();
    } catch (e) {
        console.error(e);
        status.textContent = `扫描失败：${String(e)}`;
        ($("scan-fans-tbody") as HTMLElement).innerHTML = "";
    }
}

function renderScanTable() {
    const tbody = $("scan-fans-tbody") as HTMLElement;
    tbody.innerHTML = lastScanResults
        .map((s, i) => {
            const taken = pwmPathTaken(s.pwm_path);
            return `
<tr class="border-b border-slate-800 ${taken ? "opacity-50" : ""}">
  <td class="p-2 align-top">
    <input type="checkbox" data-scan-idx="${i}" class="scan-cb rounded border-slate-600" ${taken ? "disabled" : ""} />
  </td>
  <td class="p-2 align-top text-slate-300">${esc(s.name)}<div class="text-[10px] text-slate-500 font-mono mt-1">${esc(s.id)}</div></td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.pwm_path)}</td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.rpm_path || "—")}</td>
</tr>`;
        })
        .join("");
}

async function addScannedFansFromSelection() {
    const boxes = document.querySelectorAll<HTMLInputElement>(".scan-cb:checked:not(:disabled)");
    let n = 0;
    boxes.forEach(box => {
        const i = Number(box.dataset.scanIdx);
        const s = lastScanResults[i];
        if (!s || pwmPathTaken(s.pwm_path)) return;
        let id = s.id;
        if (config.fans.some(f => f.id === id)) {
            id = `${s.id}-${Date.now().toString(36)}`;
        }
        const fan: FanConfig = {
            id,
            name: s.name,
            pwm_path: s.pwm_path,
            rpm_path: s.rpm_path,
            enable_path: s.enable_path,
            mode: "curve",
            source: "cpu",
            manual_pwm: 120,
            curve: DEFAULT_CURVE.map(c => ({...c}))
        };
        config.fans.push(fan);
        n++;
    });
    if (n === 0) {
        toast("请勾选尚未加入配置的项。", "info");
        return;
    }
    try {
        await saveConfig(config);
        ($("scan-fans-dialog") as HTMLDialogElement).close();
        await refresh();
        toast(`已添加 ${n} 个风扇并已保存到服务端。`, "success");
    } catch (e) {
        console.error(e);
        toast(String(e), "error");
    }
}

async function refresh() {
    const [info, cfg] = await Promise.all([fetchInfo(), fetchConfig()]);
    config = cfg;
    applyTelemetry(info);
    fillGlobalForm();
}

async function ensureAuth(): Promise<boolean> {
    if (!authRequired) return true;
    if (getStoredToken()) return true;

    const setup = await fetchAuthSetup();
    const dlg = $("auth-dialog") as HTMLDialogElement;
    const input = $("auth-key-input") as HTMLInputElement;
    const errEl = $("auth-error") as HTMLElement;
    const title = $("auth-dialog-title") as HTMLElement;
    const desc = $("auth-dialog-desc") as HTMLElement;

    if (setup?.token) {
        title.textContent = "首次设置 API Key";
        desc.textContent = "系统已自动生成 API Key，确认后即可使用";
        input.value = setup.token;
    } else {
        title.textContent = "输入 API Key";
        desc.textContent = "请输入服务器配置的 API Key";
        input.value = "";
    }

    errEl.classList.add("hidden");
    dlg.addEventListener("cancel", e => e.preventDefault());
    dlg.showModal();

    return new Promise(resolve => {
        const handler = async () => {
            const key = input.value.trim();
            if (!key) {
                errEl.textContent = "请输入 API Key";
                errEl.classList.remove("hidden");
                return;
            }
            if (key.length < 32) {
                errEl.textContent = "API Key 长度不得少于 32 个字符";
                errEl.classList.remove("hidden");
                return;
            }

            if (setup?.token) {
                const ok = await confirmAuthSetup(key);
                if (!ok) {
                    errEl.textContent = "确认失败，请重试";
                    errEl.classList.remove("hidden");
                    return;
                }
            }

            setStoredToken(key);
            dlg.close();
            btn.removeEventListener("click", handler);
            resolve(true);
        };
        const btn = $("auth-confirm-btn");
        btn.addEventListener("click", handler);
    });
}

async function main() {
    updateSubtitleDate();
    window.setInterval(updateSubtitleDate, 1000);

    await initAuthMode()
    await ensureAuth();

    window.addEventListener("auth-required", () => {
        ensureAuth().then(() => refresh().catch(console.error));
    });

    $("btn-refresh").addEventListener("click", () => refresh().catch(console.error));

    $("btn-scan-fans").addEventListener("click", () => {
        ($("scan-fans-dialog") as HTMLDialogElement).showModal();
        runHardwareScan().catch(console.error);
    });
    $("scan-close").addEventListener("click", () => ($("scan-fans-dialog") as HTMLDialogElement).close());
    $("scan-refresh").addEventListener("click", () => runHardwareScan().catch(console.error));
    $("scan-add-selected").addEventListener("click", () => addScannedFansFromSelection().catch(console.error));

    $("btn-global-save").addEventListener("click", async () => {
        readSensorMgrIntoConfig();
        config.global = readGlobalForm();
        try {
            await setGlobalConfig(config.global);
            toast("全局设置已保存", "success");
            await refresh();
        } catch (e) {
            console.error(e);
            toast(String(e), "error");
        }
    });

    $("btn-global-discard").addEventListener("click", () => {
        refresh().catch(console.error);
    });

    $("g-stop-beh").addEventListener("change", updateStopPWMRow);

    const fanDlg = $("fan-edit-dialog") as HTMLDialogElement;
    $("fe-close").addEventListener("click", () => fanDlg.close());
    $("fe-cancel").addEventListener("click", () => fanDlg.close());
    $("fe-save").addEventListener("click", async () => {
        syncCurveToConfig();
        const fan = readFanFormIntoConfig();
        if (!fan) return;
        try {
            await saveConfig(config);
            await setFanCurve(fan.id, fan.curve);
            // 标记"已保存"，关闭事件就不再回滚 source_mode
            originalSourceMode = null;
            fanDlg.close();
            editFanIdx = null;
            // 使用已更新的配置刷新风扇卡片
            syncFanCardsFromTelemetryOrRender();
            toast("已保存", "success");
        } catch (e) {
            console.error(e);
            toast(String(e), "error");
        }
    });
    fanDlg.addEventListener("close", () => {
        editFanIdx = null;
        // 用户取消 / 关闭 / Esc 时，把对话框内修改但未保存的 source_mode 回滚
        if (originalSourceMode !== null) {
            config.global.source_mode = originalSourceMode;
            originalSourceMode = null;
        }
    });

    bindFanRoot();
    bindSourceModeSwitcher();
    bindSourceDropdown();
    bindCollapsible("fan-params-toggle", "fan-params-panel", "fan-params-chevron");
    bindCollapsible("sensor-mgr-toggle", "sensor-mgr-panel", "sensor-mgr-chevron", renderSensorMgrTable);
    initHistoryChart();

    await refresh();

    function connectWs() {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const token = getStoredToken();
        const qs = authRequired && token ? `?token=${encodeURIComponent(token)}` : "";
        const ws = new WebSocket(`${proto}//${window.location.host}/api/ws${qs}`);
        ws.addEventListener("open", () => {
            $("ws-text").textContent = "已连接";
            ($("ws-text") as HTMLElement).className = "text-sky-400 text-sm font-mono";
        });
        ws.addEventListener("message", ev => {
            try {
                applyTelemetry(JSON.parse(ev.data) as Telemetry);
            } catch {
                /* ignore */
            }
        });
        ws.addEventListener("close", () => {
            $("ws-text").textContent = "重连中…";
            ($("ws-text") as HTMLElement).className = "text-amber-400 text-sm font-mono";
            window.setTimeout(connectWs, 1500);
        });
    }

    connectWs();
}

main().catch(err => {
    console.error(err);
    toast(`启动失败: ${err}`, "error");
});