package store

import (
	"context"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func TestSubscriptionIsKeptFromTheFirstWriter(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: "/x", Agent: "claude", Subscription: "ab12"}); err != nil {
		t.Fatal(err)
	}
	// A later event that does not know it, or claims another, changes nothing.
	for _, sub := range []string{"", "zz99"} {
		if err := UpsertSession(ctx, s.db, "s1", SessionPatch{Cwd: "/x", Subscription: sub}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := GetSession(ctx, s.db, "s1")
	if err != nil || got.Subscription != "ab12" {
		t.Fatalf("subscription = %q, %v", got.Subscription, err)
	}
	// A session first seen without one is filled by the first that knows.
	if err := UpsertSession(ctx, s.db, "s2", SessionPatch{Cwd: "/x"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertSession(ctx, s.db, "s2", SessionPatch{Subscription: "cd34"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := GetSession(ctx, s.db, "s2"); got.Subscription != "cd34" {
		t.Fatalf("s2 subscription = %q", got.Subscription)
	}
}

func TestSpendBySubscription(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	add := func(id, agent, sub, key string, cost float64, at time.Time) {
		t.Helper()
		if err := UpsertSession(ctx, s.db, id, SessionPatch{Cwd: "/x", Agent: agent, Subscription: sub}); err != nil {
			t.Fatal(err)
		}
		c := cost
		if _, err := InsertEvent(ctx, s.db, &event.Event{SessionID: id, Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Key: key, Ts: at, CostUSD: &c}); err != nil {
			t.Fatal(err)
		}
	}
	add("a", "claude", "", "k1", 1.5, now)
	add("b", "claude", "ab12", "k2", 2, now)
	add("b", "claude", "ab12", "k3", 0.5, now)
	add("c", "codex", "cd34", "k4", 3, now)
	add("old", "claude", "ab12", "k5", 100, now.Add(-30*24*time.Hour))
	add("g", "gemini", "", "k6", 9, now)

	rows, err := SpendBySubscription(ctx, s.db, now.Add(-7*24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]SubscriptionSpend{}
	for _, r := range rows {
		got[r.Agent+"|"+r.Subscription] = r
	}
	if len(got) != 3 {
		t.Fatalf("rows = %+v", rows)
	}
	if r := got["claude|ab12"]; r.Sessions != 1 || r.CostUSD != 2.5 {
		t.Fatalf("claude|ab12 = %+v", r)
	}
	if r := got["claude|"]; r.CostUSD != 1.5 {
		t.Fatalf("claude default = %+v", r)
	}
	if r := got["codex|cd34"]; r.CostUSD != 3 {
		t.Fatalf("codex = %+v", r)
	}
}
