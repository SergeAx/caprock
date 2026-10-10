package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Settings → Subscriptions (ADR-048): more than one sign-in to Claude Code or
// Codex, each in a configuration directory of Caprock's, and the one a new
// session runs on picked in New agent and Quick chat.

// Errors a SubscriptionManager answers with, mapped to statuses here.
var (
	// ErrSubscriptionPremium: the agent already has the free number of
	// subscriptions and there is no licence.
	ErrSubscriptionPremium = errors.New("premium required")
	// ErrSubscriptionInUse: a session Caprock started is running on it.
	ErrSubscriptionInUse = errors.New("a session is running on this subscription")
	// ErrSubscriptionNotFound: no subscription with that id.
	ErrSubscriptionNotFound = errors.New("no such subscription")
)

// SubscriptionWindow is one plan window as last reported for a subscription.
type SubscriptionWindow struct {
	Window         string  `json:"window"` // five_hour | seven_day
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`   // unix seconds
	ObservedAt     int64   `json:"observed_at"` // unix ms
}

// Subscription is one sign-in, as Settings and the pickers show it.
type Subscription struct {
	// ID is "default" for the user's own sign-in.
	ID      string `json:"id"`
	Agent   string `json:"agent"`
	Label   string `json:"label"`
	Default bool   `json:"default"`
	// Dir is its configuration directory; EnvVar the variable that selects it
	// ("" for the Default one, which uses none).
	Dir    string `json:"dir"`
	EnvVar string `json:"env_var,omitempty"`
	// SignedIn and Account are read from files the agent wrote (internal/subs).
	SignedIn bool   `json:"signed_in"`
	Account  string `json:"account,omitempty"`
	// LoginCommand is the agent's own sign-in for this directory, to be typed
	// into a shell tab and run by the user.
	LoginCommand string               `json:"login_command"`
	Windows      []SubscriptionWindow `json:"windows"`
	// Sessions7d and Cost7dUSD are the last seven days of priced work on it.
	Sessions7d int64   `json:"sessions_7d"`
	Cost7dUSD  float64 `json:"cost_7d_usd"`
	// Running is how many sessions Caprock started are running on it.
	Running   int   `json:"running"`
	CreatedAt int64 `json:"created_at,omitempty"`
}

// SubscriptionAgent groups one agent's subscriptions, the Default one first.
type SubscriptionAgent struct {
	Agent         string         `json:"agent"`
	Label         string         `json:"label"`
	Installed     bool           `json:"installed"`
	Subscriptions []Subscription `json:"subscriptions"`
}

// SubscriptionsResponse is GET /v1/subscriptions.
type SubscriptionsResponse struct {
	Agents       []SubscriptionAgent `json:"agents"`
	Licensed     bool                `json:"licensed"`
	FreePerAgent int                 `json:"free_per_agent"`
	// Home is where a sign-in's shell tab opens.
	Home string `json:"home,omitempty"`
}

// SubscriptionManager is the daemon's side.
type SubscriptionManager interface {
	List(ctx context.Context) (SubscriptionsResponse, error)
	Add(ctx context.Context, agent, label string) (Subscription, error)
	Rename(ctx context.Context, id, label string) (Subscription, error)
	Remove(ctx context.Context, id string) error
}

func (s *Server) handleSubscriptions(w http.ResponseWriter, r *http.Request) {
	if s.d.Subscriptions == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "subscriptions are unavailable"})
		return
	}
	out, err := s.d.Subscriptions.List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// subscriptionsWritable refuses what only the machine's owner may do: a
// subscription is a sign-in on this machine, set up at it (ADR-034).
func (s *Server) subscriptionsWritable(w http.ResponseWriter, r *http.Request) bool {
	if s.d.Subscriptions == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "subscriptions are unavailable"})
		return false
	}
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "subscriptions are set up on the machine Caprock runs on"})
		return false
	}
	return true
}

func (s *Server) subscriptionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrSubscriptionPremium):
		writeJSON(w, http.StatusPaymentRequired, map[string]string{
			"error":  "premium required",
			"detail": "three subscriptions per agent are free, your own sign-in included; more need Premium",
		})
	case errors.Is(err, ErrSubscriptionInUse):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrSubscriptionNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

func (s *Server) handleAddSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionsWritable(w, r) {
		return
	}
	var body struct {
		Agent string `json:"agent"`
		Label string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"agent": "claude"|"codex", "label": "…"}`})
		return
	}
	sub, err := s.d.Subscriptions.Add(r.Context(), body.Agent, body.Label)
	if err != nil {
		s.subscriptionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

func (s *Server) handleRenameSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionsWritable(w, r) {
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"label": "…"}`})
		return
	}
	sub, err := s.d.Subscriptions.Rename(r.Context(), r.PathValue("id"), body.Label)
	if err != nil {
		s.subscriptionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

func (s *Server) handleRemoveSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionsWritable(w, r) {
		return
	}
	if err := s.d.Subscriptions.Remove(r.Context(), r.PathValue("id")); err != nil {
		s.subscriptionError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
