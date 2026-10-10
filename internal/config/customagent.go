package config

// CustomAgent is a coding agent the user added by its command (ADR-045).
//
// Args is a template: `{prompt}` and `{model}` are replaced when the agent
// starts, and an argument whose placeholder has no value is left out,
// along with a flag right before it ("-m", "{model}" with no model chosen
// leaves both out). See agentcat.Argv.
type CustomAgent struct {
	// ID is the agent's key, `custom:<id>` in a spawn request and on its
	// sessions: lowercase letters, digits and dashes.
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
	// Models are offered in the model pickers; empty offers the agent's own
	// default only.
	Models []string `json:"models,omitempty"`
}
