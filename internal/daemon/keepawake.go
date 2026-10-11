package daemon

// Keeping the computer awake while agents work (ADR-049): the daemon's half,
// which decides what "working" means. The rules and the OS calls are in
// internal/keepawake.

import (
	"context"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/keepawake"
	"github.com/dspv/caprock/internal/narrate"
	"github.com/dspv/caprock/internal/store"
)

// keepAwakeEvery is how often the keeper looks. Idle sleep is measured in
// minutes, so a quarter of one is soon enough to take the hold and to let it
// go; a changed setting is acted on at once (Keeper.Wake).
const keepAwakeEvery = 15 * time.Second

// keepAwakeScan bounds how many live sessions one check reads.
const keepAwakeScan = 200

// startKeepAwake builds the keeper and runs it for the daemon's lifetime. A
// daemon given no holder (tests, the smoke run) gets a keeper that reports
// itself unavailable and never touches the OS.
func (d *Daemon) startKeepAwake(ctx context.Context) {
	d.awake = &keepawake.Keeper{
		Holder: d.opt.KeepAwake,
		Mode:   func() string { return d.config().KeepAwake },
		Busy:   d.workingSessions,
		Log:    d.log,
	}
	if d.opt.KeepAwake == nil {
		return
	}
	go d.awake.Run(ctx, keepAwakeEvery)
}

// keepAwakeStatus is GET /v1/keepawake.
func (d *Daemon) keepAwakeStatus() any { return d.awake.Status() }

// workingSessions counts the sessions, of any agent, that are working now:
// the main thread mid-turn, subagents still at work after it, or a
// permission dialog waiting for an answer — the machine must stay reachable
// for an approval sent from the phone. A turn that ended waits on nobody and
// does not count.
//
// Silence longer than keepawake.Silence ends it whatever the last event
// said: a tool call in flight sends nothing until it returns, so a long
// build is believed for half an hour, and a session whose process died
// mid-turn stops holding the machine after that.
func (d *Daemon) workingSessions(ctx context.Context) (int, error) {
	db := d.store.DB()
	list, err := store.ListSessions(ctx, db, true, keepAwakeScan)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	cutoff := now.Add(-keepawake.Silence).UnixMilli()
	n := 0
	for _, s := range list {
		if s.Status == store.StatusEnded || s.LastEventAt < cutoff {
			continue
		}
		if d.mgr != nil && d.mgr.IsShell(s.SessionID) {
			continue
		}
		last, err := store.LastEvents(ctx, db, s.SessionID, 20)
		if err != nil {
			return 0, err
		}
		subs, err := store.LiveSubagents(ctx, db, s.SessionID, now.Add(-store.LiveSubagentWindow).UnixMilli())
		if err != nil {
			return 0, err
		}
		act := narrate.Summarize(last, narrate.Options{Now: now, IdleAfter: keepawake.Silence, LiveSubagents: subs})
		if busy(act, last) {
			n++
		}
	}
	return n, nil
}

// busy reads one session's activity as working or not, for the keeper. A
// failed tool call (HealthError) is still a turn in progress.
func busy(act narrate.Activity, last []event.Event) bool {
	switch act.Health {
	case narrate.HealthWorking, narrate.HealthError:
		return true
	case narrate.HealthWaiting:
		// Waiting for approval, not for a prompt: the turn is still open.
		return len(last) > 0 && last[len(last)-1].Kind == event.KindPermissionPrompt
	}
	return false
}
