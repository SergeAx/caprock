package daemon

import "testing"

func TestLoopbackAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:6061": true,
		"[::1]:6061":     true,
		"127.0.0.1:0":    true,
		"0.0.0.0:6061":   false,
		"localhost:6061": false,
		"10.0.0.2:6061":  false,
		":6061":          false,
		"6061":           false,
		"":               false,
	} {
		if got := loopbackAddr(addr); got != want {
			t.Errorf("loopbackAddr(%q) = %v, want %v", addr, got, want)
		}
	}
}
