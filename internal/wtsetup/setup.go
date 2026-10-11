package wtsetup

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"time"
)

// The wrapper's inputs travel in the environment rather than on its command
// line, so the script needs no quoting and does not sit in the process list;
// both are removed before the agent starts.
const (
	EnvCommand = "CAPROCK_SETUP_COMMAND"
	EnvTimeout = "CAPROCK_SETUP_TIMEOUT"
	EnvNote    = "CAPROCK_SETUP_NOTE"
)

// DefaultTimeout bounds a setup command: long enough for a cold `npm install`
// on a slow network, short enough that a hung one does not keep the agent
// from starting all afternoon. Ctrl+C skips it sooner.
const DefaultTimeout = 10 * time.Minute

// MaxCommand caps a project's setup command: a line or a short script.
const MaxCommand = 4 << 10

// Marker is written to the terminal once setup is over and the agent is
// about to start: an OSC sequence a terminal ignores, which tells the daemon
// that what is drawn next is the agent's own screen (a first message must
// not be typed into the setup).
const Marker = "\x1b]777;caprock-setup-done\x07"

// Subcommand is the hidden `caprock` subcommand that runs Main.
const Subcommand = "worktree-setup"

// Outcome is how a setup run ended.
type Outcome struct {
	Took        time.Duration
	Err         error // the command failed, or could not start
	TimedOut    bool
	Interrupted bool // Ctrl+C
}

// Line is the outcome as the one line the terminal shows.
func (o Outcome) Line(timeout time.Duration) string {
	took := o.Took.Round(time.Second)
	switch {
	case o.TimedOut:
		return fmt.Sprintf("\x1b[33mSetup did not finish in %s and was stopped. Starting the agent anyway.\x1b[0m", timeout)
	case o.Interrupted:
		return "\x1b[33mSetup stopped (Ctrl+C). Starting the agent.\x1b[0m"
	case o.Err != nil:
		return fmt.Sprintf("\x1b[31mSetup failed after %s: %v. Starting the agent anyway.\x1b[0m", took, o.Err)
	}
	return fmt.Sprintf("\x1b[32mSetup finished in %s.\x1b[0m", took)
}

// Run runs script in dir through the system shell with output to out and no
// input, and stops it — the whole process tree — at timeout or when
// interrupt fires.
func Run(script, dir string, timeout time.Duration, out io.Writer, interrupt <-chan os.Signal) Outcome {
	start := time.Now()
	cmd := shellCommand(script)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		return Outcome{Took: time.Since(start), Err: err}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var o Outcome
	select {
	case err := <-done:
		o.Err = err
		o.Took = time.Since(start)
		return o
	case <-timer.C:
		o.TimedOut = true
	case <-interrupt:
		o.Interrupted = true
	}
	stopTree(cmd, false)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		// Ignored the polite request: the whole tree goes now.
		stopTree(cmd, true)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	o.Took = time.Since(start)
	return o
}

// Main is `caprock worktree-setup -- <agent> <args…>`: run the setup command
// named in the environment, say how it went, then become the agent. It is
// what a session's terminal runs first when its fresh worktree has a setup
// command (agents.Spawn). Never started by a person.
func Main(args []string, stdout io.Writer) int {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(stdout, "caprock worktree-setup: no agent to start")
		return 2
	}
	script := os.Getenv(EnvCommand)
	timeout := DefaultTimeout
	if v, err := strconv.Atoi(os.Getenv(EnvTimeout)); err == nil && v > 0 {
		timeout = time.Duration(v) * time.Second
	}
	note := os.Getenv(EnvNote)
	for _, k := range []string{EnvCommand, EnvTimeout, EnvNote} {
		_ = os.Unsetenv(k)
	}
	dir, _ := os.Getwd()
	if note != "" {
		fmt.Fprintf(stdout, "\x1b[2mCaprock: %s.\x1b[0m\r\n", note)
	}
	if strings.TrimSpace(script) != "" {
		fmt.Fprintf(stdout, "\x1b[2mCaprock: setting up this copy before the agent starts — Ctrl+C skips it.\x1b[0m\r\n\x1b[1m$ %s\x1b[0m\r\n", firstLine(script))
		interrupt := make(chan os.Signal, 1)
		signal.Notify(interrupt, os.Interrupt)
		o := Run(script, dir, timeout, stdout, interrupt)
		signal.Stop(interrupt)
		fmt.Fprintf(stdout, "\r\n%s\r\n", o.Line(timeout))
	}
	fmt.Fprint(stdout, Marker)
	if err := become(args); err != nil {
		fmt.Fprintf(stdout, "\x1b[31mCaprock could not start %s: %v\x1b[0m\r\n", args[0], err)
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		return 127
	}
	return 0
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return s[:i] + " …"
	}
	return s
}
