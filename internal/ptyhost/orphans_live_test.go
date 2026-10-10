package ptyhost

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyman"
)

// A real holder names its registry in its own environment and not in its
// child's, and Classify, given the real process table, calls it registered —
// then, with its registry entry gone, unreachable but running (the child is
// an agent, not an idle shell), which a reap never stops.
func TestLiveHolderIsJudgedFromItsEnvironment(t *testing.T) {
	data := t.TempDir()
	s, err := newManager(t, data).Spawn(context.Background(), childSpec(t, "s-orphan"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Signal(ptyman.SignalKill); _ = s.Close() })
	readAll(s.Output()).waitFor(t, "child ready")

	dir := Dir(data)
	b, err := os.ReadFile(recordPath(dir, "s-orphan"))
	if err != nil {
		t.Fatal(err)
	}
	var rec Record
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	hostEnv := procstat.Environ(context.Background(), int32(rec.HostPID))
	if hostEnv == nil {
		t.Skip("this OS would not let the test read the holder's environment")
	}
	if !hasEnv(hostEnv, RegistryEnv, dir) {
		t.Errorf("the holder's environment does not name its registry %s", dir)
	}
	if childEnv := procstat.Environ(context.Background(), int32(rec.ChildPID)); childEnv != nil && hasKey(childEnv, RegistryEnv) {
		t.Error("the registry variable leaked into the child's environment")
	}

	host := func() HostProc {
		tab, err := procstat.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		h := HostProc{PID: int32(rec.HostPID), StartMs: 1, Env: hostEnv} // StartMs 1: old enough to judge
		for _, c := range tab.Children[h.PID] {
			h.Children = append(h.Children, ChildProc{PID: c, Name: tab.Procs[c].Name, Busy: len(tab.Children[c]) > 0})
		}
		return h
	}
	if v := Classify([]HostProc{host()}, dir, time.Now()); v[0].State != "registered" || v[0].Reap {
		t.Fatalf("a running session's holder: %+v", v[0])
	}
	if err := os.Remove(recordPath(dir, "s-orphan")); err != nil {
		t.Fatal(err)
	}
	v := Classify([]HostProc{host()}, dir, time.Now())
	if v[0].State != "unreachable-busy" || v[0].Reap {
		t.Fatalf("an unreachable holder whose child is an agent must be kept: %+v", v[0])
	}
	if base := strings.TrimSuffix(strings.ToLower(filepath.Base(v[0].Child)), ".exe"); base == "" {
		t.Error("the child was not named")
	}
}

func hasEnv(env []string, k, v string) bool {
	for _, kv := range env {
		if kk, vv, ok := strings.Cut(kv, "="); ok && strings.EqualFold(kk, k) && filepath.Clean(vv) == filepath.Clean(v) {
			return true
		}
	}
	return false
}

func hasKey(env []string, k string) bool {
	for _, kv := range env {
		if kk, _, ok := strings.Cut(kv, "="); ok && strings.EqualFold(kk, k) {
			return true
		}
	}
	return false
}
