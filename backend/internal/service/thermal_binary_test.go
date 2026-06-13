package service

import (
	"testing"

	"fancontrolserver/internal/model"
)

func TestThermalBinaryCurveTrip(t *testing.T) {
	tests := []struct {
		name  string
		curve []model.CurvePoint
		want  int
	}{
		{name: "empty uses OES default", curve: nil, want: 60000},
		{name: "normal threshold", curve: []model.CurvePoint{{Temp: 58, PWM: 255}}, want: 58000},
		{name: "first nonzero point", curve: []model.CurvePoint{{Temp: 45, PWM: 0}, {Temp: 62, PWM: 255}}, want: 62000},
		{name: "lower safety clamp", curve: []model.CurvePoint{{Temp: 20, PWM: 1}}, want: 40000},
		{name: "upper safety clamp", curve: []model.CurvePoint{{Temp: 95, PWM: 255}}, want: 75000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := thermalBinaryCurveTrip(tt.curve); got != tt.want {
				t.Fatalf("thermalBinaryCurveTrip()=%d, want %d", got, tt.want)
			}
		})
	}
}

func TestLooksLikeDefaultPWMCurve(t *testing.T) {
	if !looksLikeDefaultPWMCurve([]model.CurvePoint{
		{Temp: 45, PWM: 120},
		{Temp: 60, PWM: 180},
		{Temp: 75, PWM: 255},
	}) {
		t.Fatal("expected original default PWM curve to be recognized")
	}
	if looksLikeDefaultPWMCurve(defaultThermalBinaryCurve()) {
		t.Fatal("thermal binary curve must not be recognized as original PWM curve")
	}
}
