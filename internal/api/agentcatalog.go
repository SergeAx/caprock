package api

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/agentcat"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/license"
)

// AgentCatalog is what the agent pickers read and the custom agents are kept
// in (ADR-045). The daemon implements it; the API only routes and gates.
type AgentCatalog interface {
	// Catalog lists every agent Caprock knows here, built-in and custom, with
	// what each is missing.
	Catalog() CatalogResponse
	// Custom is the stored list of custom agents, whatever the licence says.
	Custom() []config.CustomAgent
	// SetCustom replaces it with a list already validated.
	SetCustom(list []config.CustomAgent) error
}

// CatalogResponse is GET /v1/agents/catalog.
type CatalogResponse struct {
	Agents []agentcat.Entry `json:"agents"`
	// Licensed says whether custom agents may be added and started.
	Licensed bool `json:"licensed"`
	// Home is the folder a setup shell tab opens in.
	Home string `json:"home,omitempty"`
}

func (s *Server) licensed() bool {
	if s.d.Settings == nil {
		return false
	}
	return license.Parse(s.d.Settings.Get().LicenseKey, s.d.Now()).Active
}

func (s *Server) handleAgentCatalog(w http.ResponseWriter, _ *http.Request) {
	if s.d.Catalog == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the agent catalog is unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, s.d.Catalog.Catalog())
}

type customAgentsBody struct {
	Agents   []config.CustomAgent `json:"agents"`
	Licensed bool                 `json:"licensed"`
}

func (s *Server) handleCustomAgents(w http.ResponseWriter, _ *http.Request) {
	if s.d.Catalog == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "custom agents are unavailable"})
		return
	}
	list := s.d.Catalog.Custom()
	if list == nil {
		list = []config.CustomAgent{}
	}
	writeJSON(w, http.StatusOK, customAgentsBody{Agents: list, Licensed: s.licensed()})
}

// handlePutCustomAgents replaces the custom agents. A paid feature: the
// server refuses without an active licence, so the lock in Settings is not a
// decoration over a working form (the same rule as Ask Gemini's 402). A
// paired device may not set one: a custom agent is a command this machine
// will run, and a phone starts only the agents set up at the machine
// (ADR-034).
func (s *Server) handlePutCustomAgents(w http.ResponseWriter, r *http.Request) {
	if s.d.Catalog == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "custom agents are unavailable"})
		return
	}
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "custom agents are set up on the machine Caprock runs on"})
		return
	}
	if !s.licensed() {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{
			"error":  "premium required",
			"detail": "custom agents are a Premium feature; the built-in agents stay free",
		})
		return
	}
	var body struct {
		Agents []config.CustomAgent `json:"agents"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<18)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"agents": [{name, command, args?, models?}]}`})
		return
	}
	list, err := agentcat.ValidateCustom(body.Agents)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.d.Catalog.SetCustom(list); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, customAgentsBody{Agents: list, Licensed: true})
}
