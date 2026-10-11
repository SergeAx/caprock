package keepawake

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeHolder records what the keeper asked of it; no OS call is made.
type fakeHolder struct {
	mu          sync.Mutex
	held        bool
	holds       int
	releases    int
	failWith    error
	unavailable string
}

func (f *fakeHolder) Available() (bool, string) { return f.unavailable == "", f.unavailable }

func (f *fakeHolder) Hold() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.holds++
	if f.failWith != nil {
		return f.failWith
	}
	f.held = true
	return nil
}

func (f *fakeHolder) Release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.held {
		f.releases++
	}
	f.held = false
}

func (f *fakeHolder) Held() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.held
}

func (f *fakeHolder) die() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.held = false
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newKeeper(h Holder, mode *string, busy *int) (*Keeper, *clock) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	return &Keeper{
		Holder: h,
		Mode:   func() string { return *mode },
		Busy:   func(context.Context) (int, error) { return *busy, nil },
		Now:    c.now,
	}, c
}

func TestNormalize(t *testing.T) {
	for in, want := range map[string]string{"": DefaultMode, "off": ModeOff, "working": ModeWorking, "always": ModeAlways, "nope": DefaultMode} {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
	if ValidMode("") || !ValidMode(ModeAlways) {
		t.Fatal("ValidMode wrong")
	}
}

func TestWorkingHoldsOnlyWhileBusy(t *testing.T) {
	h := &fakeHolder{}
	mode, busy := ModeWorking, 0
	k, _ := newKeeper(h, &mode, &busy)
	ctx := context.Background()

	k.Check(ctx)
	if h.Held() || k.Status().Holding {
		t.Fatal("held with nothing working")
	}
	busy = 2
	k.Check(ctx)
	st := k.Status()
	if !h.Held() || !st.Holding || st.Working != 2 || st.Since == 0 {
		t.Fatalf("not holding while two work: %+v", st)
	}
	k.Check(ctx)
	if h.holds != 1 {
		t.Fatalf("held again while holding: %d holds", h.holds)
	}
	busy = 0
	k.Check(ctx)
	if h.Held() || k.Status().Holding || k.Status().Since != 0 {
		t.Fatal("still holding after work stopped")
	}
}

func TestDefaultModeIsWorking(t *testing.T) {
	h := &fakeHolder{}
	mode, busy := "", 1
	k, _ := newKeeper(h, &mode, &busy)
	k.Check(context.Background())
	if !h.Held() || k.Status().Mode != ModeWorking {
		t.Fatalf("an unset mode should hold while working: %+v", k.Status())
	}
}

func TestOffNeverHoldsAndAlwaysAlwaysHolds(t *testing.T) {
	h := &fakeHolder{}
	mode, busy := ModeOff, 3
	k, _ := newKeeper(h, &mode, &busy)
	ctx := context.Background()
	k.Check(ctx)
	if h.Held() {
		t.Fatal("off held")
	}
	mode, busy = ModeAlways, 0
	k.Check(ctx)
	if !h.Held() {
		t.Fatal("always did not hold")
	}
	mode = ModeOff
	k.Check(ctx)
	if h.Held() {
		t.Fatal("switching off did not release")
	}
}

func TestBusyErrorLetsGo(t *testing.T) {
	h := &fakeHolder{}
	mode := ModeWorking
	k := &Keeper{Holder: h, Mode: func() string { return mode }, Busy: func(context.Context) (int, error) { return 5, errors.New("db gone") }}
	k.Check(context.Background())
	if h.Held() {
		t.Fatal("a failed query must count as nothing working")
	}
}

func TestFailedHoldBacksOff(t *testing.T) {
	h := &fakeHolder{failWith: errors.New("no caffeinate")}
	mode, busy := ModeWorking, 1
	k, c := newKeeper(h, &mode, &busy)
	ctx := context.Background()
	k.Check(ctx)
	st := k.Status()
	if st.Holding || st.Error != "no caffeinate" {
		t.Fatalf("failure not reported: %+v", st)
	}
	c.t = c.t.Add(time.Minute)
	k.Check(ctx)
	if h.holds != 1 {
		t.Fatalf("retried within the back-off: %d", h.holds)
	}
	h.failWith = nil
	c.t = c.t.Add(retryAfter)
	k.Check(ctx)
	if !h.Held() || k.Status().Error != "" {
		t.Fatalf("did not recover after the back-off: %+v", k.Status())
	}
}

func TestHelperThatDiesIsAFailure(t *testing.T) {
	h := &fakeHolder{}
	mode, busy := ModeAlways, 0
	k, c := newKeeper(h, &mode, &busy)
	ctx := context.Background()
	k.Check(ctx)
	h.die()
	k.Check(ctx)
	st := k.Status()
	if st.Holding || st.Error == "" {
		t.Fatalf("a dead helper should read as not holding, with a reason: %+v", st)
	}
	c.t = c.t.Add(retryAfter + time.Second)
	k.Check(ctx)
	if !h.Held() {
		t.Fatal("not taken again after the back-off")
	}
}

func TestUnavailableNeverHolds(t *testing.T) {
	h := &fakeHolder{unavailable: "no systemd-inhibit"}
	mode, busy := ModeAlways, 1
	k, _ := newKeeper(h, &mode, &busy)
	k.Check(context.Background())
	st := k.Status()
	if h.holds != 0 || st.Holding || st.Available || st.Reason != "no systemd-inhibit" {
		t.Fatalf("unavailable holder used: %+v holds=%d", st, h.holds)
	}
}

func TestRunReleasesOnExit(t *testing.T) {
	h := &fakeHolder{}
	mode, busy := ModeAlways, 0
	k, _ := newKeeper(h, &mode, &busy)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		k.Run(ctx, time.Hour)
		close(done)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for !h.Held() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !h.Held() {
		t.Fatal("Run did not check at start")
	}
	cancel()
	<-done
	if h.Held() || h.releases != 1 {
		t.Fatalf("not released on exit: held=%v releases=%d", h.Held(), h.releases)
	}
}

func TestWakeChecksNow(t *testing.T) {
	h := &fakeHolder{}
	var mu sync.Mutex
	mode := ModeOff
	k := &Keeper{Holder: h, Mode: func() string { mu.Lock(); defer mu.Unlock(); return mode }}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go k.Run(ctx, time.Hour)
	mu.Lock()
	mode = ModeAlways
	mu.Unlock()
	k.Wake()
	deadline := time.Now().Add(2 * time.Second)
	for !h.Held() && time.Now().Before(deadline) {
		k.Wake()
		time.Sleep(5 * time.Millisecond)
	}
	if !h.Held() {
		t.Fatal("Wake did not trigger a check")
	}
}

func TestNilKeeperStatus(t *testing.T) {
	var k *Keeper
	st := k.Status()
	if st.Available || st.Holding || st.Reason == "" {
		t.Fatalf("nil keeper: %+v", st)
	}
}
