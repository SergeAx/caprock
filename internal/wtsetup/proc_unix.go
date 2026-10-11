//go:build !windows

package wtsetup

import (
	"os"
	"os/exec"
	"syscall"
)

// shellCommand runs script through /bin/sh in a process group of its own, so
// a timeout or Ctrl+C stops everything it started, and so the terminal's
// Ctrl+C reaches the wrapper (the foreground group) rather than the script.
func shellCommand(script string) *exec.Cmd {
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

// stopTree signals the script's whole process group: SIGTERM first, SIGKILL
// when force is set.
func stopTree(cmd *exec.Cmd, force bool) {
	if cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}

// become replaces this process with the agent, so the session's process —
// the one Caprock recorded, signals and watches — is the agent itself.
func become(args []string) error {
	path, err := exec.LookPath(args[0])
	if err != nil {
		return err
	}
	return syscall.Exec(path, args, os.Environ())
}
