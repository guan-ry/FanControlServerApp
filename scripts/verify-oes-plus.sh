#!/usr/bin/env bash
# 只读检查 OES Plus 是否满足 thermal_binary 控制条件。
set -u

fail=0
pass() { printf '[PASS] %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; }
fail_msg() { printf '[FAIL] %s\n' "$1"; fail=1; }

arch="$(uname -m 2>/dev/null || true)"
[[ "$arch" == "aarch64" ]] && pass "CPU 架构为 aarch64" || fail_msg "CPU 架构不是 aarch64：${arch:-unknown}"

model="$(tr '\0' '\n' </proc/device-tree/model 2>/dev/null | head -n 1)"
[[ "$model" == *"OES Plus"* ]] && pass "设备型号：$model" || warn "设备型号不是已验证的 OES Plus：${model:-unknown}"

fan_hwmon=""
for h in /sys/class/hwmon/hwmon*; do
    [[ -f "$h/name" ]] || continue
    [[ "$(cat "$h/name" 2>/dev/null)" == "gpio_fan" ]] || continue
    fan_hwmon="$h"
    break
done

if [[ -z "$fan_hwmon" ]]; then
    fail_msg "未发现 gpio_fan hwmon"
else
    pass "发现 gpio_fan：$fan_hwmon"
    [[ -r "$fan_hwmon/pwm1" && -w "$fan_hwmon/pwm1" ]] \
        && pass "pwm1 可读写" || fail_msg "pwm1 不可读写"
    [[ -r "$fan_hwmon/fan1_input" ]] \
        && pass "发现 fan1_input（GPIO 风扇上通常是标称值）" || warn "未发现 fan1_input"
fi

fan_cdev=""
for d in /sys/class/thermal/cooling_device*; do
    [[ -f "$d/type" ]] || continue
    [[ "$(cat "$d/type" 2>/dev/null)" == "gpio-fan" ]] || continue
    fan_cdev="$d"
    break
done

if [[ -z "$fan_cdev" ]]; then
    fail_msg "未发现 gpio-fan cooling device"
else
    max_state="$(cat "$fan_cdev/max_state" 2>/dev/null || true)"
    [[ "$max_state" == "1" ]] \
        && pass "风扇为二态 cooling device，max_state=1" \
        || fail_msg "风扇不是预期的二态设备，max_state=${max_state:-unknown}"
fi

binding_found=0
for z in /sys/class/thermal/thermal_zone*; do
    [[ -d "$z" ]] || continue
    for link in "$z"/cdev[0-9]*; do
        [[ -L "$link" ]] || continue
        [[ "$(readlink -f "$link")" == "$(readlink -f "$fan_cdev" 2>/dev/null)" ]] || continue
        base="$(basename "$link")"
        trip_index="$(cat "$z/${base}_trip_point" 2>/dev/null || true)"
        [[ "$trip_index" =~ ^[0-9]+$ ]] || continue
        prefix="$z/trip_point_${trip_index}"
        [[ "$(cat "${prefix}_type" 2>/dev/null)" == "active" ]] || continue
        binding_found=1
        pass "风扇绑定到 active trip：${prefix}_temp"
        printf '       zone=%s policy=%s trip=%s hyst=%s\n' \
            "$(cat "$z/type" 2>/dev/null)" \
            "$(cat "$z/policy" 2>/dev/null)" \
            "$(cat "${prefix}_temp" 2>/dev/null)" \
            "$(cat "${prefix}_hyst" 2>/dev/null)"
    done
done
[[ "$binding_found" -eq 1 ]] || fail_msg "未找到 gpio-fan 与 active trip 的绑定"

if [[ "$fail" -eq 0 ]]; then
    echo "OES Plus thermal_binary 控制条件满足。"
else
    echo "检查未通过，请不要启用应用接管。" >&2
fi
exit "$fail"
