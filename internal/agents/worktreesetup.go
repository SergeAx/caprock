package agents

// A fresh worktree made ready to run (ADR-050): the git-ignored files its
// repository lists in .worktreeinclude are copied in, and the project's setup
// command runs in the agent's own terminal before the agent starts. The
// copying and the wrapper are internal/wtsetup; this is where a spawn uses
// them.

import (
	"bytes"
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/ptyman"
	"github.com/dspv/caprock/internal/wtsetup"
)

// worktreeSetup is what a fresh worktree still needs when its terminal
// starts: the setup command, and a line about what was copied.
type worktreeSetup struct {
	command string
	note    string
}

// prepareWorktree copies .worktreeinclude's files from the checkout the
// worktree was made from, and looks up the project's setup command. Nothing
// here can stop the spawn: a failed copy is logged and said in the terminal.
func (m *Manager) prepareWorktree(ctx context.Context, from string, wt madeWorktree) worktreeSetup {
	var s worktreeSetup
	src := wt.Repo
	if src == "" {
		src = from
	}
	c, err := wtsetup.CopyIncluded(ctx, src, wt.Dir)
	switch {
	case err != nil:
		m.log.Warn("could not copy .worktreeinclude files", "component", "agents", "worktree", wt.Dir, "err", err)
		s.note = "could not copy from " + wtsetup.IncludeFile + ": " + err.Error()
	case c.Files > 0 || c.Skipped > 0 || c.OverLimit:
		m.log.Info("copied .worktreeinclude files", "component", "agents", "worktree", wt.Dir, "files", c.Files, "bytes", c.Bytes, "skipped", c.Skipped)
		s.note = c.Summary()
	}
	if m.ProjectSetup != nil {
		s.command = strings.TrimSpace(m.ProjectSetup(from))
	}
	return s
}

// wrap points spec at the setup wrapper when there is a setup command to
// run, and reports whether it did. Without the Caprock binary to run it from
// (a daemon run in-process by tests) the agent starts directly and the
// command is skipped, which the log says.
func (s worktreeSetup) wrap(spec *ptyman.Spec, exe string) bool {
	if s.command == "" {
		return false
	}
	if exe == "" {
		return false
	}
	spec.Args = append([]string{wtsetup.Subcommand, "--", spec.Command}, spec.Args...)
	spec.Command = exe
	spec.Env = append(spec.Env,
		wtsetup.EnvCommand+"="+s.command,
		wtsetup.EnvTimeout+"="+strconv.Itoa(int(wtsetup.DefaultTimeout/time.Second)),
	)
	if s.note != "" {
		spec.Env = append(spec.Env, wtsetup.EnvNote+"="+s.note)
	}
	return true
}

var setupMarker = []byte(wtsetup.Marker)

// sawSetupMarker reports, once, that the wrapper finished setup and is
// starting the agent. A marker split across two reads is missed; the first
// message is then typed after the setup's own bound instead (typeWhenReady).
func (a *Agent) sawSetupMarker(chunk []byte) bool {
	select {
	case <-a.setupDone:
		return false
	default:
	}
	if !bytes.Contains(chunk, setupMarker) {
		return false
	}
	close(a.setupDone)
	return true
}

// awaitSetup waits until a session's setup is over, its process ends, or the
// setup's own time limit (plus a margin) has passed. True unless the process
// ended.
func (a *Agent) awaitSetup() bool {
	if a.setupDone == nil {
		return true
	}
	t := time.NewTimer(wtsetup.DefaultTimeout + 30*time.Second)
	defer t.Stop()
	select {
	case <-a.setupDone:
		return true
	case <-a.done:
		return false
	case <-t.C:
		return true
	}
}
