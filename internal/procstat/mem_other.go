//go:build !darwin && !linux && !windows

package procstat

import "github.com/shirou/gopsutil/v4/process"

// ownMemory is the resident set where nothing better is read.
func ownMemory(p *process.Process) (uint64, error) {
	m, err := p.MemoryInfo()
	if err != nil {
		return 0, err
	}
	return m.RSS, nil
}
