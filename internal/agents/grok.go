package agents

// grokLaunch starts xAI's Grok Build TUI (`grok`), built from its own
// `grok --help`, grok 0.2.114, read on 2026-10-10 (.ai/23-grok.md):
//
//   - `-s, --session-id <UUID>` names a new conversation; Caprock's session
//     ids are UUIDs, so the row in the sessions list and Grok's own session
//     directory share one id, as Claude Code's and Gemini's do.
//   - `-r, --resume <ID>` continues one; `--fork-session` with `--session-id`
//     branches it under a new id ("only valid together with --fork-session"
//     on a resume).
//   - `-m, --model <MODEL>`.
//   - `--permission-mode <MODE>` takes Claude Code's own names: default,
//     acceptEdits, auto, dontAsk, bypassPermissions, plan. Caprock's choice is
//     passed through when it is one of those and left off otherwise.
//   - `--rules <RULES>` appends to the system prompt, the counterpart of
//     Claude Code's --append-system-prompt, so the project's instructions
//     reach it.
//   - `[PROMPT]` positional: "Initial prompt for the interactive session".
//
// Grok writes its sessions to ~/.grok/sessions (its README), but Caprock does
// not read them yet: a Grok session it starts has a row and a terminal, and no
// turns or cost (ADR-045 says why).
//
//nolint:unparam // one signature for every builder; Grok has nothing to refuse
func grokLaunch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID}
	switch {
	case in.Resume != "" && in.Fork:
		native := in.NativeResume
		if native == "" {
			native = in.Resume
		}
		l.args = []string{"--resume", native, "--fork-session", "--session-id", in.SessionID}
	case in.Resume != "":
		native := in.NativeResume
		if native == "" {
			native = in.Resume
		}
		l.args = []string{"--resume", native}
		l.sessionID = in.Resume
	default:
		l.args = []string{"--session-id", in.SessionID}
	}
	if in.Model != "" {
		l.args = append(l.args, "--model", in.Model)
	}
	if grokModes[in.Mode] {
		l.args = append(l.args, "--permission-mode", in.Mode)
	}
	if in.SystemPrompt != "" {
		l.args = append(l.args, "--rules", in.SystemPrompt)
	}
	l.args = append(l.args, in.Extra...)
	if p := promptArg(in); p != "" {
		l.args = append(l.args, p)
	}
	return l, nil
}

// grokModes are the values `grok --permission-mode` accepts.
var grokModes = map[string]bool{
	"default": true, "acceptEdits": true, "auto": true, "dontAsk": true, "bypassPermissions": true, "plan": true,
}
