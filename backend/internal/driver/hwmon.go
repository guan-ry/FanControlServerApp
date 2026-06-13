package driver

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var allowedPathPrefixes = []string{
	"/sys/class/hwmon/",
	"/sys/class/thermal/",
	"/sys/devices/",
}

// ValidateHwmonPath 检查路径是否位于本程序允许访问的 sysfs 范围内。
func ValidateHwmonPath(path string) error {
	if path == "" {
		return nil
	}
	cleaned := filepath.Clean(path)
	if strings.Contains(cleaned, "..") {
		return fmt.Errorf("路径不允许包含 '..'：%s", path)
	}
	for _, prefix := range allowedPathPrefixes {
		if strings.HasPrefix(cleaned, prefix) {
			return nil
		}
	}
	return fmt.Errorf("路径不在允许的 hwmon/thermal sysfs 范围内：%s", path)
}

type HWMONDriver struct{}

func NewHWMONDriver() *HWMONDriver {
	return &HWMONDriver{}
}

func (d *HWMONDriver) ReadRPM(path string) (int, error) {
	if err := ValidateHwmonPath(path); err != nil {
		return 0, err
	}
	return readIntFile(path)
}

func (d *HWMONDriver) ReadPWM(path string) (int, error) {
	if err := ValidateHwmonPath(path); err != nil {
		return 0, err
	}
	return readIntFile(path)
}

func (d *HWMONDriver) WritePWM(enablePath, pwmPath string, pwm int) error {
	if err := ValidateHwmonPath(enablePath); err != nil {
		return err
	}
	if err := ValidateHwmonPath(pwmPath); err != nil {
		return err
	}
	if enablePath != "" {
		if err := os.WriteFile(enablePath, []byte("1\n"), 0o644); err != nil {
			return fmt.Errorf("写入 PWM 使能路径失败：%w", err)
		}
	}
	return os.WriteFile(pwmPath, []byte(fmt.Sprintf("%d\n", pwm)), 0o644)
}

func validateThermalTripPath(path string) error {
	clean := filepath.Clean(path)
	zoneDir := filepath.Dir(clean)
	if filepath.Dir(zoneDir) != "/sys/class/thermal" || !strings.HasPrefix(filepath.Base(zoneDir), "thermal_zone") {
		return fmt.Errorf("thermal trip 必须位于 /sys/class/thermal/thermal_zone*/ 下：%s", path)
	}
	base := filepath.Base(clean)
	indexText := strings.TrimSuffix(strings.TrimPrefix(base, "trip_point_"), "_temp")
	if indexText == base || !strings.HasSuffix(base, "_temp") {
		return fmt.Errorf("不是合法的 thermal trip 温度节点：%s", path)
	}
	if _, err := strconv.Atoi(indexText); err != nil {
		return fmt.Errorf("thermal trip 编号无效：%s", path)
	}
	return nil
}

// ReadThermalTrip 读取 thermal trip 温度，返回单位为毫摄氏度的整数。
func (d *HWMONDriver) ReadThermalTrip(path string) (int, error) {
	if err := ValidateHwmonPath(path); err != nil {
		return 0, err
	}
	if err := validateThermalTripPath(path); err != nil {
		return 0, err
	}
	return readIntFile(path)
}

// WriteThermalTrip 只允许修改 active trip。内核 thermal governor 继续负责实际开关风扇。
func (d *HWMONDriver) WriteThermalTrip(path string, milliCelsius int) error {
	if err := ValidateHwmonPath(path); err != nil {
		return err
	}
	if err := validateThermalTripPath(path); err != nil {
		return err
	}
	typePath := strings.TrimSuffix(path, "_temp") + "_type"
	if tripType := readTrimmed(typePath, ""); tripType != "active" {
		return fmt.Errorf("拒绝修改非 active thermal trip（type=%q）：%s", tripType, path)
	}
	if milliCelsius < 20000 || milliCelsius > 110000 {
		return fmt.Errorf("thermal active trip 超出 20–110°C 安全范围：%d", milliCelsius)
	}
	return os.WriteFile(path, []byte(fmt.Sprintf("%d\n", milliCelsius)), 0o644)
}

type thermalBinding struct {
	ZonePath         string
	ZoneType         string
	TripPath         string
	HystPath         string
	PolicyPath       string
	Policy           string
	HysteresisMilliC int
	CoolingDev       string
}

func normalizeFanName(s string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), "_", "-")
}

// findBinaryThermalBinding 查找 max_state=1 且绑定到 active trip 的 thermal cooling device。
// OES Plus 的 gpio_fan 正是这种标准 Linux thermal/hwmon 组合。
func findBinaryThermalBinding(chip string) *thermalBinding {
	want := normalizeFanName(chip)
	coolingDevices, _ := filepath.Glob("/sys/class/thermal/cooling_device*")
	for _, dev := range coolingDevices {
		if normalizeFanName(readTrimmed(filepath.Join(dev, "type"), "")) != want {
			continue
		}
		maxState, err := readIntFile(filepath.Join(dev, "max_state"))
		if err != nil || maxState != 1 {
			continue
		}
		devReal, err := filepath.EvalSymlinks(dev)
		if err != nil {
			devReal = filepath.Clean(dev)
		}

		zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*")
		for _, zone := range zones {
			links, _ := filepath.Glob(filepath.Join(zone, "cdev[0-9]*"))
			for _, link := range links {
				base := filepath.Base(link)
				if strings.Contains(base, "_") {
					continue
				}
				info, err := os.Lstat(link)
				if err != nil || info.Mode()&os.ModeSymlink == 0 {
					continue
				}
				linkReal, err := filepath.EvalSymlinks(link)
				if err != nil || filepath.Clean(linkReal) != filepath.Clean(devReal) {
					continue
				}

				tripIndex, err := readIntFile(filepath.Join(zone, base+"_trip_point"))
				if err != nil || tripIndex < 0 {
					continue
				}
				tripPrefix := filepath.Join(zone, fmt.Sprintf("trip_point_%d", tripIndex))
				if readTrimmed(tripPrefix+"_type", "") != "active" {
					continue
				}
				tripPath := tripPrefix + "_temp"
				if _, err = os.Stat(tripPath); err != nil {
					continue
				}
				hystPath := tripPrefix + "_hyst"
				hyst, _ := readIntFile(hystPath)
				policyPath := filepath.Join(zone, "policy")
				return &thermalBinding{
					ZonePath:         zone,
					ZoneType:         readTrimmed(filepath.Join(zone, "type"), filepath.Base(zone)),
					TripPath:         tripPath,
					HystPath:         hystPath,
					PolicyPath:       policyPath,
					Policy:           readTrimmed(policyPath, ""),
					HysteresisMilliC: hyst,
					CoolingDev:       dev,
				}
			}
		}
	}
	return nil
}

func (d *HWMONDriver) ScanFans() ([]map[string]string, error) {
	fans := make([]map[string]string, 0)
	entries, _ := filepath.Glob("/sys/class/hwmon/hwmon*")

	for _, hwmon := range entries {
		chip := readTrimmed(filepath.Join(hwmon, "name"), filepath.Base(hwmon))
		device := ""
		if link, err := os.Readlink(filepath.Join(hwmon, "device")); err == nil {
			device = filepath.Base(link)
		}

		binding := findBinaryThermalBinding(chip)
		pwmFiles, _ := filepath.Glob(filepath.Join(hwmon, "pwm[0-9]"))
		for _, pwmFile := range pwmFiles {
			idx := strings.TrimPrefix(filepath.Base(pwmFile), "pwm")
			stableID := fmt.Sprintf("%s/%s/pwm%s", chip, device, idx)
			rpmPath := filepath.Join(hwmon, "fan"+idx+"_input")
			if _, err := os.Stat(rpmPath); err != nil {
				rpmPath = ""
			}
			enablePath := filepath.Join(hwmon, "pwm"+idx+"_enable")
			if _, err := os.Stat(enablePath); err != nil {
				enablePath = ""
			}

			item := map[string]string{
				"id":           stableID,
				"name":         fmt.Sprintf("%s 风扇 %s", chip, idx),
				"chip":         chip,
				"device":       device,
				"pwm_index":    idx,
				"pwm_path":     pwmFile,
				"rpm_path":     rpmPath,
				"enable_path":  enablePath,
				"control_type": "pwm",
			}
			if binding != nil {
				item["name"] = fmt.Sprintf("%s 二态风扇", chip)
				item["control_type"] = "thermal_binary"
				item["thermal_zone_path"] = binding.ZonePath
				item["thermal_trip_path"] = binding.TripPath
				item["thermal_hyst_path"] = binding.HystPath
				item["thermal_policy_path"] = binding.PolicyPath
				item["thermal_zone_type"] = binding.ZoneType
				item["thermal_policy"] = binding.Policy
				item["thermal_hysteresis"] = strconv.FormatFloat(float64(binding.HysteresisMilliC)/1000, 'f', -1, 64)
				item["cooling_device_path"] = binding.CoolingDev
				item["rpm_is_nominal"] = "true"
				if rpmPath != "" {
					if nominal, err := readIntFile(filepath.Join(hwmon, "fan"+idx+"_max")); err == nil {
						item["nominal_rpm"] = strconv.Itoa(nominal)
					} else if nominal, err := readIntFile(rpmPath); err == nil {
						item["nominal_rpm"] = strconv.Itoa(nominal)
					}
				}
			}
			fans = append(fans, item)
		}
	}
	return fans, nil
}

func readIntFile(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
}

// TempChannel 描述一个 hwmon 温度通道的元数据。
type TempChannel struct {
	ID     string
	Chip   string
	Device string
	Key    string
	Label  string
	Path   string
}

// ScanTempChannels 通用扫描所有 hwmon 温度通道。
// 不做任何品牌识别，原样输出 chip / device / label，分类与展示完全交给上层。
func (d *HWMONDriver) ScanTempChannels() ([]TempChannel, error) {
	entries, err := filepath.Glob("/sys/class/hwmon/hwmon*/temp*_input")
	if err != nil {
		return nil, err
	}
	out := make([]TempChannel, 0, len(entries))
	for _, p := range entries {
		dir := filepath.Dir(p)
		key := strings.TrimSuffix(filepath.Base(p), "_input")
		chip := readTrimmed(filepath.Join(dir, "name"), filepath.Base(dir))

		device := ""
		if link, err := os.Readlink(filepath.Join(dir, "device")); err == nil {
			device = filepath.Base(link)
		}

		label := readTrimmed(filepath.Join(dir, key+"_label"), "")

		out = append(out, TempChannel{
			ID:     chip + "/" + device + "/" + key,
			Chip:   chip,
			Device: device,
			Key:    key,
			Label:  label,
			Path:   p,
		})
	}
	return out, nil
}

// ReadTemp 读取单个温度通道（mC → °C），过滤明显异常值。
func (d *HWMONDriver) ReadTemp(path string) (*float64, error) {
	if err := ValidateHwmonPath(path); err != nil {
		return nil, err
	}
	raw, err := readIntFile(path)
	if err != nil {
		return nil, err
	}
	t := float64(raw) / 1000.0
	if t < -10 || t > 130 {
		return nil, fmt.Errorf("温度异常：%.1f°C", t)
	}
	return &t, nil
}

func readTrimmed(path, def string) string {
	if raw, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(raw)); s != "" {
			return s
		}
	}
	return def
}
