package daemon

import (
	"testing"
	"time"
)

// A session is hot after a minute over a limit, stays hot through a short
// dip, and cools after hotClearAfter under both.
func TestHotNeedsAMinuteAndCoolsSlowly(t *testing.T) {
	m := newResourceMeter()
	t0 := time.Unix(10_000, 0)
	at := func(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }
	sample := func(sec int, cpu float64, rss uint64, warm bool) SessionResources {
		s := SessionResources{SessionID: "s", CPUPct: cpu, MemBytes: rss, Warm: warm}
		m.judge(&s, at(sec))
		return s
	}
	if s := sample(0, 500, 0, false); s.Hot || s.OverSince != 0 {
		t.Fatalf("a cold sample judged: %+v", s)
	}
	if s := sample(5, 150, 0, true); s.Hot || s.OverSince != at(5).UnixMilli() {
		t.Fatalf("first sample over: %+v", s)
	}
	if s := sample(60, 150, 0, true); s.Hot {
		t.Fatal("hot before a full minute")
	}
	if s := sample(65, 120, 0, true); !s.Hot {
		t.Fatal("not hot after a minute over one core")
	}
	if s := sample(70, 20, 0, true); !s.Hot {
		t.Fatal("one sample under cooled it")
	}
	if s := sample(75, 130, 0, true); !s.Hot {
		t.Fatal("back over: still hot")
	}
	sample(80, 10, 0, true)
	if s := sample(95, 10, 0, true); s.Hot || s.OverSince != 0 {
		t.Fatalf("still hot after %v under: %+v", hotClearAfter, s)
	}
	// Memory alone counts too.
	sample(100, 1, hotMemBytes, true)
	if s := sample(160, 1, hotMemBytes+1, true); !s.Hot {
		t.Fatal("a minute over the memory limit is hot")
	}
}

func TestIsAppName(t *testing.T) {
	for name, want := range map[string]bool{"caprock-app": true, "caprock-app.exe": true, "Caprock-App.EXE": true, "caprock": false, "caprock-hook": false} {
		if isAppName(name) != want {
			t.Errorf("isAppName(%q) = %v", name, !want)
		}
	}
}
