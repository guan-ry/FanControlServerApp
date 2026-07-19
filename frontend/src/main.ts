import "iconify-icon";
import "./style.css";
import * as echarts from "echarts";
import {
    checkUpdate,
    fetchConfig,
    fetchHistory,
    fetchInfo,
    fetchScanFans,
    initAuthMode,
    removeFan,
    saveConfig,
    setFanManualPWM,
    setFanMode,
    setGlobalConfig,
} from "./api";
import type {ConfigPayload, CurvePoint, DiskInfo, FanConfig, GlobalConfig, HistoryPoint, HistoryRange, HistorySeries, ScannedFan, Telemetry, UpdateCheckResult} from "./types";

const DEFAULT_CURVE: CurvePoint[] = [
    {temp: 45, pwm: 120},
    {temp: 60, pwm: 180},
    {temp: 75, pwm: 255}
];

let config: ConfigPayload = {
    version: 3,
    fans: [],
    global: {
        pwm_deadzone: 5,
        update_interval_ms: 2000,
        emergency_temp: 80,
        stop_behavior: "set",
        stop_pwm: 200,
        stop_hysteresis: 2,
        log_level: "info"
    }
};
let telemetry: Telemetry | undefined;

let fanCurveChart: echarts.ECharts | null = null;
let fanCurveChartBound = false;
let curveData: number[][] = [];
let selectedCurveFanId = "";
let historyChart: echarts.ECharts | null = null;
let historyChartResizeRaf = 0;
let historyChartResizeObserver: IntersectionObserver | null = null;
let historyData: HistorySeries | null = null;
let historyRange: HistoryRange = "1h";
let historyRefreshTimer: number | null = null;
let historySpanHours = 1;
let historyTimeMin = 0;
let historyTimeMax = 0;
type HistoryView = "temp" | "fan";
let historyView: HistoryView = "temp";
const historyRangeOptions: HistoryRange[] = ["1h", "6h", "24h", "7d", "custom"];
const historySensorSelected = new Set<string>();
const historyFanSelected = new Set<string>();

function syncHistoryPrefsToConfig() {
    config.global.history_range = historyRange;
    config.global.history_sensors = [...historySensorSelected];
    config.global.history_fans = [...historyFanSelected];
    if (historyRange === "custom") {
        const fromEl = document.getElementById("history-from") as HTMLInputElement | null;
        const toEl = document.getElementById("history-to") as HTMLInputElement | null;
        if (fromEl?.value) config.global.history_from = fromEl.value;
        if (toEl?.value) config.global.history_to = toEl.value;
    }
}

async function persistHistoryPrefs() {
    syncHistoryPrefsToConfig();
    try {
        await setGlobalConfig(config.global);
    } catch (e) {
        console.error(e);
    }
}

function applyHistoryPrefsFromConfig() {
    const g = config.global;
    if (g.history_range && historyRangeOptions.includes(g.history_range)) {
        historyRange = g.history_range;
    } else {
        historyRange = "1h";
    }

    const hiddenSensors = new Set(config.global.sensor_hidden ?? []);
    const knownSensors = new Set((telemetry?.sensors ?? []).map(s => s.id));
    historySensorSelected.clear();
    if (g.history_sensors == null) {
        // 从未配置：不强行勾选扩展传感器
    } else {
        for (const id of g.history_sensors) {
            if (hiddenSensors.has(id)) continue;
            if (knownSensors.size > 0 && !knownSensors.has(id)) continue;
            historySensorSelected.add(id);
        }
    }

    historyFanSelected.clear();
    if (g.history_fans == null) {
        // 从未配置：默认勾选前 5 个
        for (const fan of (config.fans ?? []).slice(0, 5)) {
            historyFanSelected.add(fan.id);
        }
    } else {
        // 含 []：尊重用户选择（全不选也保留）
        const knownFanIds = new Set((config.fans ?? []).map(f => f.id));
        for (const id of g.history_fans) {
            if (knownFanIds.has(id)) historyFanSelected.add(id);
        }
    }

    const rangeEl = document.getElementById("history-range") as HTMLSelectElement | null;
    if (rangeEl) rangeEl.value = historyRange;

    const panel = document.getElementById("history-custom-panel");
    panel?.classList.toggle("hidden", historyRange !== "custom");

    const fromEl = document.getElementById("history-from") as HTMLInputElement | null;
    const toEl = document.getElementById("history-to") as HTMLInputElement | null;
    if (g.history_from && fromEl) fromEl.value = g.history_from;
    if (g.history_to && toEl) toEl.value = g.history_to;

    setupHistoryRefreshTimer();
    updateHistorySensorsButtonLabel();
    updateHistoryFansButtonLabel();
    applyHistoryViewUI();
    renderHistoryLegend();
}

const HISTORY_COLOR_CPU = "#38bdf8";
const HISTORY_COLOR_GPU = "#f97316";
const HISTORY_COLOR_DISK = "#10b981";

/** 与温度页默认系列（CPU/GPU/硬盘）同序，其后接扩展传感器色板 */
const HISTORY_SERIES_COLORS = [
    HISTORY_COLOR_CPU,
    HISTORY_COLOR_GPU,
    HISTORY_COLOR_DISK,
    "#ef4444", // red
    "#eab308", // yellow
    "#d946ef", // fuchsia
    "#6366f1", // indigo
    "#84cc16", // lime
    "#14b8a6", // teal
    "#ec4899", // pink
    "#a855f7", // purple
    "#facc15", // amber
    "#e11d48", // rose
    "#22c55e", // green
    "#0891b2", // cyan-600
];

const HISTORY_CHART_GRID = {left: 8, right: 16, top: 16, bottom: 20, containLabel: true};

const HISTORY_CHART_ANIM = {animation: false, animationDurationUpdate: 0};

const HISTORY_X_AXIS_BASE = {
    type: "time" as const,
    axisLine: {lineStyle: {color: "rgba(148,163,184,0.4)"}},
    axisTick: {alignWithLabel: true},
    axisLabel: {
        showMinLabel: true,
        showMaxLabel: true,
        hideOverlap: false,
        margin: 10,
    },
};

const HISTORY_Y_AXIS_BASE = {
    type: "value" as const,
    axisLine: {lineStyle: {color: "rgba(148,163,184,0.4)"}},
    axisTick: {show: false},
    splitLine: {
        show: true,
        showMinLine: false,
        showMaxLine: false,
        lineStyle: {color: "rgba(148,163,184,0.12)"},
    },
};

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
    updateUptimeFromServer();
}

let lastUptime = 0;
let lastUptimeReceived = 0;

function updateUptimeFromServer() {
    if (lastUptime > 0) {
        const elapsed = Math.floor((Date.now() - lastUptimeReceived) / 1000);
        const currentUptime = lastUptime + elapsed;
        $("uptime-text").textContent = formatUptime(currentUptime);
    }
}

function onTelemetryReceived(t: Telemetry) {
    lastUptime = t.uptime ?? 0;
    lastUptimeReceived = Date.now();
}

let editFanIdx: number | null = null;
let lastScanResults: ScannedFan[] = [];
type SourceMode = "simple" | "advanced";
let originalSourceMode: SourceMode | null = null;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const DISK_SERIAL_VISIBLE_KEY = "fancontrol_show_disk_serial";

function loadDiskSerialVisible(): boolean {
    try {
        const v = localStorage.getItem(DISK_SERIAL_VISIBLE_KEY);
        if (v === null) {
            return false;
        }
        return v === "1";
    } catch {
        return false;
    }
}

let showDiskSerial = loadDiskSerialVisible();

function updateDiskSerialToggleIcon() {
    const btn = $("disk-serial-toggle");
    const icon = $("disk-serial-toggle-icon");
    icon.setAttribute("icon", showDiskSerial ? "mdi:eye" : "mdi:eye-off");
    const label = showDiskSerial ? "隐藏序列号" : "显示序列号";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("text-sky-400", showDiskSerial);
    btn.classList.toggle("text-slate-500", !showDiskSerial);
}

function setDiskSerialVisible(visible: boolean) {
    showDiskSerial = visible;
    try {
        localStorage.setItem(DISK_SERIAL_VISIBLE_KEY, visible ? "1" : "0");
    } catch { /* ignore */ }
    updateDiskSerialToggleIcon();
    $("storage-list").innerHTML = "";
    renderStorageList();
    syncFanCardsFromTelemetryOrRender();
    refreshOpenSourceDisplays();
}

function refreshOpenSourceDisplays() {
    const feInput = document.getElementById("fe-source") as HTMLInputElement | null;
    if (feInput?.value) {
        setSourceValue(feInput.value);
    }
    const fbInput = document.getElementById("fe-fb-source") as HTMLInputElement | null;
    if (fbInput?.value) {
        setFallbackSourceValue(fbInput.value);
    }
    applySourceModeUI(resolveSourceMode());
}

function maskDiskSerial(_serial: string): string {
    return "*".repeat(8);
}

function formatDiskSerialDisplay(serial: string): string {
    if (!showDiskSerial) {
        return maskDiskSerial(serial);
    }
    return serial;
}

function formatDiskLabel(disk: Pick<DiskInfo, "name" | "serial">): string {
    if (!disk.serial) {
        return disk.name;
    }
    return `${disk.name} · ${formatDiskSerialDisplay(disk.serial)}`;
}

/** 配置中的磁盘温度源：有序列号则用 serial，否则退回设备名 */
function diskSourceValue(disk: Pick<DiskInfo, "name" | "serial">): string {
    const serial = disk.serial?.trim();
    return serial ? `disk:${serial}` : `disk:${disk.name}`;
}

function findDiskBySourceKey(key: string): DiskInfo | undefined {
    const k = key.trim();
    if (!k) return undefined;
    return (telemetry?.disks?.details ?? []).find(
        d => (d.serial?.trim() === k) || d.name === k,
    );
}

function diskSourcesReferSame(a: string, b: string): boolean {
    if (a === b) return true;
    if (!a.startsWith("disk:") || !b.startsWith("disk:")) return false;
    const da = findDiskBySourceKey(a.slice(5));
    const db = findDiskBySourceKey(b.slice(5));
    return !!(da && db && da.name === db.name);
}

function sourcesMatch(a: string, b: string): boolean {
    if (a === b) return true;
    return diskSourcesReferSame(a, b);
}

function isComboKeySelected(selected: Set<string>, value: string): boolean {
    if (selected.has(value)) return true;
    for (const k of selected) {
        if (diskSourcesReferSame(k, value)) return true;
    }
    return false;
}

function renderDiskNameHtml(disk: Pick<DiskInfo, "name" | "serial">): string {
    const name = esc(disk.name);
    if (!disk.serial) {
        return `<iconify-icon icon="mdi:harddisk" class="shrink-0"></iconify-icon><span class="font-mono">${name}</span>`;
    }
    const serialText = esc(formatDiskSerialDisplay(disk.serial));
    const title = showDiskSerial ? esc(disk.serial) : "序列号已隐藏";
    return `<iconify-icon icon="mdi:harddisk" class="shrink-0"></iconify-icon><span class="font-mono truncate min-w-0" title="${title}">${name} · <span class="text-slate-500">${serialText}</span></span>`;
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
    $("cpu-temp-text").textContent = formatTemp(t.cpu_temp);
    updateRingProgress("cpu-ring", t.cpu_usage);
    $("cpu-ring-text").textContent = `${t.cpu_usage.toFixed(0)}%`;
    $("gpu-temp-text").textContent = formatTemp(t.gpu_temp);
    updateRingProgress("gpu-ring", 0);
    $("gpu-ring-text").textContent = "--%";
    updateRingProgress("mem-ring", t.mem_usage);
    $("mem-ring-text").textContent = `${t.mem_usage.toFixed(0)}%`;
    if (t.mem_total && t.mem_total > 0) {
        const available = (t.mem_total * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = available;
    } else {
        const estimated = (t.mem_usage * 0.01 * 16 * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = estimated;
    }
    $("disk-avg-text").textContent = formatTemp(t.disks.avg_temp);
    onTelemetryReceived(t);
    syncFanCardsFromTelemetryOrRender();
    renderStorageList();
    updateSensorMgrTemps();
    refreshHistorySelectorsFromTelemetry();
    scheduleHistoryChartResize();
}

function renderStorageList() {
    const list = $("storage-list");
    const d = telemetry?.disks.details ?? [];
    if (d.length === 0) {
        if (list.children.length === 0) return;
        list.innerHTML = "";
        return;
    }
    if (list.children.length !== d.length) {
        list.innerHTML = d
            .map(disk => `
      <div class="flex justify-between items-center gap-2 text-xs" data-disk-name="${esc(disk.name)}">
        <span class="text-slate-400 flex items-center gap-2 min-w-0">${renderDiskNameHtml(disk)}</span>
        <span class="disk-temp font-mono">${
                disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
            }</span>
      </div>`)
            .join("");
        return;
    }
    d.forEach((disk, idx) => {
        const item = list.children[idx] as HTMLElement;
        if (item.dataset.diskName !== disk.name) {
            list.innerHTML = d
                .map(disk => `
        <div class="flex justify-between items-center gap-2 text-xs" data-disk-name="${esc(disk.name)}">
          <span class="text-slate-400 flex items-center gap-2 min-w-0">${renderDiskNameHtml(disk)}</span>
          <span class="disk-temp font-mono">${
                    disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
                }</span>
        </div>`)
                .join("");
            return;
        }
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

/** PWM 0–255 → 转速旁显示的百分比 */
function fanPWMPercent(pwm: number | null | undefined): number {
    if (pwm == null || !Number.isFinite(pwm) || pwm < 0) return 0;
    return Math.round(Math.min(255, pwm) / 255 * 100);
}

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
        const pwmPct = fanPWMPercent(rt?.pwm ?? (manual ? fan.manual_pwm : undefined));
        const fanName = card.querySelector("[data-fan-name]") as HTMLElement | null;
        if (fanName) fanName.textContent = fan.name;
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
        const rpmPct = card.querySelector("[data-fan-pwm-pct]") as HTMLElement | null;
        if (rpmNum) rpmNum.textContent = String(rpm);
        if (rpmUnit) rpmUnit.textContent = stopped ? "STOPPED" : "RPM";
        if (rpmPct) {
            rpmPct.textContent = ` · ${pwmPct}%`;
            rpmPct.classList.toggle("hidden", stopped);
        }
        if (rpmRow) {
            rpmRow.className = `text-2xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}`;
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
            const pwmPct = fanPWMPercent(rt?.pwm ?? (manual ? fan.manual_pwm : undefined));
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
    <div data-fan-rpm-row class="text-2xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}">
      <span data-fan-rpm>${rpm}</span> <span data-fan-rpm-unit class="text-sm text-slate-500 font-normal not-italic">${stopped ? "STOPPED" : "RPM"}</span><span data-fan-pwm-pct class="text-base text-slate-400 font-semibold not-italic ${stopped ? "hidden" : ""}"> · ${pwmPct}%</span>
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

function resolveSourceTemp(source: string): number | undefined {
    const t = telemetry;
    if (!t) return undefined;
    if (source === "cpu") return t.cpu_temp;
    if (source === "gpu") return t.gpu_temp;
    if (source === "disk_avg") return t.disks?.avg_temp;
    if (source === "disk_max") {
        let best: number | undefined;
        for (const d of t.disks?.details ?? []) if (d.temp != null && (best === undefined || d.temp > best)) best = d.temp;
        return best;
    }
    if (source === "max") {
        const all: number[] = [];
        if (t.cpu_temp != null) all.push(t.cpu_temp);
        if (t.gpu_temp != null) all.push(t.gpu_temp);
        if (t.disks?.avg_temp != null) all.push(t.disks.avg_temp);
        for (const d of t.disks?.details ?? []) if (d.temp != null) all.push(d.temp);
        for (const s of t.sensors ?? []) if (s.temp != null) all.push(s.temp);
        return all.length ? Math.max(...all) : undefined;
    }
    if (source.startsWith("disk:")) {
        return findDiskBySourceKey(source.slice(5))?.temp;
    }
    if (source.startsWith("sensor:")) {
        const id = source.slice(7);
        return (t.sensors ?? []).find(s => s.id === id)?.temp;
    }
    if (source.startsWith("combo_avg:")) {
        const vals = source.slice("combo_avg:".length).split(",").map(k => resolveSourceTemp(k.trim())).filter((v): v is number => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
    }
    if (source.startsWith("combo_max:")) {
        const vals = source.slice("combo_max:".length).split(",").map(k => resolveSourceTemp(k.trim())).filter((v): v is number => v != null);
        return vals.length ? Math.max(...vals) : undefined;
    }
    return undefined;
}

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

function collectSourceGroups(mode: "simple" | "advanced"): SourceGroup[] {
    const disks = telemetry?.disks.details ?? [];
    const allSensors = telemetry?.sensors ?? [];
    const hidden = new Set(config.global.sensor_hidden ?? []);
    const aliases = config.global.sensor_aliases ?? {};
    const sensors = allSensors.filter(s => !hidden.has(s.id));
    if (mode === "simple") {
        const cpuSensor = config.global.cpu_sensor;
        const gpuSensor = config.global.gpu_sensor;
        const cpuLabel = cpuSensor ? `CPU · ${getSensorDisplayName(cpuSensor)}` : "CPU";
        const gpuLabel = gpuSensor ? `GPU · ${getSensorDisplayName(gpuSensor)}` : "GPU";
        const items: SourceItem[] = [
            {v: cpuSensor ? `sensor:${cpuSensor}` : "cpu", name: cpuLabel},
            {v: gpuSensor ? `sensor:${gpuSensor}` : "gpu", name: gpuLabel},
        ];
        disks.forEach(d => items.push({v: diskSourceValue(d), name: `硬盘 ${formatDiskLabel(d)}`, sleep: d.status === "sleep"}));
        items.push({v: "disk_avg", name: "硬盘平均"});
        items.push({v: "disk_max", name: "硬盘最大"});
        items.forEach(it => {
            if (!it.sleep) it.temp = resolveSourceTemp(it.v);
        });
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

function renderSourceOptions(current: string, mode: "simple" | "advanced", comboStrategyRadioName = "combo-strategy"): string {
    const groups = collectSourceGroups(mode);
    let html = "";
    let currentInList = false;
    for (const g of groups) {
        html += `<div class="px-3 py-1 text-[10px] uppercase tracking-wider text-sky-400 bg-slate-900 sticky top-0 z-10 border-b border-slate-700/50">${esc(g.label)}</div>`;
        for (const it of g.items) {
            if (sourcesMatch(it.v, current)) currentInList = true;
            const active = sourcesMatch(it.v, current);
            const nameCls = active ? "text-sky-300 font-medium" : "text-slate-200";
            const sleepCls = it.sleep ? "text-slate-500 italic" : (active ? "text-sky-400" : "text-slate-400");
            const checkIcon = active ? `<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>` : "";
            const tempText = fmtTemp(it.temp, it.sleep);
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
    const isCombo = current.startsWith("combo_avg:") || current.startsWith("combo_max:");
    if (isCombo) currentInList = true;
    if (current && !currentInList) {
        const tip = `（当前选中：${esc(getSourceLabel(current))}）`;
        html = `<div class="px-3 py-2 text-xs text-amber-400 italic bg-amber-500/5 border-b border-amber-500/30">${tip}</div>` + html;
    }
    if (mode === "advanced") {
        html += renderComboSection(current, comboStrategyRadioName);
    }
    return html;
}

function renderComboSection(currentSource: string, comboStrategyRadioName: string): string {
    const items = collectAllSourceItems();
    const combo = parseComboSource(currentSource);
    const selected = new Set<string>(combo?.keys ?? []);
    const strategy = combo?.strategy ?? "avg";
    const isComboActive = combo !== null;
    const computedTemp = isComboActive ? resolveSourceTemp(currentSource) : undefined;
    const countSelected = selected.size;
    let html = `
<div class="border-t-2 border-sky-500/30 mt-1" data-combo-radio-name="${esc(comboStrategyRadioName)}">
    <div class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-sky-400 bg-slate-900 sticky top-0 z-10 border-b border-slate-700/50 flex items-center justify-between">
        <span>组合温度源</span>
        <div class="flex items-center gap-3 normal-case tracking-normal">
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="${esc(comboStrategyRadioName)}" value="avg" ${strategy === "avg" ? "checked" : ""}
                       class="accent-sky-500 w-3 h-3"/>
                <span class="text-[11px] text-slate-300">平均</span>
            </label>
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="${esc(comboStrategyRadioName)}" value="max" ${strategy === "max" ? "checked" : ""}
                       class="accent-sky-500 w-3 h-3"/>
                <span class="text-[11px] text-slate-300">最大</span>
            </label>
        </div>
    </div>`;
    for (const it of items) {
        const checked = isComboKeySelected(selected, it.v);
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
        已选 <span data-combo-count class="text-sky-400 font-bold">${countSelected}</span> 个
        <span class="mx-1">·</span>
        计算值: <span data-combo-preview class="text-sky-400 font-mono">${esc(fmtTemp(computedTemp))}</span>
    </div>
    <button type="button" data-combo-confirm
            class="px-4 py-1.5 rounded-lg text-xs font-medium ${countSelected >= 2 ? "bg-sky-600 text-white hover:bg-sky-500" : "bg-slate-700 text-slate-500 cursor-not-allowed"}"
            ${countSelected < 2 ? "disabled" : ""}>
        确定组合
    </button>
</div>
</div>`;
    return html;
}

function setSourceValue(value: string) {
    const input = document.getElementById("fe-source") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("fe-source-display");
    if (display) {
        const t = resolveSourceTemp(value);
        const tempPart = t != null ? ` · ${t.toFixed(1)}°C` : "";
        display.textContent = `${getSourceLabel(value)}${tempPart}`;
    }
}

function setFallbackSourceValue(value: string) {
    const input = document.getElementById("fe-fb-source") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("fe-fb-source-display");
    if (display) {
        const t = resolveSourceTemp(value);
        const tempPart = t != null ? ` · ${t.toFixed(1)}°C` : "";
        display.textContent = `${getSourceLabel(value)}${tempPart}`;
    }
}

/** 获取传感器 ID 的人类可读短名称；有别名时仅显示别名 */
function getSensorDisplayName(sensorId: string): string {
    const sensors = telemetry?.sensors ?? [];
    const aliases = config.global.sensor_aliases ?? {};
    const alias = aliases[sensorId]?.trim();
    if (alias) return alias;
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return sensorId;
    const name = s.label || s.key;
    return s.device ? `${s.device}·${name}` : name;
}

function getSourceLabel(source: string): string {
    const sensors = telemetry?.sensors ?? [];
    const aliases = config.global.sensor_aliases ?? {};
    const cpuSensor = config.global.cpu_sensor;
    const gpuSensor = config.global.gpu_sensor;
    // 当 source 是由 CPUSensor/GPUSensor 映射生成的传感器源时，显示为 CPU/GPU
    if (cpuSensor && source === `sensor:${cpuSensor}`) return "CPU";
    if (gpuSensor && source === `sensor:${gpuSensor}`) return "GPU";
    if (source === "cpu") return "CPU";
    if (source === "gpu") return "GPU";
    if (source === "disk_avg") return "硬盘平均";
    if (source === "disk_max") return "硬盘最大";
    if (source === "max") return "全部最大";
    if (source.startsWith("disk:")) {
        const key = source.slice(5);
        const disk = findDiskBySourceKey(key);
        return disk ? `硬盘 ${formatDiskLabel(disk)}` : key;
    }
    if (source.startsWith("sensor:")) {
        const id = source.slice(7);
        const alias = aliases[id]?.trim();
        if (alias) return alias;
        const s = sensors.find(x => x.id === id);
        if (!s) return id;
        const name = s.label || s.key;
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

function resolveSourceMode(): SourceMode {
    return config.global.source_mode === "advanced" ? "advanced" : "simple";
}

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

function parseComboSource(source: string): { strategy: "avg" | "max"; keys: string[] } | null {
    if (source.startsWith("combo_avg:")) {
        return {strategy: "avg", keys: source.slice("combo_avg:".length).split(",").map(k => k.trim()).filter(Boolean)};
    }
    if (source.startsWith("combo_max:")) {
        return {strategy: "max", keys: source.slice("combo_max:".length).split(",").map(k => k.trim()).filter(Boolean)};
    }
    return null;
}

function buildComboSourceFromPanel(menu: HTMLElement): string {
    const boxes = menu.querySelectorAll<HTMLInputElement>("input[data-combo-cb]:checked");
    const keys = Array.from(boxes).map(cb => cb.value);
    const radioName = menu.querySelector("[data-combo-radio-name]")?.getAttribute("data-combo-radio-name") ?? "combo-strategy";
    const strategyRadio = menu.querySelector<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radioName)}"]:checked`);
    const strategy = strategyRadio?.value === "max" ? "max" : "avg";
    if (keys.length < 2) return "";
    return `combo_${strategy}:${keys.join(",")}`;
}

function updateComboPreview(menu: HTMLElement) {
    const source = buildComboSourceFromPanel(menu);
    const countEl = menu.querySelector("[data-combo-count]");
    const previewEl = menu.querySelector("[data-combo-preview]");
    const confirmBtn = menu.querySelector("[data-combo-confirm]") as HTMLButtonElement | null;
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
            btn.className = `px-3 py-1 text-xs rounded-md transition-colors ${active ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        });
    }
    const menu = document.getElementById("fe-source-menu");
    const input = document.getElementById("fe-source") as HTMLInputElement | null;
    if (menu && input) {
        menu.innerHTML = renderSourceOptions(input.value, mode);
    }
    const fbMenu = document.getElementById("fe-fb-source-menu");
    const fbInput = document.getElementById("fe-fb-source") as HTMLInputElement | null;
    if (fbMenu && fbInput) {
        fbMenu.innerHTML = renderSourceOptions(fbInput.value, mode, "combo-strategy-fb");
    }
}

function historyPointValue(p: HistoryPoint): number | null {
    return p.value != null ? p.value : null;
}

function formatHistoryTemp(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${v.toFixed(1)}°C`;
}

function formatHistoryPWM(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${Math.round(v)}`;
}

function formatHistoryPWMPercent(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${Math.round(v)}%`;
}

function formatHistoryRPM(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${Math.round(v)} RPM`;
}

function lookupHistoryValueAt(points: HistoryPoint[] | undefined, ts: number): number | null {
    if (!points?.length) return null;
    let best: number | null = null;
    let bestDiff = Infinity;
    for (const p of points) {
        const t = new Date(p.time).getTime();
        if (!Number.isFinite(t)) continue;
        const diff = Math.abs(t - ts);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = historyPointValue(p);
        }
    }
    // 允许与轴对齐后的时间有少量偏差（降采样/对齐）
    if (bestDiff > 5 * 60 * 1000) return null;
    return best;
}

function historyTooltipValue(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (Array.isArray(raw) && raw.length >= 2) {
        const v = raw[1];
        if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
}

function historyTooltipTime(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (Array.isArray(raw) && raw.length >= 1) {
        const t = raw[0];
        if (typeof t === "number" && Number.isFinite(t)) return t;
    }
    if (typeof raw === "string" && raw.includes("T")) {
        const t = new Date(raw).getTime();
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

function historyTooltipFormatter(params: unknown): string {
    const items = (Array.isArray(params) ? params : [params]) as Array<{
        seriesName?: string;
        seriesId?: string;
        color?: string;
        value?: unknown;
        data?: unknown;
        axisValue?: unknown;
    }>;
    if (items.length === 0) return "";
    const rawHead = items[0].axisValue ?? items[0].value ?? items[0].data;
    const headTime = historyTooltipTime(rawHead);
    const head = headTime != null
        ? formatHistoryAxisTime(new Date(headTime).toISOString())
        : String(rawHead ?? "");
    const lines = items
        .map(it => {
            const val = historyTooltipValue(it.value) ?? historyTooltipValue(it.data);
            if (val == null) return null;
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${it.color};margin-right:6px"></span>`;
            const seriesId = it.seriesId ?? "";
            if (seriesId.startsWith("fan_pwm:")) {
                const fanId = seriesId.slice("fan_pwm:".length);
                const rpm = headTime != null
                    ? lookupHistoryValueAt(historyData?.fans_rpm?.[fanId], headTime)
                    : null;
                return `${dot}${it.seriesName}: ${formatHistoryPWMPercent(val)} · ${formatHistoryRPM(rpm)}`;
            }
            return `${dot}${it.seriesName}: ${formatHistoryTemp(val)}`;
        })
        .filter((line): line is string => line != null);
    if (lines.length === 0) return head;
    return `${head}<br/>${lines.join("<br/>")}`;
}

function historyChartTooltip() {
    return {
        trigger: "axis" as const,
        formatter: historyTooltipFormatter,
        confine: true,
        extraCssText: "z-index: 10000; pointer-events: none;",
    };
}

function applyHistoryViewUI() {
    const sensorsWrap = document.getElementById("history-sensors-wrap");
    const fansWrap = document.getElementById("history-fans-wrap");
    sensorsWrap?.classList.toggle("hidden", historyView !== "temp");
    fansWrap?.classList.toggle("hidden", historyView !== "fan");
    if (historyView !== "temp") {
        document.getElementById("history-sensor-dropdown")?.classList.add("hidden");
        document.getElementById("history-sensors-chevron")?.setAttribute("icon", "mdi:chevron-down");
    }
    if (historyView !== "fan") {
        document.getElementById("history-fan-dropdown")?.classList.add("hidden");
        document.getElementById("history-fans-chevron")?.setAttribute("icon", "mdi:chevron-down");
    }
    document.querySelectorAll<HTMLButtonElement>("#history-view-tabs [data-history-view]").forEach(btn => {
        const active = btn.dataset.historyView === historyView;
        btn.className = `history-view-tab px-3 py-1 rounded-md transition-colors ${
            active ? "bg-sky-600 text-white" : "text-slate-400 hover:text-white"
        }`;
    });
}

function setHistoryView(view: HistoryView) {
    if (historyView === view) return;
    historyView = view;
    applyHistoryViewUI();
    renderHistoryLegend();
    updateHistoryChart();
    scheduleHistoryChartResize();
}

function scheduleHistoryChartResize() {
    if (!historyChart) return;
    if (historyChartResizeRaf) cancelAnimationFrame(historyChartResizeRaf);
    historyChartResizeRaf = requestAnimationFrame(() => {
        historyChartResizeRaf = 0;
        historyChart?.resize();
    });
}

function bindHistoryChartResizeObserver(el: HTMLElement) {
    historyChartResizeObserver?.disconnect();
    historyChartResizeObserver = new IntersectionObserver(
        entries => {
            if (entries.some(e => e.isIntersecting)) scheduleHistoryChartResize();
        },
        {threshold: 0.01},
    );
    historyChartResizeObserver.observe(el);
}

function formatHistoryAxisTime(iso: string): string {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    if (historySpanHours <= 24) {
        return `${h}:${m}`;
    }
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    if (historySpanHours <= 7 * 24) {
        return `${mo}-${day} ${h}:${m}`;
    }
    return `${mo}-${day}`;
}

function historyAxisLabelFormatter(val: number): string {
    return formatHistoryAxisTime(new Date(val).toISOString());
}

function historyXAxisMinInterval(): number {
    if (historySpanHours <= 1.5) return 10 * 60 * 1000;
    if (historySpanHours <= 6) return 60 * 60 * 1000;
    if (historySpanHours <= 24) return 2 * 60 * 60 * 1000;
    if (historySpanHours <= 7 * 24) return 6 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
}

function latestHistoryPointTime(h: HistorySeries): number {
    let max = 0;
    const groups = [
        h.cpu_temp,
        h.gpu_temp,
        h.disk_avg,
        ...Object.values(h.sensors ?? {}),
        ...Object.values(h.fans_pwm ?? {}),
    ];
    for (const pts of groups) {
        for (const p of pts) {
            const t = new Date(p.time).getTime();
            if (Number.isFinite(t)) max = Math.max(max, t);
        }
    }
    return max;
}

function applyHistoryTimeBounds(h: HistorySeries, windowEnd?: number, windowStart?: number) {
    const spanMs = historySpanHours * 3600000;
    const pad = Math.max(120_000, spanMs * 0.05);
    const dataMax = latestHistoryPointTime(h);
    const end = Math.max(windowEnd ?? Date.now(), dataMax);
    historyTimeMax = end + pad;
    historyTimeMin = (windowStart ?? end - spanMs) - pad * 0.2;
}

function sensorHistoryColor(id: string): string {
    // 扩展传感器从第 4 色起，避免与 CPU/GPU/硬盘默认色撞车
    const palette = HISTORY_SERIES_COLORS.slice(3);
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
}

function fanHistoryColor(id: string): string {
    const idx = (config.fans ?? []).findIndex(f => f.id === id);
    const i = idx >= 0 ? idx : 0;
    return HISTORY_SERIES_COLORS[i % HISTORY_SERIES_COLORS.length];
}

function historyPointsToSeriesData(points: HistoryPoint[]): [number, number][] {
    const out: [number, number][] = [];
    for (const p of points) {
        const v = historyPointValue(p);
        if (v == null || !Number.isFinite(v)) continue;
        out.push([new Date(p.time).getTime(), v]);
    }
    return out;
}

/** PWM 历史点 → 百分比（与风扇卡片一致：PWM/255） */
function historyPWMPointsToPercentData(points: HistoryPoint[]): [number, number][] {
    const out: [number, number][] = [];
    for (const p of points) {
        const v = historyPointValue(p);
        if (v == null || !Number.isFinite(v)) continue;
        out.push([new Date(p.time).getTime(), Math.min(100, Math.max(0, v / 255 * 100))]);
    }
    return out;
}

function historyPointsStats(arr: HistoryPoint[] | undefined): {min: number; max: number} {
    if (!arr?.length) return {min: Infinity, max: -Infinity};
    const vals = arr.map(historyPointValue).filter((v): v is number => v !== null);
    if (vals.length === 0) return {min: Infinity, max: -Infinity};
    return {min: Math.min(...vals), max: Math.max(...vals)};
}

/** 温度页 Y 轴：覆盖当前已加载时间范围内所有展示序列的历史点 */
function computeTempYAxisRange(h: HistorySeries, hidden: Set<string>): {min: number; max: number} {
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const arr of [h.cpu_temp, h.gpu_temp, h.disk_avg]) {
        const s = historyPointsStats(arr);
        dataMin = Math.min(dataMin, s.min);
        dataMax = Math.max(dataMax, s.max);
    }
    for (const id of historySensorSelected) {
        if (hidden.has(id)) continue;
        const s = historyPointsStats(h.sensors?.[id]);
        dataMin = Math.min(dataMin, s.min);
        dataMax = Math.max(dataMax, s.max);
    }
    if (!isFinite(dataMin) || !isFinite(dataMax)) {
        return {min: 0, max: 100};
    }
    return {
        min: Math.max(0, Math.floor((dataMin - 2) / 5) * 5),
        max: Math.ceil((dataMax + 2) / 5) * 5 + 5,
    };
}

const HISTORY_LINE_DEFAULTS = {
    type: "line" as const,
    smooth: true,
    smoothMonotone: "x" as const,
    showSymbol: false,
    clip: false,
    emphasis: {scale: 2},
};

function historyLineSeries(
    id: string,
    name: string,
    points: HistoryPoint[] | undefined,
    color: string,
    asPWMPercent = false,
): echarts.SeriesOption {
    return {
        ...HISTORY_LINE_DEFAULTS,
        id,
        name,
        data: asPWMPercent
            ? historyPWMPointsToPercentData(points ?? [])
            : historyPointsToSeriesData(points ?? []),
        color,
        lineStyle: {color, width: 2},
    };
}

function historyChartXAxisOption() {
    return {
        ...HISTORY_X_AXIS_BASE,
        min: historyTimeMin,
        max: historyTimeMax,
        minInterval: historyXAxisMinInterval(),
        axisLabel: {
            ...HISTORY_X_AXIS_BASE.axisLabel,
            formatter: historyAxisLabelFormatter,
        },
    };
}

function updateHistoryChart() {
    if (!historyChart || !historyData) return;
    const h = historyData;
    const hidden = new Set(config.global.sensor_hidden ?? []);
    const series: echarts.SeriesOption[] = [];
    let yAxis: echarts.YAXisComponentOption;

    if (historyView === "temp") {
        const {min: yMin, max: yMax} = computeTempYAxisRange(h, hidden);
        series.push(
            historyLineSeries("cpu_temp", "CPU", h.cpu_temp, HISTORY_COLOR_CPU),
            historyLineSeries("gpu_temp", "GPU", h.gpu_temp, HISTORY_COLOR_GPU),
            historyLineSeries("disk_avg", "硬盘平均", h.disk_avg, HISTORY_COLOR_DISK),
        );
        for (const s of telemetry?.sensors ?? []) {
            if (hidden.has(s.id) || !historySensorSelected.has(s.id)) continue;
            const pts = h.sensors?.[s.id];
            if (!pts?.length) continue;
            series.push(historyLineSeries(`sensor:${s.id}`, getSensorDisplayName(s.id), pts, sensorHistoryColor(s.id)));
        }
        yAxis = {
            ...HISTORY_Y_AXIS_BASE,
            min: yMin,
            max: yMax,
            axisLabel: {formatter: (v: number) => `${v.toFixed(0)}°`, margin: 8},
        };
    } else {
        for (const fan of config.fans ?? []) {
            if (!historyFanSelected.has(fan.id)) continue;
            const pts = h.fans_pwm?.[fan.id];
            if (!pts?.length) continue;
            series.push(historyLineSeries(`fan_pwm:${fan.id}`, fan.name || fan.id, pts, fanHistoryColor(fan.id), true));
        }
        yAxis = {
            ...HISTORY_Y_AXIS_BASE,
            min: 0,
            max: 100,
            axisLabel: {formatter: (v: number) => `${v.toFixed(0)}%`, margin: 8},
        };
    }

    historyChart.setOption({
        xAxis: historyChartXAxisOption(),
        yAxis,
        series,
    }, {replaceMerge: ["series", "yAxis"], silent: true});
    scheduleHistoryChartResize();
}

async function loadHistoryChart() {
    try {
        if (historyRange === "custom") {
            const fromEl = document.getElementById("history-from") as HTMLInputElement | null;
            const toEl = document.getElementById("history-to") as HTMLInputElement | null;
            const fromLocal = fromEl?.value;
            const toLocal = toEl?.value;
            if (!fromLocal || !toLocal) return;
            const from = new Date(fromLocal).toISOString();
            const to = new Date(toLocal).toISOString();
            historySpanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
            historyData = await fetchHistory({from, to});
            applyHistoryTimeBounds(historyData, new Date(to).getTime(), new Date(from).getTime());
        } else {
            const spanMap: Record<string, number> = {"1h": 1, "6h": 6, "24h": 24, "7d": 7 * 24};
            historySpanHours = spanMap[historyRange] ?? 1;
            historyData = await fetchHistory({range: historyRange});
            applyHistoryTimeBounds(historyData);
        }
        updateHistoryChart();
        renderHistoryLegend();
        refreshHistorySelectorsFromTelemetry();
    } catch (e: any) {
        console.error(e);
        toast(e?.message || "加载历史曲线失败", "error");
    }
}

function renderHistoryLegend() {
    const root = document.getElementById("history-legend-fixed");
    if (!root) return;
    const items: {name: string; color: string}[] = [];

    if (historyView === "temp") {
        const hidden = new Set(config.global.sensor_hidden ?? []);
        items.push(
            {name: "CPU", color: HISTORY_COLOR_CPU},
            {name: "GPU", color: HISTORY_COLOR_GPU},
            {name: "硬盘平均", color: HISTORY_COLOR_DISK},
        );
        // 与曲线一致：按 telemetry.sensors 顺序
        for (const s of telemetry?.sensors ?? []) {
            if (hidden.has(s.id) || !historySensorSelected.has(s.id)) continue;
            items.push({name: getSensorDisplayName(s.id), color: sensorHistoryColor(s.id)});
        }
    } else {
        // 与曲线一致：按 config.fans 顺序
        for (const fan of config.fans ?? []) {
            if (!historyFanSelected.has(fan.id)) continue;
            items.push({name: fan.name || fan.id, color: fanHistoryColor(fan.id)});
        }
    }

    root.innerHTML = items.map(it =>
        `<span class="inline-flex items-center gap-1.5 text-slate-300 font-medium">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(it.color)}"></span>
            <span>${esc(it.name)}</span>
        </span>`
    ).join("");
}

function updateHistorySensorsButtonLabel() {
    const label = document.getElementById("history-sensors-toggle-label");
    if (!label) return;
    const n = historySensorSelected.size;
    label.textContent = n > 0 ? `传感器 (${n})` : "传感器";
}

function updateHistoryFansButtonLabel() {
    const label = document.getElementById("history-fans-toggle-label");
    if (!label) return;
    const n = historyFanSelected.size;
    label.textContent = n > 0 ? `风扇 (${n})` : "风扇";
}

/** 遥测推送时：仅在下拉打开时重建列表，避免每秒重绘 */
function refreshHistorySelectorsFromTelemetry() {
    const sensorsDropdown = document.getElementById("history-sensor-dropdown");
    const fansDropdown = document.getElementById("history-fan-dropdown");
    if (sensorsDropdown && !sensorsDropdown.classList.contains("hidden")) {
        renderHistorySensorToggles();
    } else {
        updateHistorySensorsButtonLabel();
    }
    if (fansDropdown && !fansDropdown.classList.contains("hidden")) {
        renderHistoryFanToggles();
    } else {
        updateHistoryFansButtonLabel();
    }
}

function renderHistorySensorToggles() {
    const root = document.getElementById("history-sensor-toggles");
    if (!root) return;
    const hidden = new Set(config.global.sensor_hidden ?? []);
    const sensors = (telemetry?.sensors ?? []).filter(s => !hidden.has(s.id));
    if (sensors.length === 0) {
        root.innerHTML = `<span class="text-xs text-slate-500">暂无可用传感器</span>`;
        updateHistorySensorsButtonLabel();
        renderHistoryLegend();
        return;
    }
    root.innerHTML = sensors.map(s => {
        const color = sensorHistoryColor(s.id);
        const name = getSensorDisplayName(s.id);
        const on = historySensorSelected.has(s.id);
        return `<button type="button" data-history-sensor="${esc(s.id)}"
            class="w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left border transition-colors ${
            on
                ? "border-slate-500 bg-slate-700/80 text-slate-100"
                : "border-transparent bg-slate-800/40 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        }">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(color)}"></span>
            <span class="truncate flex-1" title="${esc(name)}">${esc(name)}</span>
        </button>`;
    }).join("");
    updateHistorySensorsButtonLabel();
    renderHistoryLegend();
}

function renderHistoryFanToggles() {
    const root = document.getElementById("history-fan-toggles");
    if (!root) return;
    const fans = config.fans ?? [];
    if (fans.length === 0) {
        root.innerHTML = `<span class="text-xs text-slate-500">暂无风扇</span>`;
        updateHistoryFansButtonLabel();
        renderHistoryLegend();
        return;
    }
    root.innerHTML = fans.map(f => {
        const color = fanHistoryColor(f.id);
        const name = f.name || f.id;
        const on = historyFanSelected.has(f.id);
        return `<button type="button" data-history-fan="${esc(f.id)}"
            class="w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left border transition-colors ${
            on
                ? "border-slate-500 bg-slate-700/80 text-slate-100"
                : "border-transparent bg-slate-800/40 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        }">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(color)}"></span>
            <span class="truncate flex-1" title="${esc(name)}">${esc(name)}</span>
        </button>`;
    }).join("");
    updateHistoryFansButtonLabel();
    renderHistoryLegend();
}

function setupHistoryRefreshTimer() {
    if (historyRefreshTimer != null) {
        window.clearInterval(historyRefreshTimer);
        historyRefreshTimer = null;
    }
    if (historyRange !== "custom") {
        historyRefreshTimer = window.setInterval(() => loadHistoryChart(), 60_000);
    }
}

function setupHistoryRangeControls() {
    const rangeEl = document.getElementById("history-range") as HTMLSelectElement | null;
    const panel = document.getElementById("history-custom-panel");
    const applyBtn = document.getElementById("history-apply");
    const toEl = document.getElementById("history-to") as HTMLInputElement | null;
    const fromEl = document.getElementById("history-from") as HTMLInputElement | null;

    document.getElementById("history-view-tabs")?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-history-view]");
        if (!btn) return;
        const view = btn.dataset.historyView as HistoryView | undefined;
        if (view === "temp" || view === "fan") setHistoryView(view);
    });

    const now = new Date();
    const fmt = (d: Date) => {
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    if (toEl) toEl.value = fmt(now);
    if (fromEl) fromEl.value = fmt(new Date(now.getTime() - 14 * 86400000));

    rangeEl?.addEventListener("change", () => {
        historyRange = (rangeEl.value as HistoryRange) || "1h";
        const isCustom = historyRange === "custom";
        panel?.classList.toggle("hidden", !isCustom);
        setupHistoryRefreshTimer();
        void persistHistoryPrefs();
        if (!isCustom) loadHistoryChart().catch(console.error);
    });

    applyBtn?.addEventListener("click", () => {
        void persistHistoryPrefs().then(() => loadHistoryChart().catch(console.error));
    });

    const sensorsWrap = document.getElementById("history-sensors-wrap");
    const sensorsToggle = document.getElementById("history-sensors-toggle");
    const sensorsDropdown = document.getElementById("history-sensor-dropdown");
    const sensorsPanel = document.getElementById("history-sensor-toggles");
    const sensorsChevron = document.getElementById("history-sensors-chevron");

    sensorsToggle?.addEventListener("click", e => {
        e.stopPropagation();
        document.getElementById("history-fan-dropdown")?.classList.add("hidden");
        const fansChevron = document.getElementById("history-fans-chevron");
        if (fansChevron) fansChevron.setAttribute("icon", "mdi:chevron-down");
        const hidden = sensorsDropdown?.classList.toggle("hidden") ?? true;
        if (sensorsChevron) {
            sensorsChevron.setAttribute("icon", hidden ? "mdi:chevron-down" : "mdi:chevron-up");
        }
        if (!hidden) renderHistorySensorToggles();
    });

    const fansWrap = document.getElementById("history-fans-wrap");
    const fansToggle = document.getElementById("history-fans-toggle");
    const fansDropdown = document.getElementById("history-fan-dropdown");
    const fansPanel = document.getElementById("history-fan-toggles");
    const fansChevron = document.getElementById("history-fans-chevron");

    fansToggle?.addEventListener("click", e => {
        e.stopPropagation();
        sensorsDropdown?.classList.add("hidden");
        if (sensorsChevron) sensorsChevron.setAttribute("icon", "mdi:chevron-down");
        const hidden = fansDropdown?.classList.toggle("hidden") ?? true;
        if (fansChevron) {
            fansChevron.setAttribute("icon", hidden ? "mdi:chevron-down" : "mdi:chevron-up");
        }
        if (!hidden) renderHistoryFanToggles();
    });

    document.addEventListener("click", e => {
        const target = e.target as Node;
        if (sensorsDropdown && !sensorsDropdown.classList.contains("hidden") && !sensorsWrap?.contains(target)) {
            sensorsDropdown.classList.add("hidden");
            if (sensorsChevron) sensorsChevron.setAttribute("icon", "mdi:chevron-down");
        }
        if (fansDropdown && !fansDropdown.classList.contains("hidden") && !fansWrap?.contains(target)) {
            fansDropdown.classList.add("hidden");
            if (fansChevron) fansChevron.setAttribute("icon", "mdi:chevron-down");
        }
    });

    sensorsPanel?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-history-sensor]");
        if (!btn) return;
        e.stopPropagation();
        const id = btn.dataset.historySensor!;
        if (historySensorSelected.has(id)) historySensorSelected.delete(id);
        else historySensorSelected.add(id);
        renderHistorySensorToggles();
        updateHistoryChart();
        void persistHistoryPrefs();
    });

    fansPanel?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-history-fan]");
        if (!btn) return;
        e.stopPropagation();
        const id = btn.dataset.historyFan!;
        if (historyFanSelected.has(id)) historyFanSelected.delete(id);
        else historyFanSelected.add(id);
        renderHistoryFanToggles();
        updateHistoryChart();
        void persistHistoryPrefs();
    });
}

function initHistoryChart() {
    const el = $("history-chart");
    historyChart = echarts.init(el);
    historyChart.setOption({
        ...HISTORY_CHART_ANIM,
        backgroundColor: "transparent",
        textStyle: {color: "#cbd5e1"},
        legend: {show: false},
        tooltip: historyChartTooltip(),
        grid: HISTORY_CHART_GRID,
        xAxis: {
            ...HISTORY_X_AXIS_BASE,
            min: historyTimeMin || undefined,
            max: historyTimeMax || undefined,
            minInterval: historyXAxisMinInterval(),
            axisLabel: {
                ...HISTORY_X_AXIS_BASE.axisLabel,
                formatter: historyAxisLabelFormatter,
            },
        },
        yAxis: {
            ...HISTORY_Y_AXIS_BASE,
            axisLabel: {margin: 8},
        },
        series: [],
    });
    bindHistoryChartResizeObserver(el);
    window.addEventListener("resize", () => scheduleHistoryChartResize());
    setupHistoryRangeControls();
    applyHistoryViewUI();
    renderHistoryLegend();
}

const symbolSize = 16;
const CURVE_POINT_HIT_PX = 28;

let editingCurvePointIndex = -1;
let curvePointDragMoved = false;

function findCurvePointIndexByPixel(offsetX: number, offsetY: number, threshold = CURVE_POINT_HIT_PX): number {
    if (!fanCurveChart) return -1;
    let best = -1;
    let bestDist = threshold;
    for (let i = 0; i < curveData.length; i++) {
        const px = fanCurveChart.convertToPixel("grid", curveData[i]) as number[];
        if (!px || px.length < 2) continue;
        const dist = Math.hypot(px[0] - offsetX, px[1] - offsetY);
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}

function openCurvePointEditDialog(dataIndex: number) {
    if (dataIndex < 0 || dataIndex >= curveData.length) return;
    editingCurvePointIndex = dataIndex;
    const [temp, pwm] = curveData[dataIndex];
    const dialog = document.getElementById("curve-point-edit-dialog") as HTMLDialogElement | null;
    const tempInput = document.getElementById("curve-point-temp") as HTMLInputElement | null;
    const pwmInput = document.getElementById("curve-point-pwm") as HTMLInputElement | null;
    if (!dialog || !tempInput || !pwmInput) return;
    tempInput.value = String(Math.round(temp));
    pwmInput.value = String(Math.round(pwm));
    dialog.showModal();
    window.setTimeout(() => tempInput.focus(), 0);
}

function applyCurvePointEditFromDialog() {
    if (editingCurvePointIndex < 0 || editingCurvePointIndex >= curveData.length) return;
    const tempInput = document.getElementById("curve-point-temp") as HTMLInputElement | null;
    const pwmInput = document.getElementById("curve-point-pwm") as HTMLInputElement | null;
    if (!tempInput || !pwmInput) return;
    const newTemp = Math.round(Math.max(0, Math.min(100, Number(tempInput.value))));
    const newPwm = Math.round(Math.max(0, Math.min(255, Number(pwmInput.value))));
    if (!Number.isFinite(newTemp) || !Number.isFinite(newPwm)) {
        toast("请输入有效的温度与 PWM", "error");
        return;
    }
    curveData[editingCurvePointIndex] = [newTemp, newPwm];
    curveData.sort((a, b) => a[0] - b[0]);
    editingCurvePointIndex = -1;
    syncCurveToConfig();
    updateFanCurveDataAndGraphic();
}

function initFanCurveChartShell() {
    if (fanCurveChart) return;
    const chartDom = $("fan-curve-editor");
    fanCurveChart = echarts.init(chartDom);
    const option: echarts.EChartsOption = {
        backgroundColor: "transparent",
        tooltip: {
            triggerOn: "none", formatter: (p: unknown) => {
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
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{
                        offset: 0,
                        color: "rgba(14, 165, 233, 0.3)"
                    }, {offset: 1, color: "rgba(14, 165, 233, 0)"}])
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
            // 双击已有点位：只打开编辑，不新增
            const nearIdx = findCurvePointIndexByPixel(params.offsetX, params.offsetY);
            if (nearIdx !== -1) {
                openCurvePointEditDialog(nearIdx);
                return;
            }
            const pt = fanCurveChart.convertFromPixel("grid", [params.offsetX, params.offsetY]) as number[];
            if (pt[0] >= 0 && pt[0] <= 100 && pt[1] >= 0 && pt[1] <= 255) {
                curveData.push([
                    Math.round(Math.max(0, Math.min(100, pt[0]))),
                    Math.round(Math.max(0, Math.min(255, pt[1]))),
                ]);
                curveData.sort((a, b) => a[0] - b[0]);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });
        chartDom.addEventListener("contextmenu", e => {
            e.preventDefault();
            if (!fanCurveChart) return;
            const idx = findCurvePointIndexByPixel(e.offsetX, e.offsetY);
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
    const newDataIndex = curveData.findIndex(p => p[0] === newTemp && p[1] === newPwm);
    syncCurveToConfig();
    updateFanCurveDataAndGraphic();
    if (newDataIndex !== -1) fanCurveChart.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex: newDataIndex});
}

function updateFanCurveGraphic() {
    if (!fanCurveChart) return;
    const g: any[] = curveData.map((item, dataIndex) => ({
        type: "circle",
        position: fanCurveChart!.convertToPixel("grid", item) as number[],
        shape: {r: Math.max(symbolSize / 1.5, 18)},
        invisible: true,
        draggable: true,
        z: 100,
        cursor: "pointer",
        onmousedown() {
            curvePointDragMoved = false;
        },
        ondrag(this: any) {
            curvePointDragMoved = true;
            onFanPointDrag(dataIndex, [this.x, this.y]);
        },
        onclick() {
            if (curvePointDragMoved) {
                curvePointDragMoved = false;
                return;
            }
            openCurvePointEditDialog(dataIndex);
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

function updateGlobalTuningRowVisibility() {
    const fans = config.fans;
    const n = fans.length;
    const allDz = n > 0 && fans.every(f => f.pwm_deadzone != null);
    const allH = n > 0 && fans.every(f => f.stop_hysteresis != null);
    const allE = n > 0 && fans.every(f => f.emergency_temp != null);
    document.getElementById("g-row-deadzone")?.classList.toggle("hidden", allDz);
    document.getElementById("g-row-hysteresis")?.classList.toggle("hidden", allH);
    document.getElementById("g-row-emergency")?.classList.toggle("hidden", allE);
}

function fillGlobalForm() {
    const g = config.global;
    const dz = document.getElementById("g-deadzone") as HTMLInputElement | null;
    if (dz) dz.value = String(g.pwm_deadzone);
    const hy = document.getElementById("g-hysteresis") as HTMLInputElement | null;
    if (hy) hy.value = String(g.stop_hysteresis);
    const em = document.getElementById("g-emergency") as HTMLInputElement | null;
    if (em) em.value = String(g.emergency_temp);
    ($("g-interval") as HTMLInputElement).value = String(Math.round(g.update_interval_ms / 1000));
    ($("g-stop-beh") as HTMLSelectElement).value = g.stop_behavior;
    ($("g-stop-pwm") as HTMLInputElement).value = String(g.stop_pwm);
    updateStopPWMRow();
    updateGlobalTuningRowVisibility();

    // 填充 CPU/GPU 传感器映射
    const cpuSensorValue = document.getElementById("cpu-sensor-value") as HTMLInputElement | null;
    if (cpuSensorValue) cpuSensorValue.value = g.cpu_sensor || "";
    const cpuSensorDisplay = document.getElementById("cpu-sensor-display");
    if (cpuSensorDisplay) {
        cpuSensorDisplay.textContent = g.cpu_sensor ? getSensorDisplayName(g.cpu_sensor) : "-- 使用默认检测 --";
    }

    const gpuSensorValue = document.getElementById("gpu-sensor-value") as HTMLInputElement | null;
    if (gpuSensorValue) gpuSensorValue.value = g.gpu_sensor || "";
    const gpuSensorDisplay = document.getElementById("gpu-sensor-display");
    if (gpuSensorDisplay) {
        gpuSensorDisplay.textContent = g.gpu_sensor ? getSensorDisplayName(g.gpu_sensor) : "-- 使用默认检测 --";
    }
}

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

function readSensorMgrIntoConfig() {
    const tbody = document.getElementById("sensor-mgr-tbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll<HTMLTableRowElement>("tr[data-sensor-id]");
    // 面板未打开或尚无传感器行时不要整表覆盖，否则会清空已保存的别名/隐藏列表
    if (rows.length === 0) return;

    const aliases: Record<string, string> = {...(config.global.sensor_aliases ?? {})};
    const hiddenSet = new Set(config.global.sensor_hidden ?? []);
    rows.forEach(row => {
        const id = row.dataset.sensorId!;
        const aliasInput = row.querySelector<HTMLInputElement>("input[data-sensor-alias]");
        const hiddenCb = row.querySelector<HTMLInputElement>("input[data-sensor-hidden]");
        const alias = aliasInput?.value.trim() ?? "";
        if (alias) aliases[id] = alias;
        else delete aliases[id];

        if (hiddenCb?.checked) hiddenSet.add(id);
        else hiddenSet.delete(id);
    });
    config.global.sensor_aliases = aliases;
    config.global.sensor_hidden = [...hiddenSet];
}

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

// 渲染 CPU/GPU 传感器选择菜单
function renderCPUGPUSensorMenu(type: "cpu" | "gpu"): string {
    const sensors = telemetry?.sensors ?? [];
    const current = type === "cpu" ? (config.global.cpu_sensor || "") : (config.global.gpu_sensor || "");
    const items = sensors.filter(s => !config.global.sensor_hidden?.includes(s.id));

    let html = `
<div class="px-3 py-2 text-xs text-slate-400 border-b border-slate-700/50">
    选择一个 hwmon 传感器作为${type === "cpu" ? "CPU" : "GPU"}温度源
</div>
<button type="button" data-sensor-value=""
        class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-700/70 ${!current ? "bg-slate-700/40" : ""}">
    <span class="${!current ? "text-sky-300 font-medium" : "text-slate-200"} truncate">使用默认检测</span>
    ${!current ? '<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>' : ""}
</button>`;

    for (const s of items) {
        const isSelected = s.id === current;
        const name = config.global.sensor_aliases?.[s.id] || s.label || s.key;
        const chipLabel = s.device ? `${s.chip}·${s.device}` : s.chip;
        const displayName = `${chipLabel}·${name}`;
        const tempText = s.temp != null ? `${s.temp.toFixed(1)}°C` : "—";

        html += `
<button type="button" data-sensor-value="${esc(s.id)}"
        class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-700/70 ${isSelected ? "bg-slate-700/40" : ""}">
    <span class="${isSelected ? "text-sky-300 font-medium" : "text-slate-200"} truncate">${esc(displayName)}</span>
    <span class="flex items-center gap-1 flex-shrink-0">
        <span class="${isSelected ? "text-sky-400" : "text-slate-400"} font-mono tabular-nums text-xs">${esc(tempText)}</span>
        ${isSelected ? '<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>' : ""}
    </span>
</button>`;
    }

    return html;
}

// 打开 CPU 传感器菜单
function openCPUSensorMenu() {
    const menu = document.getElementById("cpu-sensor-menu");
    const chevron = document.getElementById("cpu-sensor-chevron");
    if (!menu) return;
    menu.innerHTML = renderCPUGPUSensorMenu("cpu");
    menu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

// 关闭 CPU 传感器菜单
function closeCPUSensorMenu() {
    const menu = document.getElementById("cpu-sensor-menu");
    const chevron = document.getElementById("cpu-sensor-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

// 打开 GPU 传感器菜单
function openGPUSensorMenu() {
    const menu = document.getElementById("gpu-sensor-menu");
    const chevron = document.getElementById("gpu-sensor-chevron");
    if (!menu) return;
    menu.innerHTML = renderCPUGPUSensorMenu("gpu");
    menu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

// 关闭 GPU 传感器菜单
function closeGPUSensorMenu() {
    const menu = document.getElementById("gpu-sensor-menu");
    const chevron = document.getElementById("gpu-sensor-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

// 设置 CPU 传感器值
function setCPUSensor(value: string) {
    const input = document.getElementById("cpu-sensor-value") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("cpu-sensor-display");
    if (display) {
        display.textContent = value ? getSensorDisplayName(value) : "-- 使用默认检测 --";
    }
}

// 设置 GPU 传感器值
function setGPUSensor(value: string) {
    const input = document.getElementById("gpu-sensor-value") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("gpu-sensor-display");
    if (display) {
        display.textContent = value ? getSensorDisplayName(value) : "-- 使用默认检测 --";
    }
}

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

// 绑定 CPU/GPU 传感器下拉菜单事件
function bindCPUGPUSensorMenus() {
    // CPU 传感器按钮
    const cpuBtn = document.getElementById("cpu-sensor-btn");
    if (cpuBtn) {
        cpuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeGPUSensorMenu();
            openCPUSensorMenu();
        });
    }

    // GPU 传感器按钮
    const gpuBtn = document.getElementById("gpu-sensor-btn");
    if (gpuBtn) {
        gpuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeCPUSensorMenu();
            openGPUSensorMenu();
        });
    }

    // 点击外部关闭菜单
    document.addEventListener("click", () => {
        closeCPUSensorMenu();
        closeGPUSensorMenu();
    });

    // CPU 菜单项点击委托
    const cpuMenu = document.getElementById("cpu-sensor-menu");
    if (cpuMenu) {
        cpuMenu.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("button[data-sensor-value]");
            if (btn) {
                const value = btn.getAttribute("data-sensor-value") || "";
                setCPUSensor(value);
                closeCPUSensorMenu();
            }
        });
    }

    // GPU 菜单项点击委托
    const gpuMenu = document.getElementById("gpu-sensor-menu");
    if (gpuMenu) {
        gpuMenu.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("button[data-sensor-value]");
            if (btn) {
                const value = btn.getAttribute("data-sensor-value") || "";
                setGPUSensor(value);
                closeGPUSensorMenu();
            }
        });
    }
}

function updateStopPWMRow() {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    const row = $("g-stop-pwm-row");
    if (row) row.classList.toggle("hidden", stopBeh !== "set");
}

function clampPWM(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

function readGlobalForm(): GlobalConfig {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    const out: GlobalConfig = {
        ...config.global,
        update_interval_ms: Math.max(1000, Number(($("g-interval") as HTMLInputElement).value) * 1000) || 2000,
        stop_behavior: stopBeh === "set" ? "set" : "keep",
        stop_pwm: clampPWM(Number(($("g-stop-pwm") as HTMLInputElement).value) || 200),
    };
    const dzEl = document.getElementById("g-deadzone") as HTMLInputElement | null;
    const dzRow = document.getElementById("g-row-deadzone");
    if (dzEl && dzRow && !dzRow.classList.contains("hidden")) out.pwm_deadzone = clampPWM(Number(dzEl.value) || 0);
    const hyEl = document.getElementById("g-hysteresis") as HTMLInputElement | null;
    const hyRow = document.getElementById("g-row-hysteresis");
    if (hyEl && hyRow && !hyRow.classList.contains("hidden")) out.stop_hysteresis = Math.max(0, Number(hyEl.value) || 2);
    const emEl = document.getElementById("g-emergency") as HTMLInputElement | null;
    const emRow = document.getElementById("g-row-emergency");
    if (emEl && emRow && !emRow.classList.contains("hidden")) out.emergency_temp = Math.max(0, Number(emEl.value) || 80);

    // 读取 CPU/GPU 传感器映射
    const cpuSensorEl = document.getElementById("cpu-sensor-value") as HTMLInputElement | null;
    if (cpuSensorEl) out.cpu_sensor = cpuSensorEl.value.trim() || undefined;
    const gpuSensorEl = document.getElementById("gpu-sensor-value") as HTMLInputElement | null;
    if (gpuSensorEl) out.gpu_sensor = gpuSensorEl.value.trim() || undefined;

    return out;
}

function updateFallbackPolicyVisibility() {
    const pol = ($("fe-fallback-policy") as HTMLSelectElement).value;
    ($("fe-fallback-min-row") as HTMLElement).classList.toggle("hidden", pol !== "min_pwm");
    ($("fe-fallback-follow-row") as HTMLElement).classList.toggle("hidden", pol !== "follow_other");
}

let fanEditDialog = $<HTMLDialogElement>("fan-edit-dialog");

function safeCloseFanEditDialog() {
    fanEditDialog.close();
    closeFallbackSourceMenu();
    closeSourceMenu();
    editFanIdx = null;
    if (originalSourceMode !== null) {
        config.global.source_mode = originalSourceMode;
        originalSourceMode = null;
    }
}

function openFanEditDialogWithLock() {
    if (fanEditDialog.open) fanEditDialog.close();
    fanEditDialog.showModal();
    requestAnimationFrame(() => {
        const scrollArea = fanEditDialog.querySelector('.flex-1.min-h-0.overflow-y-auto');
        if (scrollArea) scrollArea.scrollTop = 0;
    });
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
    const isCombo = fan.source.startsWith("combo_avg:") || fan.source.startsWith("combo_max:");
    const displayMode: SourceMode = isCombo ? "advanced" : originalSourceMode;
    applySourceModeUI(displayMode);
    initFanCurveChartShell();
    loadCurveIntoEditor();
    const dzEl = $("fe-deadzone") as HTMLInputElement;
    dzEl.value = fan.pwm_deadzone != null ? String(fan.pwm_deadzone) : "";
    dzEl.placeholder = `留空=默认${config.global.pwm_deadzone}`;
    const hysEl = $("fe-hysteresis") as HTMLInputElement;
    hysEl.value = fan.stop_hysteresis != null ? String(fan.stop_hysteresis) : "";
    hysEl.placeholder = `留空=默认${config.global.stop_hysteresis}`;
    const emEl = $("fe-emergency") as HTMLInputElement;
    emEl.value = fan.emergency_temp != null ? String(fan.emergency_temp) : "";
    emEl.placeholder = `留空=默认${config.global.emergency_temp}`;
    const polRaw = fan.fallback_policy;
    const pol = (polRaw === "stop" || polRaw === "min_pwm" || polRaw === "full_speed" || polRaw === "follow_other") ? polRaw : "keep_last";
    ($("fe-fallback-policy") as HTMLSelectElement).value = pol;
    ($("fe-fallback-min-pwm") as HTMLInputElement).value = (fan.fallback_min_pwm != null && fan.fallback_min_pwm > 0) ? String(fan.fallback_min_pwm) : "80";
    setFallbackSourceValue((fan.fallback_follow_source ?? "").trim() || "cpu");
    closeFallbackSourceMenu();
    updateFallbackPolicyVisibility();
    openFanEditDialogWithLock();
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
    const dz = ($("fe-deadzone") as HTMLInputElement).value.trim();
    if (dz === "") delete fan.pwm_deadzone;
    else {
        const n = Number(dz);
        if (Number.isFinite(n)) fan.pwm_deadzone = clampPWM(n); else delete fan.pwm_deadzone;
    }
    const hy = ($("fe-hysteresis") as HTMLInputElement).value.trim();
    if (hy === "") delete fan.stop_hysteresis;
    else {
        const n = Number(hy);
        if (Number.isFinite(n)) fan.stop_hysteresis = Math.max(0, Math.min(30, n)); else delete fan.stop_hysteresis;
    }
    const em = ($("fe-emergency") as HTMLInputElement).value.trim();
    if (em === "") delete fan.emergency_temp;
    else {
        const n = Number(em);
        if (Number.isFinite(n)) fan.emergency_temp = Math.max(1, Math.min(120, n)); else delete fan.emergency_temp;
    }
    const pol = ($("fe-fallback-policy") as HTMLSelectElement).value;
    if (pol === "keep_last") {
        delete fan.fallback_policy;
        delete fan.fallback_min_pwm;
        delete fan.fallback_follow_source;
    } else {
        fan.fallback_policy = pol;
        if (pol === "min_pwm") {
            const n = Number(($("fe-fallback-min-pwm") as HTMLInputElement).value);
            fan.fallback_min_pwm = Number.isFinite(n) ? clampPWM(n) : 80;
            if (fan.fallback_min_pwm <= 0) fan.fallback_min_pwm = 80;
        } else delete fan.fallback_min_pwm;
        if (pol === "follow_other") fan.fallback_follow_source = ($("fe-fb-source") as HTMLInputElement).value.trim() || "cpu";
        else delete fan.fallback_follow_source;
    }
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
                toast(String(e), "error");
            }
        }
    });
}

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
    return !!document.getElementById("fe-source-menu")?.classList.contains("hidden") === false;
}

function openFallbackSourceMenu() {
    const menu = document.getElementById("fe-fb-source-menu");
    const chevron = document.getElementById("fe-fb-source-chevron");
    if (menu) {
        menu.classList.remove("hidden");
        menu.scrollTop = 0;
    }
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

function closeFallbackSourceMenu() {
    const menu = document.getElementById("fe-fb-source-menu");
    const chevron = document.getElementById("fe-fb-source-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

function isFallbackSourceMenuOpen(): boolean {
    return !!document.getElementById("fe-fb-source-menu")?.classList.contains("hidden") === false;
}

function bindSourceDropdown() {
    const btn = document.getElementById("fe-source-btn");
    const menu = document.getElementById("fe-source-menu");
    const wrapper = document.getElementById("fe-source-wrapper");
    if (!btn || !menu || !wrapper) return;
    btn.addEventListener("click", ev => {
        ev.stopPropagation();
        if (isSourceMenuOpen()) closeSourceMenu();
        else {
            closeFallbackSourceMenu();
            const mode = resolveSourceMode();
            const input = document.getElementById("fe-source") as HTMLInputElement | null;
            menu.innerHTML = renderSourceOptions(input?.value ?? "", mode);
            openSourceMenu();
        }
    });
    menu.addEventListener("click", ev => {
        const target = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-value]");
        if (target) {
            const v = target.dataset.sourceValue;
            if (v !== undefined) {
                setSourceValue(v);
                const mode = resolveSourceMode();
                menu.innerHTML = renderSourceOptions(v, mode);
                closeSourceMenu();
            }
            return;
        }
        const confirm = (ev.target as HTMLElement).closest("[data-combo-confirm]") as HTMLButtonElement | null;
        if (confirm && !confirm.disabled) {
            const src = buildComboSourceFromPanel(menu);
            if (src) {
                setSourceValue(src);
                closeSourceMenu();
            }
        }
    });
    menu.addEventListener("change", ev => {
        const t = ev.target as HTMLInputElement;
        if (t.dataset.comboCb !== undefined || (t.type === "radio" && t.name.startsWith("combo-strat"))) updateComboPreview(menu);
    });
    document.addEventListener("click", ev => {
        if (isSourceMenuOpen() && !wrapper.contains(ev.target as Node)) closeSourceMenu();
    });
    document.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && isSourceMenuOpen()) {
            closeSourceMenu();
            ev.stopPropagation();
        }
    });
}

function bindFallbackSourceDropdown() {
    const btn = document.getElementById("fe-fb-source-btn");
    const menu = document.getElementById("fe-fb-source-menu");
    const wrapper = document.getElementById("fe-fb-source-wrapper");
    if (!btn || !menu || !wrapper) return;
    btn.addEventListener("click", ev => {
        ev.stopPropagation();
        if (isFallbackSourceMenuOpen()) closeFallbackSourceMenu();
        else {
            closeSourceMenu();
            const mode = resolveSourceMode();
            const input = document.getElementById("fe-fb-source") as HTMLInputElement | null;
            menu.innerHTML = renderSourceOptions(input?.value ?? "", mode, "combo-strategy-fb");
            openFallbackSourceMenu();
        }
    });
    menu.addEventListener("click", ev => {
        const target = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-value]");
        if (target) {
            const v = target.dataset.sourceValue;
            if (v !== undefined) {
                setFallbackSourceValue(v);
                const mode = resolveSourceMode();
                menu.innerHTML = renderSourceOptions(v, mode, "combo-strategy-fb");
                closeFallbackSourceMenu();
            }
            return;
        }
        const confirm = (ev.target as HTMLElement).closest("[data-combo-confirm]") as HTMLButtonElement | null;
        if (confirm && !confirm.disabled) {
            const src = buildComboSourceFromPanel(menu);
            if (src) {
                setFallbackSourceValue(src);
                closeFallbackSourceMenu();
            }
        }
    });
    menu.addEventListener("change", ev => {
        const t = ev.target as HTMLInputElement;
        if (t.dataset.comboCb !== undefined || (t.type === "radio" && t.name.startsWith("combo-strat"))) updateComboPreview(menu);
    });
    document.addEventListener("click", ev => {
        if (isFallbackSourceMenuOpen() && !wrapper.contains(ev.target as Node)) closeFallbackSourceMenu();
    });
    document.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && isFallbackSourceMenuOpen()) {
            closeFallbackSourceMenu();
            ev.stopPropagation();
        }
    });
}

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

function fanIdentityTaken(chip: string, device: string, pwmIndex: number): boolean {
    return config.fans.some(
        f => f.chip === chip && f.device === device && f.pwm_index === pwmIndex
    )
}

async function runHardwareScan() {
    const status = $("scan-status");
    status.textContent = "正在扫描…";
    try {
        lastScanResults = await fetchScanFans();
        status.textContent = `共发现 ${lastScanResults?.length ?? 0} 个 PWM 通道`;
        renderScanTable();
    } catch (e) {
        status.textContent = `扫描失败：${String(e)}`;
        ($("scan-fans-tbody") as HTMLElement).innerHTML = "";
    }
}

function renderScanTable() {
    const tbody = $("scan-fans-tbody") as HTMLElement;
    tbody.innerHTML = lastScanResults.map((s, i) => {
        const pwmIndex = Number(s.pwm_index)
        const taken = fanIdentityTaken(s.chip, s.device, pwmIndex);
        return `
<tr class="border-b border-slate-800 ${taken ? "opacity-50" : ""}">
  <td class="p-2 align-top"><input type="checkbox" data-scan-idx="${i}" class="scan-cb rounded border-slate-600" ${taken ? "disabled" : ""} /></td>
  <td class="p-2 align-top text-slate-300">${esc(s.name)}<div class="text-[10px] text-slate-500 font-mono mt-1">${esc(s.id)}</div></td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.pwm_path)}</td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.rpm_path || "—")}</td>
</tr>`;
    }).join("");
}

async function addScannedFansFromSelection() {
    const boxes = document.querySelectorAll<HTMLInputElement>(".scan-cb:checked:not(:disabled)");
    const newFans: FanConfig[] = [];
    let n = 0;
    boxes.forEach(box => {
        const i = Number(box.dataset.scanIdx);
        const s = lastScanResults[i];
        const pwmIndex = Number(s.pwm_index)
        if (!s || !s.chip || !Number.isFinite(pwmIndex) || pwmIndex <= 0) return;
        if (fanIdentityTaken(s.chip, s.device, pwmIndex)) return;
        let id = s.id;
        if (config.fans.some(f => f.id === id)) id = `${s.id}-${Date.now().toString(36)}`;
        const fan: FanConfig = {
            id,
            name: s.name,
            pwm_path: s.pwm_path,
            rpm_path: s.rpm_path,
            enable_path: s.enable_path,
            chip: s.chip,
            device: s.device,
            pwm_index: Number(s.pwm_index),
            mode: "curve",
            source: "cpu",
            manual_pwm: 120,
            curve: DEFAULT_CURVE.map(c => ({...c})),
            // 从全局配置读取当前值，显式写入风扇配置
            pwm_deadzone: config.global.pwm_deadzone,
            stop_hysteresis: config.global.stop_hysteresis,
            emergency_temp: config.global.emergency_temp,
        };
        newFans.push(fan);
        n++;
    });
    if (n === 0) {
        toast("请勾选尚未加入配置的项。", "info");
        return;
    }
    try {
        // 先保存到服务端
        const tempConfig = {...config, fans: [...config.fans, ...newFans]};
        await saveConfig(tempConfig);
        // 保存成功后才更新本地配置
        config = tempConfig;
        ($("scan-fans-dialog") as HTMLDialogElement).close();
        await refresh();
        toast(`已添加 ${n} 个风扇并已保存到服务端。`, "success");
    } catch (e: any) {
        const msg = e.response?.data?.error || e.message || "保存失败，请检查权限或网络";
        toast(msg, "error");
    }
}

async function refresh() {
    const [info, cfg] = await Promise.all([fetchInfo(), fetchConfig()]);
    config = cfg;
    applyTelemetry(info);
    fillGlobalForm();
    applyHistoryPrefsFromConfig();
    renderHistorySensorToggles();
    renderHistoryFanToggles();
    loadHistoryChart().catch(console.error);
}

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_THROTTLE_MS = 2500;

let lastUpdateResult: UpdateCheckResult | null = null;
let lastUpdateCheckAt = 0;
let updateCheckInFlight = false;
let lastManualCheckAt = 0;

function applyUpdateCheckResult(res: UpdateCheckResult, opts?: { toastOnResult?: boolean }) {
    lastUpdateResult = res;
    lastUpdateCheckAt = Date.now();
    const btn = document.getElementById("btn-update-available") as HTMLButtonElement | null;
    if (btn) {
        btn.classList.toggle("hidden", !res.has_update);
    }
    if (opts?.toastOnResult) {
        if (!res.check_ok) {
            toast(res.error || "检查更新失败", "error");
        } else if (res.has_update) {
            toast(`发现新版本 v${res.latest || "?"}`, "success");
        } else {
            toast("当前已是最新版本", "info");
        }
    }
}

function openUpdateNotesDialog() {
    const res = lastUpdateResult;
    if (!res?.has_update) return;
    const dialog = document.getElementById("update-notes-dialog") as HTMLDialogElement | null;
    const title = document.getElementById("update-notes-title");
    const body = document.getElementById("update-notes-body");
    const link = document.getElementById("update-notes-link") as HTMLAnchorElement | null;
    if (!dialog || !title || !body || !link) return;
    title.textContent = `新版本 v${res.latest || "?"}`;
    body.textContent = (res.notes && res.notes.trim()) ? res.notes : "暂无更新说明";
    if (res.url) {
        link.href = res.url;
        link.classList.remove("hidden");
    } else {
        link.href = "#";
        link.classList.add("hidden");
    }
    dialog.showModal();
}

async function runUpdateCheck(force: boolean, toastOnResult: boolean) {
    if (updateCheckInFlight) return;
    updateCheckInFlight = true;
    const btn = document.getElementById("btn-check-update") as HTMLButtonElement | null;
    if (btn && force) btn.disabled = true;
    try {
        const res = await checkUpdate(force);
        applyUpdateCheckResult(res, {toastOnResult});
    } catch (e) {
        console.error("[更新检查]", e);
        if (toastOnResult) toast("检查更新失败", "error");
    } finally {
        updateCheckInFlight = false;
        if (btn && force) btn.disabled = false;
    }
}

function setupUpdateCheck() {
    const availableBtn = document.getElementById("btn-update-available");
    const checkBtn = document.getElementById("btn-check-update") as HTMLButtonElement | null;
    const dialog = document.getElementById("update-notes-dialog") as HTMLDialogElement | null;
    availableBtn?.addEventListener("click", () => openUpdateNotesDialog());
    checkBtn?.addEventListener("click", () => {
        const now = Date.now();
        if (now - lastManualCheckAt < UPDATE_CHECK_THROTTLE_MS) return;
        lastManualCheckAt = now;
        void runUpdateCheck(true, true);
    });
    document.getElementById("update-notes-close")?.addEventListener("click", () => dialog?.close());
    document.getElementById("update-notes-ok")?.addEventListener("click", () => dialog?.close());

    void runUpdateCheck(false, false);
    window.setInterval(() => {
        void runUpdateCheck(false, false);
    }, UPDATE_CHECK_INTERVAL_MS);

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
        void runUpdateCheck(false, false);
    });
}

async function main() {
    updateSubtitleDate();
    window.setInterval(updateSubtitleDate, 1000);

    await initAuthMode();
    setupUpdateCheck();

    const refreshBtn = $("btn-refresh") as HTMLButtonElement;
    const refreshIcon = $("btn-refresh-icon");
    refreshBtn.addEventListener("click", async () => {
        if (refreshBtn.disabled) return;
        refreshBtn.disabled = true;
        refreshIcon.classList.add("animate-spin");
        try {
            await refresh();
        } catch (e) {
            console.error(e);
            toast("刷新失败，请检查网络或权限", "error");
        } finally {
            refreshIcon.classList.remove("animate-spin");
            refreshBtn.disabled = false;
        }
    });

    const donateDialog = $("donate-dialog") as HTMLDialogElement;
    $("btn-donate").addEventListener("click", () => donateDialog.showModal());
    $("donate-close").addEventListener("click", () => donateDialog.close());
    donateDialog.addEventListener("click", e => {
        if (e.target === donateDialog) donateDialog.close();
    });

    document.getElementById("curve-point-edit-form")?.addEventListener("submit", ev => {
        const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === "ok") {
            applyCurvePointEditFromDialog();
        } else {
            editingCurvePointIndex = -1;
        }
    });
    document.getElementById("curve-point-edit-dialog")?.addEventListener("cancel", () => {
        editingCurvePointIndex = -1;
    });

    $("btn-scan-fans").addEventListener("click", () => {
        ($("scan-fans-dialog") as HTMLDialogElement).showModal();
        runHardwareScan().catch(console.error);
    });
    $("scan-close").addEventListener("click", () => ($("scan-fans-dialog") as HTMLDialogElement).close());
    $("scan-refresh").addEventListener("click", () => runHardwareScan().catch(console.error));
    $("scan-add-selected").addEventListener("click", () => addScannedFansFromSelection().catch(console.error));

    $("btn-global-save").addEventListener("click", async () => {
        const originalGlobal = JSON.parse(JSON.stringify(config.global));

        readSensorMgrIntoConfig();
        config.global = readGlobalForm();
        syncHistoryPrefsToConfig();

        try {
            await setGlobalConfig(config.global);
            toast("全局设置已保存", "success");
            await refresh();
        } catch (e: any) {
            config.global = originalGlobal;
            const msg = e.response?.data?.error || e.message || "保存失败，请检查权限或网络";
            toast(msg, "error");
            await refresh();
            return;
        }
    });
    $("btn-global-discard").addEventListener("click", () => refresh().catch(console.error));
    $("g-stop-beh").addEventListener("change", updateStopPWMRow);


    const closeBtn = document.getElementById("fe-close");
    if (closeBtn) {
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode?.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            safeCloseFanEditDialog();
        });
    }
    const cancelBtn = document.getElementById("fe-cancel");
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode?.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            safeCloseFanEditDialog();
        });
    }
    fanEditDialog.addEventListener("cancel", e => {
        e.preventDefault();
        safeCloseFanEditDialog();
    });
    fanEditDialog.addEventListener("close", () => {
        closeFallbackSourceMenu();
        closeSourceMenu();
        editFanIdx = null;
        if (originalSourceMode !== null) {
            config.global.source_mode = originalSourceMode;
            originalSourceMode = null;
        }
    });
    $("fe-save").addEventListener("click", async () => {
        const originalConfig = JSON.parse(JSON.stringify(config));

        syncCurveToConfig();
        const fan = readFanFormIntoConfig();
        if (!fan) return;

        try {
            await saveConfig(config);
            // 曲线已随 saveConfig 写入；勿再调 setFanCurve（会强制改成自动模式）
            originalSourceMode = null;
            editFanIdx = null;
            syncFanCardsFromTelemetryOrRender();
            // 改名后同步历史曲线图例、下拉与系列名称
            renderHistoryFanToggles();
            updateHistoryChart();
            safeCloseFanEditDialog();
            toast("已保存", "success");
        } catch (e: any) {
            config = originalConfig;
            const msg = e.response?.data?.error || e.message || "保存失败，请检查权限或网络";
            toast(msg, "error");
            safeCloseFanEditDialog();
            await refresh();
        }
    });

    ($("fe-fallback-policy") as HTMLSelectElement).addEventListener("change", updateFallbackPolicyVisibility);

    bindFanRoot();
    bindSourceModeSwitcher();
    bindSourceDropdown();
    bindFallbackSourceDropdown();
    bindCollapsible("fan-params-toggle", "fan-params-panel", "fan-params-chevron", updateGlobalTuningRowVisibility);
    bindCollapsible("sensor-mgr-toggle", "sensor-mgr-panel", "sensor-mgr-chevron", renderSensorMgrTable);
    bindCollapsible("cpu-gpu-sensor-toggle", "cpu-gpu-sensor-panel", "cpu-gpu-sensor-chevron");
    bindCPUGPUSensorMenus();
    initHistoryChart();
    updateDiskSerialToggleIcon();
    $("disk-serial-toggle").addEventListener("click", () => setDiskSerialVisible(!showDiskSerial));

    await refresh();
    const legacy = config.fans.filter(f => !f.chip);
    if (legacy.length > 0) {
        toast(`检测到 ${legacy.length} 个旧版本风扇配置缺少稳定标识，建议删除后重新扫描添加避免重启错乱`, "info")
    }

    let ws: WebSocket | null = null;
    let wsRetryDelay = 1500;   // 初始重连延迟
    const wsMaxDelay = 30000;  // 最大重连延迟

    function connectWs() {
        if (ws) ws.close();
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const base = import.meta.env.BASE_URL.replace(/\/$/, "");
        const wsPath = `${base}/api/ws`;
        ws = new WebSocket(`${proto}//${window.location.host}${wsPath}`);
        ws.addEventListener("open", () => {
            wsRetryDelay = 1500; // 连接成功后重置延迟
            $("ws-text").textContent = "已连接";
            ($("ws-text") as HTMLElement).className = "text-sky-400 text-sm font-mono";
        });
        ws.addEventListener("message", ev => {
            try {
                applyTelemetry(JSON.parse(ev.data) as Telemetry);
            } catch { /* ignore */
            }
        });
        ws.addEventListener("close", () => {
            $("ws-text").textContent = "重连中…";
            ($("ws-text") as HTMLElement).className = "text-amber-400 text-sm font-mono";
            const delay = wsRetryDelay;
            wsRetryDelay = Math.min(wsRetryDelay * 2, wsMaxDelay); // 指数退避
            window.setTimeout(connectWs, delay);
        });
    }

    connectWs();
}

main().catch(err => {
    console.error(err);
    toast(`启动失败: ${err}`, "error");
});