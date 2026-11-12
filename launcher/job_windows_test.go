package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestJobHelper(t *testing.T) {
	switch os.Getenv("SHADOWBOT_PI_JOB_TEST_ROLE") {
	case "parent":
		child := exec.Command(os.Args[0], "-test.run=^TestJobHelper$")
		child.Env = append(os.Environ(), "SHADOWBOT_PI_JOB_TEST_ROLE=child")
		child.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("SHADOWBOT_PI_JOB_TEST_PATH"), []byte(fmt.Sprint(child.Process.Pid)), 0600); err != nil {
			t.Fatal(err)
		}
		_ = child.Wait()
	case "child":
		time.Sleep(time.Minute)
	}
}

func TestJobClosesBackendAndDescendants(t *testing.T) {
	path := filepath.Join(t.TempDir(), "descendant.pid")
	cmd := exec.Command(os.Args[0], "-test.run=^TestJobHelper$")
	cmd.Env = append(os.Environ(), "SHADOWBOT_PI_JOB_TEST_ROLE=parent", "SHADOWBOT_PI_JOB_TEST_PATH="+path)
	job, err := startInJob(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer cmd.Wait()
	defer func() {
		if job != 0 {
			_ = windows.CloseHandle(job)
		}
	}()
	var descendant uint32
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		data, err := os.ReadFile(path)
		if err == nil {
			if _, err = fmt.Sscan(string(data), &descendant); err == nil {
				break
			}
		}
	}
	if descendant == 0 {
		t.Fatal("backend did not start its test descendant")
	}
	for _, pid := range []uint32{uint32(cmd.Process.Pid), descendant} {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
		if err != nil {
			t.Fatal(err)
		}
		defer windows.CloseHandle(handle)
		defer func() {
			if job == 0 {
				status, err := windows.WaitForSingleObject(handle, 5000)
				if err != nil || status != windows.WAIT_OBJECT_0 {
					t.Errorf("process %d survived Job Object close: %d %v", pid, status, err)
				}
			}
		}()
	}
	if err := windows.CloseHandle(job); err != nil {
		t.Fatal(err)
	}
	job = 0
}
