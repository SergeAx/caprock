// Package keepawake keeps the computer from idle-sleeping while agents work
// (ADR-049). The daemon asks the operating system not to put the machine to
// sleep for inactivity — the system, not the display: the screen still dims
// and locks — and lets go the moment nothing is working, on exit, and with
// the daemon if it dies.
//
// The OS call sits behind Holder, so the rules here are tested without one:
// no caffeinate, no power assertion, no dialog in a test run. Every failure
// is logged and the feature degrades to off; nothing here may stop the
// daemon or a session.
package keepawake

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// The three modes, as stored in config.json and carried by the API.
const (
	// ModeOff never holds the machine awake.
	ModeOff = "off"
	// ModeWorking holds it while any agent session is working, the default.
	ModeWorking = "working"
	// ModeAlways holds it for as long as the daemon runs.
	ModeAlways = "always"
)

// DefaultMode is what an install that never chose gets. See ADR-049 for why
// it is on: the assertion only stops idle sleep, it lets go within a check of
// the last agent stopping, and a laptop's lid still sleeps it.
const DefaultMode = ModeWorking

// Modes lists the valid modes in the order a screen offers them.
var Modes = []string{ModeOff, ModeWorking, ModeAlways}

// ValidMode reports whether m is one of Modes.
func ValidMode(m string) bool {
	for _, v := range Modes {
		if v == m {
			return true
		}
	}
	return false
}

// Normalize maps the stored value to a mode: empty (never chosen) and
// anything unknown are the default.
func Normalize(m string) string {
	if ValidMode(m) {
		return m
	}
	return DefaultMode
}

// Silence is how long a session that has said nothing is still believed to be
// working. A tool call in flight sends nothing until it returns, so a
// twenty-minute build reads as silence; the bound is what keeps a session
// whose process died mid-turn from holding the machine awake all night. The
// same half hour bounds a silent subagent (store.LiveSubagentWindow).
const Silence = 30 * time.Minute

// Holder takes and releases the operating system's "do not idle-sleep"
// assertion. Implementations are per OS (holder_*.go).
type Holder interface {
	// Available reports whether this machine offers an assertion; when it
	// does not, reason says why in a line a person can act on.
	Available() (ok bool, reason string)
	// Hold takes the assertion. Holding twice is one hold.
	Hold() error
	// Release lets it go. Releasing what is not held is a no-op.
	Release()
	// Held reports whether the assertion is in force now: a helper process
	// that died on its own is not holding anything.
	Held() bool
}

// Status is GET /v1/keepawake (03-contracts.md § Keep awake).
type Status struct {
	Mode string `json:"mode"`
	// Holding is true while the assertion is in force.
	Holding bool `json:"holding"`
	// Since is when the current hold began, Unix ms; 0 when not holding.
	Since int64 `json:"since,omitempty"`
	// Working is how many sessions counted as working at the last check.
	Working int `json:"working"`
	// Available is false where the machine offers no assertion (a Linux
	// without systemd-inhibit); Reason says why.
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Error is why the last attempt to hold failed, empty when it did not.
	Error string `json:"error,omitempty"`
}

// retryAfter is how long a failed hold waits before it is tried again, so a
// helper that cannot start is not spawned on every check.
const retryAfter = 5 * time.Minute

// Keeper decides when to hold. Mode and Busy are read on every check, so a
// changed setting takes effect at the next one (Wake makes that immediate).
type Keeper struct {
	Holder Holder
	// Mode returns the stored mode; it is normalized here.
	Mode func() string
	// Busy returns how many sessions are working now. Asked only in
	// ModeWorking; an error counts as none, so a broken query lets go rather
	// than holding forever.
	Busy func(ctx context.Context) (int, error)
	Log  *slog.Logger
	Now  func() time.Time

	wake chan struct{}
	once sync.Once

	mu       sync.Mutex
	holding  bool
	since    time.Time
	working  int
	lastErr  string
	failedAt time.Time
}

func (k *Keeper) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now()
}

func (k *Keeper) log() *slog.Logger {
	if k.Log != nil {
		return k.Log
	}
	return slog.Default()
}

func (k *Keeper) wakeCh() chan struct{} {
	k.once.Do(func() { k.wake = make(chan struct{}, 1) })
	return k.wake
}

// Wake asks Run for a check now, for a setting just changed.
func (k *Keeper) Wake() {
	select {
	case k.wakeCh() <- struct{}{}:
	default:
	}
}

// Run checks every `every` until ctx ends, then releases.
func (k *Keeper) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	defer k.release()
	wake := k.wakeCh()
	k.Check(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-wake:
		}
		k.Check(ctx)
	}
}

// Check decides once whether to hold, and takes or releases accordingly.
func (k *Keeper) Check(ctx context.Context) {
	if k.Holder == nil {
		return
	}
	want, working := false, 0
	switch Normalize(k.Mode()) {
	case ModeAlways:
		want = true
	case ModeWorking:
		if k.Busy != nil {
			n, err := k.Busy(ctx)
			if err != nil {
				k.log().Debug("keep awake: could not tell whether agents work", "component", "keepawake", "err", err)
				n = 0
			}
			working = n
			want = n > 0
		}
	}
	if ok, _ := k.Holder.Available(); !ok {
		want = false
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	k.working = working
	if !want {
		k.releaseLocked()
		// A failure belongs to the hold it stopped: once nothing is wanted,
		// the next hold starts with a clean slate.
		k.lastErr, k.failedAt = "", time.Time{}
		return
	}
	if k.holding && k.Holder.Held() {
		return
	}
	if k.holding {
		// The helper died on its own (killed from outside, crashed): what
		// we thought we held is gone. Counted as a failure, so it is taken
		// again after retryAfter rather than respawned on every check.
		k.Holder.Release()
		k.holding, k.since = false, time.Time{}
		k.lastErr, k.failedAt = "the helper keeping the computer awake stopped by itself", k.now()
		k.log().Warn("keep awake: "+k.lastErr, "component", "keepawake")
		return
	}
	if !k.failedAt.IsZero() && k.now().Sub(k.failedAt) < retryAfter {
		return
	}
	if err := k.Holder.Hold(); err != nil {
		if k.lastErr != err.Error() {
			k.log().Warn("keep awake: could not keep the computer awake", "component", "keepawake", "err", err)
		}
		k.lastErr, k.failedAt = err.Error(), k.now()
		return
	}
	k.holding, k.since, k.lastErr, k.failedAt = true, k.now(), "", time.Time{}
	k.log().Debug("keep awake: holding the computer awake", "component", "keepawake", "working", working)
}

func (k *Keeper) release() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.releaseLocked()
}

func (k *Keeper) releaseLocked() {
	if k.Holder != nil {
		// Released whatever we believe: Release is a no-op when nothing is
		// held, and a belief that went stale must not leave a hold behind.
		k.Holder.Release()
	}
	if k.holding {
		k.log().Debug("keep awake: let the computer sleep again", "component", "keepawake")
	}
	k.holding, k.since = false, time.Time{}
}

// Status reports the keeper's state for the API.
func (k *Keeper) Status() Status {
	st := Status{Mode: DefaultMode}
	if k == nil {
		st.Reason = "This build cannot keep the computer awake."
		return st
	}
	if k.Mode != nil {
		st.Mode = Normalize(k.Mode())
	}
	if k.Holder == nil {
		st.Reason = "This build cannot keep the computer awake."
		return st
	}
	st.Available, st.Reason = k.Holder.Available()
	k.mu.Lock()
	defer k.mu.Unlock()
	st.Holding = k.holding
	if k.holding {
		st.Since = k.since.UnixMilli()
	}
	st.Working = k.working
	st.Error = k.lastErr
	return st
}
