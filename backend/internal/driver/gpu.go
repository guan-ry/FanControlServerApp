package driver

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type GPUDriver struct{}

func NewGPUDriver() *GPUDriver {
	return &GPUDriver{}
}

func (d *GPUDriver) Temp() (*float64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return nil, nil
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(lines[0]), 64)
	if err != nil {
		return nil, err
	}
	return &value, nil
}
