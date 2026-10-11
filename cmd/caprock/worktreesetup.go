package main

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/wtsetup"
)

// worktreeSetupCmd runs a fresh worktree's setup command in the session's
// terminal and then becomes the agent (ADR-050). The daemon starts it as the
// session's process; a person never does, so it is hidden from help. Flag
// parsing is off: everything after `--` is the agent's own command line.
func worktreeSetupCmd() *cobra.Command {
	return &cobra.Command{
		Use:                wtsetup.Subcommand + " -- <agent> [args...]",
		Short:              "Run a fresh worktree's setup command, then start the agent (started by the daemon)",
		Hidden:             true,
		DisableFlagParsing: true,
		Run: func(_ *cobra.Command, args []string) {
			os.Exit(wtsetup.Main(args, os.Stdout))
		},
	}
}
