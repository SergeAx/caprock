package keepawake

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// NewOS returns this machine's holder: systemd-inhibit taking an idle and
// sleep lock for as long as the command it runs lives. That command is a
// shell loop that ends once the daemon's pid is gone (kill -0 sends no
// signal; it only asks whether the pid exists), so a crash lets go within
// ten seconds; Release stops the whole process group at once.
//
// Without systemd-inhibit (no systemd, a container) there is nothing to ask,
// and the feature says so instead of pretending.
func NewOS() Holder {
	path, err := exec.LookPath("systemd-inhibit")
	if err != nil {
		return &childHolder{unavailable: "systemd-inhibit was not found, so Caprock cannot keep this computer awake."}
	}
	watch := "while kill -0 " + strconv.Itoa(os.Getpid()) + " 2>/dev/null; do sleep 10; done"
	return &childHolder{
		argv: []string{path, "--what=idle:sleep", "--who=Caprock", "--why=Agents are working", "--mode=block", "/bin/sh", "-c", watch},
		setup: func(c *exec.Cmd) {
			// Its own process group, so Release stops the shell loop with it.
			c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		},
		stop: func(c *exec.Cmd) {
			if err := syscall.Kill(-c.Process.Pid, syscall.SIGTERM); err != nil {
				_ = c.Process.Kill()
			}
		},
	}
}
