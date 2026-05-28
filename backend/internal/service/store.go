package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/model"
)

type Store struct {
	path     string
	mu       sync.RWMutex
	cfg      model.Config
	firstRun bool
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}

	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.cfg = defaultConfig()
		s.firstRun = true
		return s.saveLocked()
	}
	if err != nil {
		return err
	}

	if err = json.Unmarshal(raw, &s.cfg); err != nil {
		return err
	}
	migrated := migrateConfig(&s.cfg)
	normalizeConfig(&s.cfg)
	if migrated {
		logrus.Infof("[配置] 迁移后自动保存配置文件")
		return s.saveLocked()
	}
	return nil
}

func (s *Store) Get() model.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Store) Save(cfg model.Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 当 CPUSensor/GPUSensor 被移除或变更时，还原相关风扇的温度源为 "cpu"/"gpu"
	// 后续 normalizeConfig 会根据新的传感器值重新映射
	if s.cfg.Global.CPUSensor != cfg.Global.CPUSensor && s.cfg.Global.CPUSensor != "" {
		oldCPUSrc := "sensor:" + s.cfg.Global.CPUSensor
		for i := range cfg.Fans {
			if cfg.Fans[i].Source == oldCPUSrc {
				cfg.Fans[i].Source = "cpu"
			}
		}
	}
	if s.cfg.Global.GPUSensor != cfg.Global.GPUSensor && s.cfg.Global.GPUSensor != "" {
		oldGPUSrc := "sensor:" + s.cfg.Global.GPUSensor
		for i := range cfg.Fans {
			if cfg.Fans[i].Source == oldGPUSrc {
				cfg.Fans[i].Source = "gpu"
			}
		}
	}

	normalizeConfig(&cfg)
	s.cfg = cfg
	if err := s.saveLocked(); err != nil {
		return err
	}
	s.firstRun = false
	return nil
}

func (s *Store) IsFirstRun() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.firstRun
}

func (s *Store) saveLocked() error {
	raw, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	// 原子写入：先写临时文件，再 rename，避免中途崩溃导致配置损坏
	tmpPath := s.path + ".tmp"
	if err = os.WriteFile(tmpPath, raw, 0o600); err != nil {
		return err
	}
	if err = os.Rename(tmpPath, s.path); err != nil {
		// rename 失败时尝试删除临时文件
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func defaultConfig() model.Config {
	return model.Config{
		Version: model.CurrentConfigVersion,
		Fans:    []model.FanConfig{},
		Global: model.GlobalConfig{
			PWMDeadzone:      5,
			StopHysteresis:   5,
			UpdateIntervalMS: 2000,
			EmergencyTemp:    80,
			StopBehavior:     model.StopBehaviorSet,
			StopPWM:          200,
		},
	}
}

// migrateConfig 按版本号逐级迁移旧配置，返回 true 表示发生了迁移（或需落盘修正）。
func migrateConfig(cfg *model.Config) bool {
	if cfg.Version > model.CurrentConfigVersion {
		logrus.Warnf("[配置] 文件 version=%d 高于当前程序 v%d，已写回 version=%d",
			cfg.Version, model.CurrentConfigVersion, model.CurrentConfigVersion)
		cfg.Version = model.CurrentConfigVersion
		return true
	}
	if cfg.Version >= model.CurrentConfigVersion {
		return false
	}
	logrus.Infof("[配置] 检测到旧版配置 (v%d)，正在迁移至 v%d", cfg.Version, model.CurrentConfigVersion)

	if cfg.Version < 1 {
		migrateV0ToV1(cfg)
	}
	if cfg.Version < 2 {
		migrateV1ToV2(cfg)
	}
	if cfg.Version < 3 {
		migrateV2ToV3(cfg)
	}

	cfg.Version = model.CurrentConfigVersion
	logrus.Infof("[配置] 配置迁移完成 → v%d", model.CurrentConfigVersion)
	return true
}

// migrateV0ToV1 处理无版本号的历史配置 → v1。
// 补齐可能缺失的字段默认值（仅处理零值无法区分"未设置"与"故意为零"的字段）。
func migrateV0ToV1(cfg *model.Config) {
	if cfg.Global.StopBehavior == "" {
		cfg.Global.StopBehavior = model.StopBehaviorSet
	}
}

// migrateV1ToV2 v1→v2：显式写入降级策略默认（keep_last）、修正不完整项；并将当时全局的
// 死区/停转温差/过热阈值复制到尚未自定义的风扇（与迁移时全局值一致）。
func migrateV1ToV2(cfg *model.Config) {
	for i := range cfg.Fans {
		f := &cfg.Fans[i]
		p := strings.TrimSpace(f.FallbackPolicy)
		switch p {
		case model.FallbackStop, model.FallbackMinPWM, model.FallbackFullSpeed, model.FallbackFollowOther, model.FallbackKeepLast:
			if p == model.FallbackFollowOther && strings.TrimSpace(f.FallbackFollowSource) == "" {
				f.FallbackPolicy = model.FallbackKeepLast
				f.FallbackFollowSource = ""
			}
			if p == model.FallbackMinPWM && f.FallbackMinPWM <= 0 {
				f.FallbackMinPWM = 80
			}
		case "":
			f.FallbackPolicy = model.FallbackKeepLast
		default:
			f.FallbackPolicy = model.FallbackKeepLast
			f.FallbackFollowSource = ""
		}
	}

	g := cfg.Global
	dz := g.PWMDeadzone
	if dz < 0 || dz > 255 {
		dz = 5
	}
	hys := g.StopHysteresis
	if hys < 0 || hys > 30 {
		hys = 2
	}
	em := g.EmergencyTemp
	if em <= 0 || em > 120 {
		em = 80
	}
	for i := range cfg.Fans {
		f := &cfg.Fans[i]
		if f.PWMDeadzone == nil {
			v := dz
			f.PWMDeadzone = &v
		}
		if f.StopHysteresis == nil {
			h := hys
			f.StopHysteresis = &h
		}
		if f.EmergencyTemp == nil {
			e := em
			f.EmergencyTemp = &e
		}
	}
	logrus.Infof("[配置] v2：降级策略默认已写入；全局调速三项已复制到尚未自定义的风扇")
}

// migrateV2ToV3 v2->v3: 为旧风扇补稳定表示 chip/device/pwm_index,并升级id
func migrateV2ToV3(cfg *model.Config) {
	for i := range cfg.Fans {
		f := &cfg.Fans[i]
		if f.Chip != "" && f.PWMIndex > 0 {
			continue
		}
		if f.PWMPath == "" {
			continue
		}
		chip, device, pwmIndex := stableFieldsFromPWMPath(f.PWMPath)
		if chip == "" || pwmIndex <= 0 {
			logrus.Warnf("[配置] v3迁移：风扇 %q 无法冲 pwm 路径解析稳定标识：%s", f.ID, f.PWMPath)
			continue
		}
		f.Chip = chip
		f.Device = device
		f.PWMIndex = pwmIndex
		f.ID = fmt.Sprintf("%s/%spwm%d", chip, device, pwmIndex)
	}
	logrus.Infof("[配置] v3迁移：已为风扇写入 chip/device/pwm_index 标识")
}

func stableFieldsFromPWMPath(pwmPath string) (chip, device string, pwmIndex int) {
	dir := filepath.Dir(pwmPath)
	if raw, err := os.ReadFile(filepath.Join(dir, "name")); err == nil {
		chip = strings.TrimSpace(string(raw))
	}
	if link, err := os.Readlink(filepath.Join(dir, "device")); err == nil {
		device = filepath.Base(link)
	}
	if n, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(pwmPath), "pwm")); err == nil {
		pwmIndex = n
	}
	return chip, device, pwmIndex
}

func normalizeConfig(cfg *model.Config) {
	// 全局配置字段合法性校验与默认值填充
	if cfg.Global.PWMDeadzone < 0 || cfg.Global.PWMDeadzone > 255 {
		cfg.Global.PWMDeadzone = 5
	}
	if cfg.Global.StopHysteresis < 0 || cfg.Global.StopHysteresis > 30 {
		cfg.Global.StopHysteresis = 2
	}
	if cfg.Global.EmergencyTemp <= 0 || cfg.Global.EmergencyTemp > 120 {
		cfg.Global.EmergencyTemp = 80
	}
	if cfg.Global.StopPWM < 0 || cfg.Global.StopPWM > 255 {
		cfg.Global.StopPWM = 200
	}
	if cfg.Global.UpdateIntervalMS < 100 || cfg.Global.UpdateIntervalMS > 10000 {
		cfg.Global.UpdateIntervalMS = 2000
	}
	if cfg.Global.StopBehavior == "" {
		cfg.Global.StopBehavior = model.StopBehaviorSet
	}
	if cfg.Global.SourceMode != "advanced" {
		cfg.Global.SourceMode = "simple"
	}
	if cfg.Global.SensorAliases == nil {
		cfg.Global.SensorAliases = map[string]string{}
	}
	if cfg.Global.SensorHidden == nil {
		cfg.Global.SensorHidden = []string{}
	}

	// 风扇列表排序：按ID稳定排序
	sort.Slice(cfg.Fans, func(i, j int) bool { return cfg.Fans[i].ID < cfg.Fans[j].ID })

	// 每个风扇的独立规范化
	var cpuMapped, gpuMapped int
	for i := range cfg.Fans {
		if cfg.Fans[i].Mode == "" {
			cfg.Fans[i].Mode = model.FanModeCurve
		}
		if cfg.Fans[i].Source == "" {
			cfg.Fans[i].Source = "cpu"
		}
		// 当 CPUSensor/GPUSensor 已设置时，将风扇的 "cpu"/"gpu" 温度源
		// 映射到具体传感器 ID，使温度源更明确且前端可见
		if cfg.Global.CPUSensor != "" && cfg.Fans[i].Source == "cpu" {
			cfg.Fans[i].Source = "sensor:" + cfg.Global.CPUSensor
			cpuMapped++
		}
		if cfg.Global.GPUSensor != "" && cfg.Fans[i].Source == "gpu" {
			cfg.Fans[i].Source = "sensor:" + cfg.Global.GPUSensor
			gpuMapped++
		}
		// 曲线点排序
		sort.Slice(cfg.Fans[i].Curve, func(a, b int) bool {
			return cfg.Fans[i].Curve[a].Temp < cfg.Fans[i].Curve[b].Temp
		})
		normalizeFanOverrides(&cfg.Fans[i])
	}
	if cpuMapped > 0 {
		logrus.Infof("[配置] %d 个风扇的 CPU 温度源已映射到传感器 %s", cpuMapped, cfg.Global.CPUSensor)
	}
	if gpuMapped > 0 {
		logrus.Infof("[配置] %d 个风扇的 GPU 温度源已映射到传感器 %s", gpuMapped, cfg.Global.GPUSensor)
	}
}

// normalizeFanOverrides 校验每风扇可选的全局项覆盖，非法则丢弃覆盖（回退全局）。
func normalizeFanOverrides(f *model.FanConfig) {
	if f.PWMDeadzone != nil {
		v := *f.PWMDeadzone
		if v < 0 || v > 255 {
			f.PWMDeadzone = nil
		}
	}
	if f.StopHysteresis != nil {
		v := *f.StopHysteresis
		if v < 0 || v > 30 {
			f.StopHysteresis = nil
		}
	}
	if f.EmergencyTemp != nil {
		v := *f.EmergencyTemp
		if v <= 0 || v > 120 {
			f.EmergencyTemp = nil
		}
	}

	p := strings.TrimSpace(f.FallbackPolicy)
	switch p {
	case model.FallbackStop, model.FallbackMinPWM, model.FallbackFullSpeed, model.FallbackFollowOther, model.FallbackKeepLast:
		f.FallbackPolicy = p
	case "":
		f.FallbackPolicy = ""
	default:
		f.FallbackPolicy = ""
	}
	if f.FallbackPolicy == model.FallbackFollowOther && strings.TrimSpace(f.FallbackFollowSource) == "" {
		f.FallbackPolicy = ""
		f.FallbackFollowSource = ""
	}
	if f.FallbackPolicy == model.FallbackMinPWM {
		if f.FallbackMinPWM <= 0 {
			f.FallbackMinPWM = 80
		}
		if f.FallbackMinPWM > 255 {
			f.FallbackMinPWM = 255
		}
	}
}
