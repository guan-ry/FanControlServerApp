package update

import "testing"

func TestNormalizeVersion(t *testing.T) {
	cases := map[string]string{
		"v1.3.6":       "1.3.6",
		"V1.2.0":       "1.2.0",
		"1.3.6":        "1.3.6",
		"1.3.6-beta.1": "1.3.6",
		"  v2.0.0  ":   "2.0.0",
	}
	for in, want := range cases {
		if got := normalizeVersion(in); got != want {
			t.Errorf("normalizeVersion(%q)=%q want %q", in, got, want)
		}
	}
}

func TestIsNewer(t *testing.T) {
	if !isNewer("1.3.7", "1.3.6") {
		t.Fatal("1.3.7 should be newer than 1.3.6")
	}
	if isNewer("1.3.6", "1.3.6") {
		t.Fatal("same version should not be newer")
	}
	if isNewer("1.3.5", "1.3.6") {
		t.Fatal("older should not be newer")
	}
	if isNewer("2.0.0", "1.9.9") != true {
		t.Fatal("2.0.0 should be newer than 1.9.9")
	}
	if isNewer("1.3.6-beta", "1.3.5") != true {
		t.Fatal("normalized beta tag should compare as 1.3.6 > 1.3.5")
	}
	if !isNewer("1.3.6.1", "1.3.6") {
		t.Fatal("1.3.6.1 should be newer than 1.3.6")
	}
	if isNewer("1.3.6", "1.3.6.1") {
		t.Fatal("1.3.6 should not be newer than 1.3.6.1")
	}
}
