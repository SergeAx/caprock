//go:build darwin || linux

package keepawake

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// startGrace is how long a freshly started helper is watched for exiting at
// once — a systemd-inhibit with no logind to talk to, say — so that failure
// is reported as one instead of as a hold.
const startGrace = 300 * time.Millisecond

// childHolder holds the assertion by running a helper process that holds it
// for as long as it lives, and that exits by itself once the daemon is gone.
type childHolder struct {
	argv        []string
	setup       func(*exec.Cmd)
	stop        func(*exec.Cmd)
	unavailable string

	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan struct{}
}

func (h *childHolder) Available() (bool, string) { return h.unavailable == "", h.unavailable }

func (h *childHolder) Hold() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.unavailable != "" {
		return errors.New(h.unavailable)
	}
	if h.aliveLocked() {
		return nil
	}
	cmd := exec.Command(h.argv[0], h.argv[1:]...) // a fixed helper and fixed arguments, built in this package
	var stderr bytes.Buffer
	cmd.Stderr = &limited{b: &stderr, n: 512}
	if h.setup != nil {
		h.setup(cmd)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", h.argv[0], err)
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = "exited at once"
		}
		return fmt.Errorf("%s: %s", h.argv[0], msg)
	case <-time.After(startGrace):
	}
	h.cmd, h.done = cmd, done
	return nil
}

func (h *childHolder) Release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cmd == nil {
		return
	}
	if h.aliveLocked() {
		h.stop(h.cmd)
		select {
		case <-h.done:
		case <-time.After(2 * time.Second):
		}
	}
	h.cmd, h.done = nil, nil
}

func (h *childHolder) Held() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.aliveLocked()
}

func (h *childHolder) aliveLocked() bool {
	if h.cmd == nil {
		return false
	}
	select {
	case <-h.done:
		return false
	default:
		return true
	}
}

// limited keeps the first n bytes written to it: enough of a helper's
// complaint to report, never an unbounded buffer.
type limited struct {
	mu sync.Mutex
	b  *bytes.Buffer
	n  int
}

func (l *limited) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(p)
	if room := l.n - l.b.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
		}
		l.b.Write(p)
	}
	// All of it is reported written: the helper must never block or fail
	// on a full buffer.
	return n, nil
}
