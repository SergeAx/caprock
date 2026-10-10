package ingest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// With fsnotify running, the 2-second poll looks only at recently written
// files, and a wake reads exactly the files fsnotify named. An old transcript
// appended to without its mtime moving (the case the poll cannot see) is read
// when it is reported dirty, and not before.
func TestPollNarrowsToHotFilesAndWakeReadsDirty(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-proj", "s.jsonl")
	writeTranscript(t, path, "77777777-7777-8888-9999-aaaaaaaaaaaa")
	old := time.Now().Add(-2 * hotWindow)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	tl, _ := newTailerAt(t, root)
	if err := tl.discover(nil); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	tl.pass(ctx, true)
	if n := tl.Stats().EventsStored; n != 1 {
		t.Fatalf("first pass stored %d events, want 1", n)
	}
	tl.watching = true

	appendLine := func(uuid, msg string) {
		t.Helper()
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		line := `{"type":"assistant","uuid":"UUID","sessionId":"77777777-7777-8888-9999-aaaaaaaaaaaa","cwd":"/home/u/proj","timestamp":"2026-08-18T10:00:01.000Z","message":{"model":"claude-opus-5","id":"MSG","role":"assistant","content":[{"type":"text","text":"more"}],"usage":{"input_tokens":1,"output_tokens":1}}}` + "\n"
		line = strings.NewReplacer("UUID", uuid, "MSG", msg).Replace(line)
		if _, err := f.WriteString(line); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
		// The mtime put back: only a dirty mark (or the full pass) finds it.
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}

	appendLine("u-2", "m-2")
	tl.passHot(ctx)
	if n := tl.Stats().EventsStored; n != 1 {
		t.Fatalf("the poll read a file outside the hot window: %d events", n)
	}
	tl.mu.Lock()
	tl.dirty[path] = struct{}{}
	tl.mu.Unlock()
	tl.passDirty(ctx)
	if n := tl.Stats().EventsStored; n != 2 {
		t.Fatalf("the wake did not read the dirty file: %d events, want 2", n)
	}
	if len(tl.dirty) != 0 {
		t.Errorf("dirty set not cleared: %v", tl.dirty)
	}

	// Without fsnotify the poll is the only way in, so it reads everything.
	tl.watching = false
	appendLine("u-3", "m-3")
	tl.passHot(ctx)
	if n := tl.Stats().EventsStored; n != 3 {
		t.Fatalf("without fsnotify the poll must read every file: %d events, want 3", n)
	}
}
