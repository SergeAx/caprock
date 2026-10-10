package procstat

import "github.com/shirou/gopsutil/v4/process"

// ownMemory is the process's private bytes (PagefileUsage): memory that is
// its own, without the file pages in its working set.
func ownMemory(p *process.Process) (uint64, error) {
	m, err := p.MemoryInfo()
	if err != nil {
		return 0, err
	}
	if m.VMS > 0 {
		return m.VMS, nil
	}
	return m.RSS, nil
}
