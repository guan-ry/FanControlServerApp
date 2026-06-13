package driver

import "testing"

func TestValidateThermalTripPath(t *testing.T) {
	valid := []string{
		"/sys/class/thermal/thermal_zone0/trip_point_3_temp",
		"/sys/class/thermal/thermal_zone12/trip_point_10_temp",
	}
	for _, path := range valid {
		if err := validateThermalTripPath(path); err != nil {
			t.Errorf("valid path rejected %q: %v", path, err)
		}
	}

	invalid := []string{
		"/etc/passwd",
		"/sys/class/thermal/cooling_device2/cur_state",
		"/sys/class/thermal/thermal_zone0/trip_point_x_temp",
		"/sys/class/thermal/thermal_zone0/trip_point_3_hyst",
		"/sys/devices/virtual/thermal/thermal_zone0/trip_point_3_temp",
	}
	for _, path := range invalid {
		if err := validateThermalTripPath(path); err == nil {
			t.Errorf("invalid path accepted: %q", path)
		}
	}
}

func TestNormalizeFanName(t *testing.T) {
	for input, want := range map[string]string{
		"gpio_fan":   "gpio-fan",
		"gpio-fan":   "gpio-fan",
		" GPIO_FAN ": "gpio-fan",
	} {
		if got := normalizeFanName(input); got != want {
			t.Errorf("normalizeFanName(%q)=%q, want %q", input, got, want)
		}
	}
}
