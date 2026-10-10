package daemon

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/procstat"
	"github.com/dspv/caprock/internal/ptyhost"
)

// stopHost asks first and insists after reapGrace: an interactive shell
// ignores SIGTERM, and a holder passes it on to just such a shell. It refuses
// a pid that now names another process.
func TestStopHostEscalatesAndChecksIdentity(t *testing.T) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "60", "127.0.0.1")
	} else {
		cmd = exec.Command("sh", "-c", `trap "" TERM; while :; do sleep 1; done`)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a stand-in: %v", err)
	}
	waited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(waited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	pid := int32(cmd.Process.Pid)
	// Wait for the shell to be past its trap: it has started its first sleep.
	var tab *procstat.Table
	for deadline := time.Now().Add(5 * time.Second); ; {
		var err error
		if tab, err = procstat.Read(context.Background()); err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS == "windows" || len(tab.Children[pid]) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	p, ok := tab.Procs[pid]
	if !ok {
		t.Fatal("the stand-in is not in the process table")
	}

	if err := stopHost(context.Background(), ptyhost.HostProc{PID: pid, StartMs: p.StartMs + 60_000}); !errors.Is(err, errChanged) {
		t.Fatalf("a different start time must refuse: %v", err)
	}
	select {
	case <-waited:
		t.Fatal("the stand-in was stopped although its identity did not match")
	default:
	}

	t0 := time.Now()
	if err := stopHost(context.Background(), ptyhost.HostProc{PID: pid, StartMs: p.StartMs}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-waited:
	case <-time.After(10 * time.Second):
		t.Fatal("the stand-in is still running")
	}
	if runtime.GOOS != "windows" && time.Since(t0) < reapGrace {
		t.Errorf("stopped after %v: SIGTERM was ignored, so it should have taken the grace period", time.Since(t0))
	}
}
