package procstat

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/shirou/gopsutil/v4/process"
)

// rusageInfoV2 is Darwin's struct rusage_info_v2 (sys/resource.h).
type rusageInfoV2 struct {
	UUID           [16]byte
	UserTime       uint64
	SystemTime     uint64
	PkgIdleWkups   uint64
	InterruptWkups uint64
	Pageins        uint64
	WiredSize      uint64
	ResidentSize   uint64
	PhysFootprint  uint64
	_              [10]uint64 // start/exit times, the children's figures, disk I/O
}

const rusageInfoV2Flavor = 2

var (
	rusageOnce sync.Once
	pidRusage  func(pid int32, flavor int32, buf unsafe.Pointer) int32
)

// ownMemory is the physical footprint — Activity Monitor's Memory column:
// the process's dirty and compressed pages, without the clean file pages it
// maps. Falls back to the resident set when libproc cannot be reached.
func ownMemory(p *process.Process) (uint64, error) {
	rusageOnce.Do(func() {
		lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&pidRusage, lib, "proc_pid_rusage")
	})
	if pidRusage != nil {
		var ri rusageInfoV2
		if pidRusage(p.Pid, rusageInfoV2Flavor, unsafe.Pointer(&ri)) == 0 && ri.PhysFootprint > 0 {
			return ri.PhysFootprint, nil
		}
	}
	m, err := p.MemoryInfo()
	if err != nil {
		return 0, err
	}
	if m.RSS == 0 {
		return 0, errors.New("no memory reading")
	}
	return m.RSS, nil
}
