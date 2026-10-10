package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/telegram"
)

// TelegramController is the bridge to the owner's own Telegram bot
// (ADR-047), as Settings drives it. Every route here is the machine's: none
// is on a paired device's allowlist (ADR-034, "outbound calls").
type TelegramController interface {
	Status() telegram.Status
	Connect(ctx context.Context, token string) (telegram.User, error)
	Disconnect() error
	StartPairing() (telegram.Pairing, error)
	CancelPairing()
}

func (s *Server) requireTelegram(w http.ResponseWriter) bool {
	if s.d.Telegram == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("the Telegram bridge is unavailable"))
		return false
	}
	return true
}

// handleTelegram is GET /v1/telegram: the bot, the chat, a pairing in
// progress and the last failure. The token is never in it — only a mask of
// its last four characters.
func (s *Server) handleTelegram(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramToken is PUT /v1/telegram/token {"token": "…"}: the token is
// checked with Telegram's getMe and stored only when Telegram knows it. 400
// with Telegram's reason otherwise. The answer is the status, not the token.
func (s *Server) handleTelegramToken(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil || body.Token == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"token": "<the token @BotFather gave you>"}`))
		return
	}
	if _, err := s.d.Telegram.Connect(r.Context(), body.Token); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramPair is POST /v1/telegram/pair: a new one-time code. The
// first private chat that sends it to the bot becomes its only chat.
func (s *Server) handleTelegramPair(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	if _, err := s.d.Telegram.StartPairing(); err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramCancelPair is DELETE /v1/telegram/pair.
func (s *Server) handleTelegramCancelPair(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	s.d.Telegram.CancelPairing()
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramDisconnect is DELETE /v1/telegram: the token, the chat and
// what the bridge learned about them are forgotten. The weekly report and the
// alerts share the bot, so they stop too.
func (s *Server) handleTelegramDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	if err := s.d.Telegram.Disconnect(); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// ErrBypassConsent is StartSession refusing a Bypass start before the
// one-time consent (ADR-041).
var ErrBypassConsent error = bypassConsentError{}

type bypassConsentError struct{}

func (bypassConsentError) Error() string { return bypassConsentMsg }

// StartSession starts a session the way POST /v1/agents does — the stated
// mode filled in, the Bypass consent checked — for a caller inside the
// daemon: a /new from the paired Telegram chat (ADR-047).
func (s *Server) StartSession(ctx context.Context, req map[string]any) (string, error) {
	if s.d.Agents == nil || !s.d.Agents.Available() {
		return "", errors.New("no coding agent Caprock can start is on this machine")
	}
	s.defaultSpawnMode(ctx, req)
	if s.needsBypassConsent(req) {
		return "", ErrBypassConsent
	}
	id, _, err := s.d.Agents.Spawn(context.WithoutCancel(ctx), req)
	return id, err
}
