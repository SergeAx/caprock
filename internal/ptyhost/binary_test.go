package ptyhost

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBinaryPrefersTheHolderOnlyBinaryBesideSelf(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "caprock")
	writeExe(t, self)
	if got := Binary(self); got != self {
		t.Fatalf("with nothing beside it: %q, want self", got)
	}
	holder := filepath.Join(dir, BinaryName())
	writeExe(t, holder)
	if got := Binary(self); got != holder {
		t.Fatalf("with the holder beside it: %q, want %q", got, holder)
	}
}

func TestBinaryIgnoresWhatCannotRun(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "caprock")
	writeExe(t, self)
	holder := filepath.Join(dir, BinaryName())
	// Empty: a download or a copy that never finished.
	if err := os.WriteFile(holder, nil, 0o755); err != nil { //nolint:gosec // a test executable
		t.Fatal(err)
	}
	if got := Binary(self); got != self {
		t.Fatalf("an empty holder was chosen: %q", got)
	}
	if err := os.Remove(holder); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(holder, 0o755); err != nil { //nolint:gosec // a test directory
		t.Fatal(err)
	}
	if got := Binary(self); got != self {
		t.Fatalf("a directory was chosen: %q", got)
	}
	if runtime.GOOS == "windows" {
		return
	}
	if err := os.Remove(holder); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(holder, []byte("x"), 0o644); err != nil { //nolint:gosec // a test file
		t.Fatal(err)
	}
	if got := Binary(self); got != self {
		t.Fatalf("a file without the execute bit was chosen: %q", got)
	}
}

// Homebrew links bin/caprock to the Cellar; the holder is found beside the
// file the link points at when it is not beside the link.
func TestBinaryFollowsALinkToSelf(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links need privileges on Windows")
	}
	cellar, bin := t.TempDir(), t.TempDir()
	real := filepath.Join(cellar, "caprock")
	writeExe(t, real)
	holder := filepath.Join(cellar, BinaryName())
	writeExe(t, holder)
	link := filepath.Join(bin, "caprock")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	got := Binary(link)
	if want, _ := filepath.EvalSymlinks(holder); got != holder && got != want {
		t.Fatalf("through a link: %q, want %q", got, holder)
	}
}

func writeExe(t *testing.T, p string) {
	t.Helper()
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil { //nolint:gosec // a test executable
		t.Fatal(err)
	}
}
