//go:build windows

package daemon

import "os"

// terminate ends the holder at once: Windows has no SIGTERM to ask with.
// Its pseudoconsole closes, which closes the shell attached to it.
func terminate(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

// kill is terminate: there is nothing harder to send.
func kill(pid int) error { return terminate(pid) }
