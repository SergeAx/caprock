package procstat

import (
	"bufio"
	"os"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/process"
)

// ownMemory is the resident memory that is the process's own: anonymous and
// shared-memory pages (RssAnon + RssShmem in /proc/<pid>/status), without the
// file pages it maps. Falls back to the resident set on an older kernel.
func ownMemory(p *process.Process) (uint64, error) {
	if f, err := os.Open("/proc/" + strconv.Itoa(int(p.Pid)) + "/status"); err == nil {
		defer func() { _ = f.Close() }()
		var kb uint64
		found := false
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			k, v, ok := strings.Cut(sc.Text(), ":")
			if !ok || (k != "RssAnon" && k != "RssShmem") {
				continue
			}
			if n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64); err == nil {
				kb += n
				found = true
			}
		}
		if found {
			return kb * 1024, nil
		}
	}
	m, err := p.MemoryInfo()
	if err != nil {
		return 0, err
	}
	return m.RSS, nil
}
