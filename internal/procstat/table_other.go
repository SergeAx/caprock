//go:build !darwin

package procstat

import (
	"context"

	"github.com/shirou/gopsutil/v4/process"
)

// readProcs lists processes through gopsutil: /proc on Linux, one toolhelp
// snapshot on Windows (which also supplies every parent and name).
func readProcs(ctx context.Context) (map[int32]Proc, error) {
	ps, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[int32]Proc, len(ps))
	for _, p := range ps {
		if p.Pid <= 0 {
			continue
		}
		pr := Proc{PID: p.Pid, UID: -1}
		if ppid, err := p.PpidWithContext(ctx); err == nil {
			pr.PPID = ppid
		}
		if name, err := p.NameWithContext(ctx); err == nil {
			pr.Name = name
		}
		if ms, err := p.CreateTimeWithContext(ctx); err == nil {
			pr.StartMs = ms
		}
		if uids, err := p.UidsWithContext(ctx); err == nil && len(uids) > 0 {
			pr.UID = int64(uids[0])
		}
		out[p.Pid] = pr
	}
	return out, nil
}
