package wtsetup

import (
	"bytes"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestMain doubles as the wrapper: a test re-runs this binary with
// WTSETUP_AS_MAIN set, and it behaves as `caprock worktree-setup`. Main ends
// by replacing the process with the agent, which no in-process test survives.
func TestMain(m *testing.M) {
	if os.Getenv("WTSETUP_AS_MAIN") == "1" {
		args := os.Args[1:]
		for i, a := range args {
			if a == "--" {
				args = args[i:]
				break
			}
		}
		os.Exit(Main(args, os.Stdout))
	}
	os.Exit(m.Run())
}

// echo is the same command for /bin/sh and cmd.exe.
func echo(s string) string { return "echo " + s }

func TestRunSucceeds(t *testing.T) {
	var out bytes.Buffer
	o := Run(echo("installed"), t.TempDir(), time.Minute, &out, nil)
	if o.Err != nil || o.TimedOut || o.Interrupted {
		t.Fatalf("outcome = %+v", o)
	}
	if !strings.Contains(out.String(), "installed") {
		t.Fatalf("output = %q", out.String())
	}
	if !strings.Contains(o.Line(time.Minute), "Setup finished") {
		t.Fatalf("line = %q", o.Line(time.Minute))
	}
}

func TestRunReportsFailure(t *testing.T) {
	o := Run("exit 3", t.TempDir(), time.Minute, &bytes.Buffer{}, nil)
	if o.Err == nil {
		t.Fatal("a failing command reported success")
	}
	if !strings.Contains(o.Line(time.Minute), "Starting the agent anyway") {
		t.Fatalf("line = %q", o.Line(time.Minute))
	}
}

func slow() string {
	if runtime.GOOS == "windows" {
		return "ping -n 30 127.0.0.1 >NUL"
	}
	return "sleep 30"
}

func TestRunStopsAtTheTimeout(t *testing.T) {
	start := time.Now()
	o := Run(slow(), t.TempDir(), 300*time.Millisecond, &bytes.Buffer{}, nil)
	if !o.TimedOut {
		t.Fatalf("outcome = %+v", o)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("took %s to stop", time.Since(start))
	}
	if !strings.Contains(o.Line(300*time.Millisecond), "did not finish") {
		t.Fatalf("line = %q", o.Line(300*time.Millisecond))
	}
}

func TestRunStopsOnInterrupt(t *testing.T) {
	ch := make(chan os.Signal, 1)
	ch <- os.Interrupt
	o := Run(slow(), t.TempDir(), time.Minute, &bytes.Buffer{}, ch)
	if !o.Interrupted {
		t.Fatalf("outcome = %+v", o)
	}
}

// The wrapper end to end: setup output, its outcome, the marker, then the
// agent's own output, in that order, with the setup variables gone from the
// agent's environment.
func TestMainRunsSetupThenTheAgent(t *testing.T) {
	agent := []string{"/bin/sh", "-c", `echo "AGENT ${CAPROCK_SETUP_COMMAND:-clean}"`}
	if runtime.GOOS == "windows" {
		agent = []string{"cmd.exe", "/c", "echo AGENT %CAPROCK_SETUP_COMMAND%"}
	}
	cmd := exec.Command(os.Args[0], append([]string{"-test.run=^$", "--"}, agent...)...)
	cmd.Dir = t.TempDir()
	cmd.Env = append(os.Environ(), "WTSETUP_AS_MAIN=1", EnvCommand+"="+echo("SETUP-RAN"), EnvNote+"=copied 1 file from .worktreeinclude (.env)")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wrapper: %v\n%s", err, out)
	}
	s := string(out)
	setup := strings.Index(s, "SETUP-RAN")
	done := strings.Index(s, "Setup finished")
	marker := strings.Index(s, Marker)
	agentAt := strings.LastIndex(s, "AGENT")
	if setup < 0 || done < setup || marker < done || agentAt < marker {
		t.Fatalf("out of order or missing:\n%q", s)
	}
	if !strings.Contains(s, "copied 1 file from .worktreeinclude") {
		t.Fatalf("the note was not shown:\n%q", s)
	}
	if strings.Contains(s[agentAt:], "SETUP-RAN") {
		t.Fatalf("the agent saw the setup command in its environment:\n%q", s)
	}
}

func TestMainWithoutAnAgent(t *testing.T) {
	if code := Main(nil, &bytes.Buffer{}); code != 2 {
		t.Fatalf("code = %d", code)
	}
}
