package main

import (
	"errors"
	"path/filepath"
)

// Compatibility readers only. New manifests and the launch dispatch never infer
// a harness from its version or add SDK-specific environment to other adapters.
func legacyBundledID() string { return "original" }

func legacyRuntime(home string, install installation) (string, error) {
	if install.RuntimeRelease == "" {
		return home, nil
	}
	if !releaseID.MatchString(install.RuntimeRelease) {
		return "", errors.New("invalid installation release ID")
	}
	if install.PiVersion != "" {
		return releaseDirectory(home, runtimePointer{"pi", install.RuntimeRelease})
	}
	return filepath.Join(home, "releases", install.RuntimeRelease), nil
}

func legacyHarness(install installation, mode string) (harnessRelease, bool) {
	if install.Runtime != nil || mode != "pi" {
		return harnessRelease{}, false
	}
	return harnessRelease{Release: install.RuntimeRelease, Legacy: true,
		Launch: launchSpec{Executable: "node.exe", Args: []string{"{runtime}/service/main.js"}}}, true
}

func legacyEnvironment(env []string, home string) []string {
	return append(env, "SHADOWBOT_PI_HOME="+home, "PI_CODING_AGENT_DIR="+filepath.Join(home, "agent"))
}
