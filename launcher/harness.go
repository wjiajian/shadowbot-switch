package main

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

type runtimePointer struct {
	Harness string `json:"harness"`
	Release string `json:"release"`
}
type bundledHarness struct {
	ID string `json:"id"`
}

func bundledID(install installation) (string, error) {
	if install.Bundled == nil {
		return legacyBundledID(), nil
	}
	if !harnessName.MatchString(install.Bundled.ID) || install.Bundled.ID == "observe" {
		return "", errors.New("invalid bundled harness identifier")
	}
	return install.Bundled.ID, nil
}

type launchSpec struct {
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}
type harnessRelease struct {
	Release string     `json:"release"`
	Launch  launchSpec `json:"launch"`
	Legacy  bool       `json:"legacy"`
}

var harnessName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func safeRelative(path string) bool {
	if path == "" || strings.ContainsAny(path, ":\\") || filepath.IsAbs(path) {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func releaseDirectory(home string, pointer runtimePointer) (string, error) {
	if !harnessName.MatchString(pointer.Harness) || !releaseID.MatchString(pointer.Release) {
		return "", errors.New("invalid harness runtime pointer")
	}
	return filepath.Join(home, "harnesses", pointer.Harness, "releases", pointer.Release), nil
}

func controlRuntime(home string, install installation) (string, error) {
	if install.Runtime != nil {
		return releaseDirectory(home, *install.Runtime)
	}
	return legacyRuntime(home, install)
}
