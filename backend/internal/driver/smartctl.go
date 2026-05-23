package driver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"fancontrolserver/internal/model"
)

var (
	reTempWithParen = regexp.MustCompile(`\s+([0-9]{1,3})\s*\(`)
	reTempEndOfLine = regexp.MustCompile(`([0-9]{1,3})\s*$`)
	reTempColon     = regexp.MustCompile(`:\s+([0-9]{1,3})`)
)

type SmartCtlDriver struct{}

func NewSmartCtlDriver() *SmartCtlDriver {
	return &SmartCtlDriver{}
}

func (d *SmartCtlDriver) ScanDisks() ([]string, error) {
	var names []string
	entries, err := os.ReadDir("/sys/block")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case strings.HasPrefix(name, "loop"), strings.HasPrefix(name, "ram"), strings.HasPrefix(name, "dm-"), strings.HasPrefix(name, "sr"), strings.HasPrefix(name, "md"):
			continue
		default:
			// 过滤虚拟设备和 raid 设备
			if _, err = os.Stat(filepath.Join("/dev", name)); err == nil {
				// 检查是否是物理硬盘 (sd*, nvme*, vd*)
				if strings.HasPrefix(name, "sd") || strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "vd") {
					names = append(names, name)
				}
			}
		}
	}
	sort.Strings(names)
	return names, nil
}

func (d *SmartCtlDriver) ReadDisk(name string) model.DiskInfo {
	isNVMe := strings.HasPrefix(name, "nvme")
	device := "/dev/" + name

	// 先检查是否休眠（不会唤醒硬盘）
	isSleep := d.checkStandby(device)
	if isSleep {
		return model.DiskInfo{Name: name, Status: model.DiskStatusSleep}
	}

	// 只有非休眠状态才读取温度（可能轻微唤醒，但硬盘本来就是活跃的）
	var temp *float64
	if isNVMe {
		temp = d.readNVMeTemp(device)
	} else {
		temp = d.readSATATemp(device)
	}

	if temp == nil {
		return model.DiskInfo{Name: name, Status: model.DiskStatusActive}
	}
	return model.DiskInfo{Name: name, Temp: temp, Status: model.DiskStatusActive}
}

// checkStandby 使用 hdparm -C 检查硬盘是否休眠
// 输出 standby 表示休眠，active/idle 表示活动
func (d *SmartCtlDriver) checkStandby(dev string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "hdparm", "-C", dev)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "standby")
}

func (d *SmartCtlDriver) readSATATemp(dev string) *float64 {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "smartctl", "-a", dev)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil
	}
	return parseSATATemperature(out)
}

func (d *SmartCtlDriver) readNVMeTemp(dev string) *float64 {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "smartctl", "-a", dev)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil
	}
	return parseNVMeTemperature(out)
}

// parseSATATemperature 从 smartctl -a 输出中提取 SATA/SAS 磁盘温度。
func parseSATATemperature(out []byte) *float64 {
	text := strings.ToLower(string(out))
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, "temperature") || strings.Contains(line, "airflow_temperature") {
			fields := reTempWithParen.FindStringSubmatch(line)
			if len(fields) == 2 {
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil && v > 0 && v < 150 {
					return &v
				}
			}
			fields = reTempEndOfLine.FindStringSubmatch(line)
			if len(fields) == 2 {
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil && v > 0 && v < 150 {
					return &v
				}
			}
		}
	}
	return nil
}

// parseNVMeTemperature 从 smartctl -a 输出中提取 NVMe 磁盘温度。
func parseNVMeTemperature(out []byte) *float64 {
	text := strings.ToLower(string(out))
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, "temperature") {
			fields := reTempColon.FindStringSubmatch(line)
			if len(fields) == 2 {
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil && v > 0 && v < 150 {
					return &v
				}
			}
		}
	}
	return nil
}
