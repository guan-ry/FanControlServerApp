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
	paths, err := filepath.Glob("/sys/class/hwmon/hwmon*/temp*_input")
	if err != nil {
		return nil, err
	}
	var best *float64
	for _, p := range paths {
		labelPath := strings.TrimSuffix(p, "_input") + "_label"
		label := ""
		if raw, err := os.ReadFile(labelPath); err == nil {
			label = strings.ToLower(strings.TrimSpace(string(raw)))
		}
		if label == "" {
			continue
		}
		if !strings.Contains(label, "package") && !strings.Contains(label, "cpu") && !strings.Contains(label, "tdie") {
			continue
		}
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
		if best == nil || temp > *best {
			v := temp
			best = &v
		}
	}
	return best, nil
}
