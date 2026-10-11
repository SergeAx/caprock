package keepawake

import (
	"fmt"
	"runtime"
	"sync"

	"golang.org/x/sys/windows"
)

// SetThreadExecutionState flags (winbase.h).
const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

var procSetThreadExecutionState = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadExecutionState")

// winHolder sets ES_SYSTEM_REQUIRED from one OS thread that lives as long as
// the process. The state belongs to the thread that set it, so every call is
// made from that thread; Windows drops it when the process exits, crash
// included. The display may still turn off.
type winHolder struct {
	once sync.Once
	req  chan bool
	resp chan error

	mu   sync.Mutex
	held bool
}

// NewOS returns this machine's holder.
func NewOS() Holder { return &winHolder{} }

func (h *winHolder) start() {
	h.once.Do(func() {
		h.req, h.resp = make(chan bool), make(chan error)
		go func() {
			runtime.LockOSThread() // never unlocked: the state lives on this thread
			for on := range h.req {
				flags := uintptr(esContinuous)
				if on {
					flags |= esSystemRequired
				}
				r, _, err := procSetThreadExecutionState.Call(flags)
				if r == 0 {
					h.resp <- fmt.Errorf("SetThreadExecutionState: %w", err)
					continue
				}
				h.resp <- nil
			}
		}()
	})
}

func (h *winHolder) set(on bool) error {
	if err := procSetThreadExecutionState.Find(); err != nil {
		return err
	}
	h.start()
	h.req <- on
	return <-h.resp
}

func (h *winHolder) Available() (bool, string) {
	if err := procSetThreadExecutionState.Find(); err != nil {
		return false, "Windows did not offer SetThreadExecutionState, so Caprock cannot keep this computer awake."
	}
	return true, ""
}

func (h *winHolder) Hold() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.held {
		return nil
	}
	if err := h.set(true); err != nil {
		return err
	}
	h.held = true
	return nil
}

func (h *winHolder) Release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.held {
		return
	}
	_ = h.set(false)
	h.held = false
}

func (h *winHolder) Held() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.held
}
