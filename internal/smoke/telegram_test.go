//go:build smoke

package smoke

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/telegram/telegramtest"
)

// ADR-047 end to end on the real binary, with the fake claude and a fake Bot
// API in place of api.telegram.org: a token checked and a chat paired with a
// code; a permission prompt in an owned session reaches the chat headed with
// whose it is, and Approve answers it; a reply to that message is typed into
// the session; its next Stop answers in the chat at once; a reply to a
// session Caprock did not start types nothing; /new starts one in a project.
// The token never reaches the daemon's log.
func TestTelegramBridgeEndToEnd(t *testing.T) {
	const token = "7777:SMOKE-secret-token"
	const owner = int64(4242)
	bot := telegramtest.New(token, "smoke_caprock_bot")
	defer bot.Close()

	root := t.TempDir()
	bin, home, data, proj := filepath.Join(root, "bin"), filepath.Join(root, "home"), filepath.Join(root, "data"), filepath.Join(root, "proj")
	for _, d := range []string{bin, home, data, proj} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	caprock := filepath.Join(bin, "caprock"+exe)
	goBuild(t, caprock, "./cmd/caprock")
	goBuild(t, filepath.Join(bin, "claude"+exe), "./testdata/fakeclaude")
	t.Cleanup(func() {
		killHolders(t, data)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})
	port := freePort(t)
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	env := append(daemonEnv(bin, home, data), "CAPROCK_TELEGRAM_API="+bot.URL())
	d := startBinary(t, caprock, env, port, data, "telegram")
	defer func() {
		if strings.Contains(d.log(), token) || strings.Contains(d.log(), "SMOKE-secret") {
			t.Errorf("the bot token reached the daemon's log")
		}
	}()

	call := func(method, path, body string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s\nsent: %+v\ndaemon log:\n%s", what, bot.Sent(), d.log())
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	lastMessage := func() telegramtest.Sent {
		m := bot.Messages()
		return m[len(m)-1]
	}

	// Premium and the switch, and approval alerts on.
	if code, body := call(http.MethodPut, "/v1/settings", `{"license_key":"CR-2099-01-01-SMOKE123","telegram_chat":true,"alert_approval":true}`); code != http.StatusOK {
		t.Fatalf("settings: %d %s", code, body)
	}
	// The token, checked; then the code, sent from the owner's chat.
	if code, body := call(http.MethodPut, "/v1/telegram/token", `{"token":"`+token+`"}`); code != http.StatusOK || strings.Contains(body, "SMOKE") {
		t.Fatalf("token: %d %s", code, body)
	}
	_, body := call(http.MethodPost, "/v1/telegram/pair", ``)
	var st struct {
		ChatSet bool   `json:"chat_set"`
		Chat    string `json:"chat_name"`
		Pairing *struct {
			Code string `json:"code"`
		} `json:"pairing"`
	}
	if err := json.Unmarshal([]byte(body), &st); err != nil || st.Pairing == nil {
		t.Fatalf("pair: %s", body)
	}
	bot.Say(owner, "Owner", "/start "+st.Pairing.Code)
	waitFor("pairing", func() bool {
		_, body := call(http.MethodGet, "/v1/telegram", ``)
		_ = json.Unmarshal([]byte(body), &st)
		return st.ChatSet && st.Chat == "Owner"
	})

	// An owned session shows a dialog; its hook reaches the chat with
	// Approve, Deny and Mute.
	id := spawnOwned(t, base, proj)
	term := attachTerm(t, base, id)
	defer term.close()
	term.waitFor(t, "fake-claude ready")
	term.send(t, "ask\r")
	term.waitFor(t, "asked")
	before := len(bot.Messages())
	postHook(t, base, data, `{"session_id":"`+id+`","cwd":"`+filepath.ToSlash(proj)+`","hook_event_name":"PermissionRequest","tool_name":"Bash",`+
		`"tool_input":{"command":"date > out.txt"}}`)
	waitFor("the approval message", func() bool { return len(bot.Messages()) > before })
	ask := lastMessage()
	if !strings.HasPrefix(ask.Text, "🟠 Claude Code · proj") || !strings.Contains(ask.Text, "Needs approval") || strings.Join(ask.Buttons, ",") != "y,n,m" {
		t.Fatalf("approval message = %+v", ask)
	}
	bot.Press(owner, ask.MessageID, "y")
	waitFor("the prompt answered", func() bool {
		for _, a := range bot.Answers() {
			if a == "Approved." {
				return true
			}
		}
		return false
	})
	waitPermission(t, base, id, false)

	// A reply to that message is typed into the session. The fake claude
	// reads whole lines, so Approve's key — "1", the Yes option read off its
	// menu — leads the line: real Claude Code acts on the digit alone.
	bot.Reply(owner, ask.MessageID, "hello from telegram")
	term.waitFor(t, "you-said:1hello from telegram")

	// The session's next Stop answers in the chat at once.
	before = len(bot.Messages())
	postHook(t, base, data, `{"session_id":"`+id+`","cwd":"`+filepath.ToSlash(proj)+`","hook_event_name":"Stop","last_assistant_message":"All done: the date is in out.txt."}`)
	waitFor("the reply", func() bool { return len(bot.Messages()) > before })
	if r := lastMessage(); !strings.HasPrefix(r.Text, "🟠 Claude Code · proj") || !strings.Contains(r.Text, "All done: the date is in out.txt.") {
		t.Fatalf("reply = %+v", r)
	}

	// A session Caprock did not start: watched, never typed into.
	ext := "11111111-2222-3333-4444-555555555555"
	before = len(bot.Messages())
	postHook(t, base, data, `{"session_id":"`+ext+`","cwd":"`+filepath.ToSlash(proj)+`","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}`)
	waitFor("the outside session's alert", func() bool { return len(bot.Messages()) > before })
	extMsg := lastMessage()
	if strings.Contains(strings.Join(extMsg.Buttons, ","), "y") {
		t.Fatalf("a session Caprock did not start got Approve: %+v", extMsg)
	}
	bot.Reply(owner, extMsg.MessageID, "rm -rf ~")
	waitFor("the refusal", func() bool { return strings.Contains(lastMessage().Text, "I can only watch this one") })

	// /new starts Claude Code in a project.
	if code, body := call(http.MethodPost, "/v1/projects", `{"path":"`+filepath.ToSlash(proj)+`"}`); code >= 300 {
		t.Fatalf("add project: %d %s", code, body)
	}
	bot.Say(owner, "Owner", "/new proj say hello")
	waitFor("the start", func() bool { return strings.Contains(lastMessage().Text, "Started") })
}
