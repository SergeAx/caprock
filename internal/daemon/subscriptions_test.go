package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/loop"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

func subsDaemon(t *testing.T) *Daemon {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Daemon{
		store: st, log: log, bus: bus.New(), baseCtx: context.Background(),
		mgr:   agents.NewManager(st, t.TempDir(), "", log),
		opt:   Options{Config: config.Defaults(), DataDir: t.TempDir(), DisableIngest: true},
		table: &cost.Table{}, det: loop.New(5, time.Minute),
		start: time.Now(),
	}
}

func TestSubscriptionsAddRenameRemove(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	ctx := context.Background()

	work, err := a.Add(ctx, "claude", "  Work  Max ")
	if err != nil {
		t.Fatal(err)
	}
	if work.Label != "Work Max" || work.EnvVar != "CLAUDE_CONFIG_DIR" || work.SignedIn || work.LoginCommand == "" {
		t.Fatalf("added: %+v", work)
	}
	dir := subs.Dir(d.opt.DataDir, work.ID)
	if st, err := hooks.Inspect(filepath.Join(dir, "settings.json"), hooks.ShimCommand(d.opt.DataDir)); err != nil || len(st.Missing) != 0 {
		t.Fatalf("hooks in the new directory: %+v %v", st, err)
	}
	// Saved, so a restart keeps it.
	saved, err := config.Load(d.opt.DataDir)
	if err != nil || len(saved.Subscriptions) != 1 {
		t.Fatalf("saved: %+v %v", saved.Subscriptions, err)
	}

	if _, err := a.Add(ctx, "claude", "work max"); err == nil {
		t.Fatal("a second subscription with the same name was added")
	}
	if _, err := a.Add(ctx, "claude", "Default"); err == nil {
		t.Fatal("a subscription called Default was added")
	}
	if _, err := a.Add(ctx, "gemini", "x"); err == nil {
		t.Fatal("a gemini subscription was added")
	}
	if _, err := a.Add(ctx, "claude", "Personal"); err != nil {
		t.Fatal(err)
	}
	// Three per agent are free, the Default one included.
	if _, err := a.Add(ctx, "claude", "Third"); !errors.Is(err, api.ErrSubscriptionPremium) {
		t.Fatalf("a fourth Claude Code sign-in without a licence: %v", err)
	}
	// Codex counts on its own.
	if _, err := a.Add(ctx, "codex", "Team"); err != nil {
		t.Fatal(err)
	}

	list, err := a.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Agents) != 2 || len(list.Agents[0].Subscriptions) != 3 || !list.Agents[0].Subscriptions[0].Default || list.Agents[0].Subscriptions[0].ID != subs.DefaultID {
		t.Fatalf("list: %+v", list.Agents)
	}
	if list.FreePerAgent != 3 || list.Licensed {
		t.Fatalf("list header: %+v", list)
	}

	got, err := a.Rename(ctx, work.ID, "Work")
	if err != nil || got.Label != "Work" {
		t.Fatalf("rename: %+v %v", got, err)
	}
	if _, err := a.Rename(ctx, "nope", "x"); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("rename unknown: %v", err)
	}

	if err := a.Remove(ctx, work.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("directory still there: %v", err)
	}
	if err := a.Remove(ctx, work.ID); !errors.Is(err, api.ErrSubscriptionNotFound) {
		t.Fatalf("remove twice: %v", err)
	}
}

func TestResolveSubscription(t *testing.T) {
	d := subsDaemon(t)
	a := &subsAdapter{d: d}
	ctx := context.Background()
	cx, err := a.Add(ctx, "codex", "Team")
	if err != nil {
		t.Fatal(err)
	}
	sr := agents.SpawnRequest{Agent: "codex", Subscription: cx.ID}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != subs.Dir(d.opt.DataDir, cx.ID) {
		t.Fatalf("codex: %+v %v", sr, err)
	}
	// A Codex subscription does not start Claude Code.
	sr = agents.SpawnRequest{Subscription: cx.ID}
	if err := d.resolveSubscription(&sr, nil); err == nil {
		t.Fatal("a codex subscription started claude")
	}
	// The request cannot name a directory: ConfigDir is not a JSON field.
	sr = agents.SpawnRequest{Subscription: "default", ConfigDir: "/etc"}
	if err := d.resolveSubscription(&sr, nil); err != nil || sr.ConfigDir != "" || sr.Subscription != "" {
		t.Fatalf("default: %+v %v", sr, err)
	}
	// A continued session keeps the subscription it ran on, whatever was asked.
	sr = agents.SpawnRequest{Agent: "codex", Resume: "x"}
	if err := d.resolveSubscription(&sr, &store.Session{Agent: "codex", Subscription: cx.ID}); err != nil || sr.Subscription != cx.ID {
		t.Fatalf("resume: %+v %v", sr, err)
	}
	if err := d.resolveSubscription(&agents.SpawnRequest{Resume: "x"}, &store.Session{Subscription: "gone1"}); err == nil {
		t.Fatal("a session on a removed subscription was continued")
	}
}
