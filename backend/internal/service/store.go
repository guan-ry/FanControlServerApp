package service

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
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
	return os.WriteFile(s.path, raw, 0o600)
}

func defaultConfig() model.Config {
	return model.Config{
		Version: model.CurrentConfigVersion,
		Fans:    []model.FanConfig{},
		Global: model.GlobalConfig{
			PWMDeadzone:      5,
			StopHysteresis:   2,
			UpdateIntervalMS: 2000,
			EmergencyTemp:    80,
			StopBehavior:     model.StopBehaviorSet,
			StopPWM:          200,
		},
	}
}

// migrateConfig 按版本号逐级迁移旧配置，返回 true 表示发生了迁移。
func migrateConfig(cfg *model.Config) bool {
	if cfg.Version >= model.CurrentConfigVersion {
		return false
	}
	logrus.Infof("[配置] 检测到旧版配置 (v%d)，正在迁移至 v%d", cfg.Version, model.CurrentConfigVersion)

	if cfg.Version < 1 {
		migrateV0ToV1(cfg)
	}
	// 未来版本示例：
	// if cfg.Version < 2 { migrateV1ToV2(cfg) }

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

func normalizeConfig(cfg *model.Config) {
	if cfg.Global.UpdateIntervalMS <= 0 {
		cfg.Global.UpdateIntervalMS = 1500
	}
	if cfg.Global.EmergencyTemp <= 0 {
		cfg.Global.EmergencyTemp = 80
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

	sort.Slice(cfg.Fans, func(i, j int) bool { return cfg.Fans[i].ID < cfg.Fans[j].ID })
	for i := range cfg.Fans {
		if cfg.Fans[i].Mode == "" {
			cfg.Fans[i].Mode = model.FanModeCurve
		}
		if cfg.Fans[i].Source == "" {
			cfg.Fans[i].Source = "cpu"
		}
		sort.Slice(cfg.Fans[i].Curve, func(a, b int) bool {
			return cfg.Fans[i].Curve[a].Temp < cfg.Fans[i].Curve[b].Temp
		})
	}
}
