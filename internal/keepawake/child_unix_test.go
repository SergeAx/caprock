//go:build darwin || linux

package keepawake

import (
	"os/exec"
	"strings"
	"testing"
)

// The child holder is exercised with /bin/sh standing in for the helper:
// the mechanics (start, watch, stop) are what is tested, never a real
// power assertion.

func TestChildHolderHoldsAndReleases(t *testing.T) {
	h := &childHolder{
		argv: []string{"/bin/sh", "-c", "sleep 30"},
		stop: func(c *exec.Cmd) { _ = c.Process.Kill() },
	}
	if err := h.Hold(); err != nil {
		t.Fatal(err)
	}
	if !h.Held() {
		t.Fatal("not held after Hold")
	}
	if err := h.Hold(); err != nil {
		t.Fatal(err)
	}
	h.Release()
	if h.Held() {
		t.Fatal("held after Release")
	}
	h.Release() // a no-op
}

func TestChildHolderReportsAHelperThatExitsAtOnce(t *testing.T) {
	h := &childHolder{
		argv: []string{"/bin/sh", "-c", "echo 'Failed to inhibit: no logind' >&2; exit 1"},
		stop: func(c *exec.Cmd) { _ = c.Process.Kill() },
	}
	err := h.Hold()
	if err == nil || !strings.Contains(err.Error(), "no logind") {
		t.Fatalf("want the helper's complaint, got %v", err)
	}
	if h.Held() {
		t.Fatal("held after a failed start")
	}
}

func TestChildHolderUnavailable(t *testing.T) {
	h := &childHolder{unavailable: "nothing to ask"}
	if ok, why := h.Available(); ok || why != "nothing to ask" {
		t.Fatal("availability wrong")
	}
	if err := h.Hold(); err == nil {
		t.Fatal("an unavailable holder held")
	}
}

func TestNewOSDoesNotStartAnything(t *testing.T) {
	// Building the holder only looks for the helper; it must not run it.
	h := NewOS()
	if h.Held() {
		t.Fatal("a new holder claims to hold")
	}
}
