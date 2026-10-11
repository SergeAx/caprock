package keepawake

import (
	"os"
	"os/exec"
	"strconv"
)

// caffeinate is macOS's own tool for this. -i prevents idle system sleep
// only: the display still sleeps, the screen still locks, and closing a
// laptop's lid still sleeps it. -w makes it exit when the daemon does, so a
// crash cannot leave the machine held.
const caffeinate = "/usr/bin/caffeinate"

// NewOS returns this machine's holder.
func NewOS() Holder {
	h := &childHolder{
		argv: []string{caffeinate, "-i", "-w", strconv.Itoa(os.Getpid())},
		stop: func(c *exec.Cmd) { _ = c.Process.Kill() },
	}
	if _, err := os.Stat(caffeinate); err != nil {
		h.unavailable = "This Mac has no " + caffeinate + ", so Caprock cannot keep it awake."
	}
	return h
}
