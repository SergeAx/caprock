//go:build !windows

package daemon

import "syscall"

// terminate sends SIGTERM: a pty-host passes it to its child and exits when
// the child does.
func terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// kill sends SIGKILL, for a holder whose child ignores SIGTERM (an
// interactive shell does). Its PTY master closes, which hangs the shell up.
func kill(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
