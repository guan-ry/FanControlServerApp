# OES Plus ARM64 适配说明

## 已验证硬件模型

本适配针对 OneThing Cloud OES Plus，系统为 aarch64/arm64 fnOS。已验证的内核接口如下。

- CPU 温区通过 `cpu_thermal` 和 `thermal_zone0` 暴露
- 风扇驱动为标准 Linux `gpio_fan`
- 风扇 cooling device 的 `max_state=1`
- 设备树 speed-map 只有 `0 RPM` 和 `3000 RPM`
- CPU active trip 默认 60°C，固定回差 5°C
- thermal policy 为 `step_wise`

因此该风扇是开关型二态风扇，不支持真正的 0–255 连续调速。`fan1_input=3000` 是设备树档位的标称值，不等于测速线实时反馈。

## 控制原则

普通 x86/ARM PWM 风扇仍使用原有 `pwm1` 控制。检测到满足以下条件的设备时，后端将其识别为 `thermal_binary`。

1. hwmon 名称和 cooling device 类型可归一化为同一个 `gpio-fan`
2. cooling device 的 `max_state` 为 1
3. cooling device 绑定到某个 thermal zone 的 `active` trip

`thermal_binary` 不直接持续写 `pwm1`，因为 `step_wise` governor 会在下一次轮询时覆盖它。程序改为调整绑定的 `trip_point_N_temp`，实际启停仍由内核完成。

## 模式语义

### 曲线模式

曲线中第一个 PWM 大于 0 的点，其温度被解释为风扇开启温度。允许范围限制为 40～75°C。OES Plus 的关闭温度由内核固定回差决定，即开启温度减 5°C。

默认值为 60°C 开启、约 55°C 关闭。

### 手动模式

- 手动值大于 0，设置 active trip 为 40°C，相当于常开
- 手动值等于 0，恢复程序启动时记录的系统 active trip，不提供危险的强制关闭模式

### 退出和异常

正常停止或从配置中移除风扇时，程序恢复启动时记录的 active trip。若进程异常崩溃，内核 `step_wise` 仍保持运行，并继续按照最后一个受限在 40～75°C 的阈值控制风扇。

不要把 thermal zone 的 policy 改为 `user_space`，也不要禁用 thermal zone。否则应用异常时可能失去内核兜底。

## 构建 ARM64 安装包

构建机需要 Go 1.24+、Node.js 18+、npm 和 fnpack。

```bash
chmod +x scripts/build-arm64.sh
./scripts/build-arm64.sh
```

脚本执行期间会临时把 manifest 的 `platform` 改为 `arm`，后端使用 `GOARCH=arm64` 编译。脚本退出时会自动恢复原 manifest。

产物位于：

```text
dist/*.fpk
```

OES Plus 本机已经有 fnpack 但没有 Go 和 Node.js 时，可以在另一台 Linux 构建机完成全部构建，或先构建前端和 ARM64 后端，再把完整应用目录放到有 fnpack 的 fnOS 环境打包。

## 安装前检查

```bash
sudo ./scripts/verify-oes-plus.sh
```

该脚本只读取系统信息，不改变风扇状态。

## 安装后检查

```bash
cat /sys/class/thermal/thermal_zone0/policy
cat /sys/class/thermal/thermal_zone0/mode
cat /sys/class/thermal/thermal_zone0/trip_point_3_temp
cat /sys/class/hwmon/hwmon2/pwm1
cat /sys/class/hwmon/hwmon2/fan1_input
```

预期 policy 仍为 `step_wise`，mode 仍为 `enabled`。实际 hwmon 和 trip 编号可能因启动顺序变化，程序不会硬编码 `hwmon2`、`cooling_device2` 或 `trip_point_3`。

## 前端兼容说明

后端向配置和遥测返回以下字段。

```text
control_type = thermal_binary
rpm_is_nominal = true
```

`scripts/build-arm64.sh` 会在前端构建期间临时注入 `oes-plus-ui.ts`，并在构建结束后恢复原始 `main.ts`。增强层只作用于 `thermal_binary` 风扇。

- 手动滑块改为“系统温控 / 常开”两态
- 3000 RPM 标记为“标称 RPM”
- 温度源固定显示为 CPU thermal 和内核 `step_wise`
- 曲线编辑器提示第一个非零点就是开启温度

曲线图仍沿用原项目的 PWM 坐标组件，但后端只读取首个非零点的温度，其余 PWM 高度不会产生不同转速档位。
