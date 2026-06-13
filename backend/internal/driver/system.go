package driver

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type SystemDriver struct {
	prevIdle  uint64
	prevTotal uint64
}

func NewSystemDriver() *SystemDriver {
	return &SystemDriver{}
}

func (d *SystemDriver) CPUUsage() (float64, error) {
	content, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, err
	}
	line := strings.Split(string(content), "\n")[0]
	fields := strings.Fields(line)
	if len(fields) < 8 {
		return 0, errors.New("无效的 /proc/stat 格式")
	}
	var nums []uint64
	for _, f := range fields[1:] {
		v, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return 0, err
		}
		nums = append(nums, v)
	}
	idle := nums[3] + nums[4]
	total := uint64(0)
	for _, v := range nums {
		total += v
	}
	if d.prevTotal == 0 || total < d.prevTotal || idle < d.prevIdle {
		d.prevIdle, d.prevTotal = idle, total
		return 0, nil
	}
	deltaIdle := idle - d.prevIdle
	deltaTotal := total - d.prevTotal
	d.prevIdle, d.prevTotal = idle, total
	if deltaTotal == 0 {
		return 0, nil
	}
	return 100 * (1 - float64(deltaIdle)/float64(deltaTotal)), nil
}

// MemInfo 一次读取 /proc/meminfo，返回内存使用率（%）和总量（GB）。
func (d *SystemDriver) MemInfo() (usage float64, totalGB *float64, err error) {
	content, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, nil, err
	}
	values := map[string]float64{}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(strings.ReplaceAll(line, ":", ""))
		if len(fields) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			continue
		}
		values[fields[0]] = v
	}
	total := values["MemTotal"]
	if total == 0 {
		return 0, nil, errors.New("无效的 /proc/meminfo 数据")
	}
	available := values["MemAvailable"]
	gb := total / 1024 / 1024
	return 100 * (1 - available/total), &gb, nil
}

func (d *SystemDriver) CPUTemp() (*float64, error) {
	// 1. 获取所有 hwmon 目录
	dirs, err := filepath.Glob("/sys/class/hwmon/hwmon*")
	if err != nil {
		return nil, err
	}

	var best *float64

	for _, dir := range dirs {
		// 动态检测驱动名称，防止误读硬盘/主板温度
		namePath := filepath.Join(dir, "name")
		nameRaw, err := os.ReadFile(namePath)
		if err != nil {
			continue
		}
		driverName := strings.TrimSpace(string(nameRaw))

		// 明确是否为 CPU/SoC 温度驱动。x86 常见 coretemp/k10temp/zenpower，
		// ARM/OES Plus 常见 cpu_thermal/soc_thermal/cpu-thermal。
		isCPU := driverName == "coretemp" ||
			driverName == "k10temp" ||
			driverName == "zenpower" ||
			driverName == "cpu_thermal" ||
			driverName == "soc_thermal" ||
			driverName == "cpu-thermal" ||
			driverName == "soc-thermal"

		// 遍历当前目录下的所有温度通道
		inputs, _ := filepath.Glob(filepath.Join(dir, "temp*_input"))
		for _, p := range inputs {
			// 获取输入文件的编号，例如从 "temp1_input" 提取出 "temp1"
			baseName := filepath.Base(p)                      // "temp1_input"
			currentChannel := strings.Split(baseName, "_")[0] // "temp1"

			labelPath := filepath.Join(dir, currentChannel+"_label")
			label := ""
			if raw, err := os.ReadFile(labelPath); err == nil {
				label = strings.ToLower(strings.TrimSpace(string(raw)))
			}

			// --- 核心修复：精准温度过滤逻辑 ---
			if isCPU {
				// 如果是原生 CPU 驱动，但有标签，我们只想要 Package/总温，过滤掉单个独立核心
				// 增加了 tctl 关键字支持 AMD
				if label != "" && !strings.Contains(label, "package") && !strings.Contains(label, "cpu") && !strings.Contains(label, "tdie") && !strings.Contains(label, "tctl") {
					continue
				}
				// 如果 label 为空，默认信任 temp1_input (通常是主通道)，其余没有 label 的副通道略过
				if label == "" && currentChannel != "temp1" {
					continue
				}
			} else {
				// 如果不是原生 CPU 驱动（如主板 ACPI），只有当标签明确写了 "cpu" 时才允许采用
				// 这彻底杜绝了无标签的硬盘/主板温度参与比大小，解决了“温度与其他软件不一致”的问题
				if label == "" || !strings.Contains(label, "cpu") {
					continue
				}
			}

			// 读取温度值
			raw, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			value, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
			if err != nil {
				continue
			}
			temp := value / 1000.0
			if temp <= 0 || temp > 120 {
				continue
			}

			// 记录最高温度 (通常 Package/Tctl 代表整颗 CPU 的最高温状态)
			if best == nil || temp > *best {
				v := temp
				best = &v
			}
		}
	}

	// 2. 兜底逻辑：如果 hwmon 没找到任何 CPU 温度（常见于虚拟机、ARM 设备或老旧服务器）
	// 尝试读取标准的 thermal_zone0
	if best == nil {
		if raw, err := os.ReadFile("/sys/class/thermal/thermal_zone0/temp"); err == nil {
			if value, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64); err == nil {
				temp := value / 1000.0
				if temp > 0 && temp <= 120 {
					best = &temp
				}
			}
		}
	}

	return best, nil
}
