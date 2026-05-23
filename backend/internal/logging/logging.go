// Package logging 负责初始化全局 logrus（文本/JSON、日志级别等）。
package logging

import (
	"io"
	"os"
	"path/filepath"

	"github.com/sirupsen/logrus"
	"gopkg.in/natefinch/lumberjack.v2"
)

// Config 日志配置
type Config struct {
	Level      string // 日志级别: debug, info, warn, error
	Dir        string // 日志目录
	File       string // 日志文件名
	MaxSizeMB  int    // 单文件最大 MB
	MaxAgeDays int    // 保留天数
	MaxBackups int    // 保留文件数
}

// Init 使用默认配置初始化日志（仅供配置加载失败时使用）
func Init() {
	InitWithConfig(Config{
		Level:      "info",
		Dir:        "logs",
		File:       "app.log",
		MaxSizeMB:  10,
		MaxAgeDays: 7,
		MaxBackups: 3,
	})
}

// InitWithConfig 使用配置初始化日志
func InitWithConfig(cfg Config) {
	// 如果环境变量 TRIM_PKGVAR 存在，则覆盖日志目录为 ${TRIM_PKGVAR}/logs
	if trimPkgVar := os.Getenv("TRIM_PKGVAR"); trimPkgVar != "" {
		cfg.Dir = filepath.Join(trimPkgVar, "logs")
		cfg.File = "app.log" // 保持文件名固定
	}

	logrus.SetFormatter(&logrus.TextFormatter{
		FullTimestamp:   true,
		TimestampFormat: "2006-01-02 15:04:05",
		PadLevelText:    true,
	})

	// 默认值
	if cfg.Level == "" {
		cfg.Level = "info"
	}
	if cfg.Dir == "" {
		cfg.Dir = "logs"
	}
	if cfg.File == "" {
		cfg.File = "app.log"
	}
	if cfg.MaxSizeMB <= 0 {
		cfg.MaxSizeMB = 10
	}
	if cfg.MaxAgeDays <= 0 {
		cfg.MaxAgeDays = 7
	}
	if cfg.MaxBackups <= 0 {
		cfg.MaxBackups = 3
	}

	// 设置日志级别
	if parsed, err := logrus.ParseLevel(cfg.Level); err == nil {
		logrus.SetLevel(parsed)
	}

	// 日志文件路径
	logPath := filepath.Join(cfg.Dir, cfg.File)

	// 确保日志目录存在
	if err := os.MkdirAll(cfg.Dir, 0755); err != nil {
		logrus.Warnf("[日志] 无法创建日志目录 %s: %v", cfg.Dir, err)
		logrus.SetOutput(os.Stderr)
	} else {
		// 设置文件输出（带轮转），同时输出到 stderr 以便控制台可见
		fileWriter := &lumberjack.Logger{
			Filename:   logPath,
			MaxSize:    cfg.MaxSizeMB,
			MaxAge:     cfg.MaxAgeDays,
			MaxBackups: cfg.MaxBackups,
			Compress:   true,
		}
		logrus.SetOutput(io.MultiWriter(os.Stderr, fileWriter))
		logrus.Infof("[日志] 日志文件: %s", logPath)
	}

	// JSON 格式
	if os.Getenv("LOG_JSON") == "1" {
		logrus.SetFormatter(&logrus.JSONFormatter{
			TimestampFormat: "2006-01-02T15:04:05.000Z07:00",
		})
	}
}

// SetLevel 动态设置日志级别（供配置加载后调用）
func SetLevel(level string) {
	if parsed, err := logrus.ParseLevel(level); err == nil {
		logrus.SetLevel(parsed)
		logrus.Infof("[日志] 日志级别已设置为: %s", level)
	} else {
		logrus.Warnf("[日志] 无效的日志级别 %s，保持当前级别: %v", level, err)
	}
}
