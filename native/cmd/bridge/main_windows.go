package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"bridge.local/client/netcore"
	"golang.org/x/sys/windows"
)

//go:embed runtime.zip
var payload []byte

var version = "dev"

func extract(directory string) (string, error) {
	return extractPayload(directory, payload)
}

func extractPayload(directory string, bundled []byte) (string, error) {
	sum := sha256.Sum256(bundled)
	runtimePath := filepath.Join("runtime", hex.EncodeToString(sum[:8]))
	root := filepath.Join(directory, runtimePath)
	archive, err := zip.NewReader(bytes.NewReader(bundled), int64(len(bundled)))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	// Anchor before entering runtime: opening the final path directly would
	// follow a pre-existing runtime/hash junction outside the data directory.
	dataRoot, err := os.OpenRoot(directory)
	if err != nil {
		return "", err
	}
	defer dataRoot.Close()
	if err := dataRoot.MkdirAll(runtimePath, 0700); err != nil {
		return "", err
	}
	files, err := dataRoot.OpenRoot(runtimePath)
	if err != nil {
		return "", err
	}
	defer files.Close()
	var total uint64
	for _, file := range archive.File {
		name := filepath.FromSlash(file.Name)
		total += file.UncompressedSize64
		if !filepath.IsLocal(name) || file.UncompressedSize64 > 512*1024*1024 || total > 1024*1024*1024 || (!file.FileInfo().IsDir() && !file.Mode().IsRegular()) {
			return "", fmt.Errorf("invalid bundled file")
		}
		if file.FileInfo().IsDir() {
			if err := files.MkdirAll(name, 0700); err != nil {
				return "", err
			}
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return "", err
		}
		data, err := io.ReadAll(io.LimitReader(reader, 512*1024*1024+1))
		reader.Close()
		if err != nil || len(data) > 512*1024*1024 {
			if err == nil {
				err = fmt.Errorf("invalid bundled file size")
			}
			return "", err
		}
		if bundledFileMatches(files, name, data) {
			continue
		}
		if err := files.MkdirAll(filepath.Dir(name), 0700); err != nil {
			return "", err
		}
		if err := writeBundledFile(files, name, data); err != nil {
			return "", err
		}
	}
	return root, nil
}

// Rooted operations prevent an existing junction from redirecting extraction
// outside the runtime. Atomic replacement also keeps concurrent starts from
// observing a partially written executable or JavaScript module.
func writeBundledFile(root *os.Root, name string, data []byte) error {
	temporary := filepath.Join(filepath.Dir(name), ".bridge-"+rand.Text()+".tmp")
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := root.Rename(temporary, name); err != nil && !bundledFileMatches(root, name, data) {
		return err
	}
	return nil
}

func bundledFileMatches(root *os.Root, name string, data []byte) bool {
	file, err := root.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	existing, err := io.ReadAll(io.LimitReader(file, int64(len(data))+1))
	return err == nil && bytes.Equal(existing, data)
}

func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func openBrowser(url string) {
	cmd := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	hide(cmd)
	cmd.Start()
}

func clientRunning(url string) bool {
	client := &http.Client{Timeout: time.Second}
	res, err := client.Get(url + "/health")
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var health struct {
		Service string `json:"service"`
		Version string `json:"version"`
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&health) == nil && health.Service == "claude-p2p-bridge" && health.Version == version
}
func showError(message string) {
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("Claude Bridge")
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}

func main() {
	exitCode := 1
	// Register this first so process handles and cleanup finish before a
	// nonzero exit is returned to the native owner.
	defer func() {
		if exitCode != 0 {
			os.Exit(exitCode)
		}
	}()
	if len(os.Args) > 1 && os.Args[1] == "--network-mode" {
		netcore.ConfigureBootstrapNetwork()
		if err := netcore.Run(os.Stdin, os.Stdout); err != nil {
			os.Exit(1)
		}
		exitCode = 0
		return
	}
	flags := flag.NewFlagSet("Claude Bridge", flag.ContinueOnError)
	port := flags.Int("port", 3210, "local model API port (management uses the adjacent port)")
	directory := flags.String("data-dir", "", "private application data directory")
	noBrowser := flags.Bool("no-browser", false, "do not open browser")
	owned := flags.Bool("owned-engine", false, "start an engine owned by the native desktop")
	demo := flags.Bool("demo", false, "simulate Claude without a model call")
	system := flags.Bool("system-tailscale", false, "use separately installed Tailscale")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return
	}
	if *showVersion {
		fmt.Println("Claude Bridge " + version + " / embedded Tailscale engine")
		exitCode = 0
		return
	}
	if *port < 1 || *port > 65535 {
		showError("本机 API 端口必须为 1–65535")
		return
	}
	managementPort := *port + 1
	if *port == 65535 {
		managementPort = 65534
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", managementPort)
	if !*owned && clientRunning(url) {
		if !*noBrowser {
			openBrowser(url)
		}
		exitCode = 0
		return
	}
	if *directory == "" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base, _ = os.UserConfigDir()
		}
		*directory = filepath.Join(base, "ClaudeBridge")
	}
	dataDir, err := filepath.Abs(*directory)
	if err != nil {
		showError(err.Error())
		return
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		showError(err.Error())
		return
	}
	if err := removeLegacyClientLog(dataDir); err != nil {
		showError("清理旧运行记录失败：" + err.Error())
		return
	}
	defer removeLegacyClientLog(dataDir)
	runtimeDir, err := extract(dataDir)
	if err != nil {
		showError("解包运行组件失败：" + err.Error())
		return
	}
	self, _ := os.Executable()
	args := []string{filepath.Join(runtimeDir, "src", "main.js"), "--port", fmt.Sprint(*port), "--data-dir", dataDir}
	if *demo {
		args = append(args, "--demo")
	}
	if *system {
		args = append(args, "--system-tailscale")
	}
	cmd := exec.Command(filepath.Join(runtimeDir, "runtime", "node.exe"), args...)
	cmd.Dir = runtimeDir
	cmd.Env = append(os.Environ(), "BRIDGE_NET_HELPER="+self, "BRIDGE_NET_HELPER_ARGS=[\"--network-mode\"]")
	// Leave console output unset so os/exec connects it to the null device.
	// Avoid both a persistent client.log and copy pipes inherited by helpers.
	hide(cmd)
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		showError(err.Error())
		return
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		showError(err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		showError("启动失败：" + err.Error())
		return
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		cmd.Process.Kill()
		showError(err.Error())
		return
	}
	err = windows.AssignProcessToJobObject(job, process)
	windows.CloseHandle(process)
	if err != nil {
		cmd.Process.Kill()
		showError(err.Error())
		return
	}
	processDone := make(chan error, 1)
	go func() { processDone <- cmd.Wait() }()
	stopReadiness := make(chan struct{})
	defer close(stopReadiness)
	ready := make(chan bool, 1)
	go func() {
		for i := 0; i < 100; i++ {
			if clientRunning(url) {
				ready <- true
				return
			}
			select {
			case <-stopReadiness:
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
		ready <- false
	}()
	var waitError error
	select {
	case waitError = <-processDone:
		// A fast API shutdown must not wait for the readiness probe's timeout.
	case running := <-ready:
		if running && *owned {
			cleanupGeneratedCaches(dataDir, runtimeDir)
		}
		if running && !*noBrowser {
			openBrowser(url)
		}
		waitError = <-processDone
	}
	if waitError != nil {
		if !*noBrowser {
			showError("客户端未能启动或意外退出，请检查本机端口是否占用，然后重新启动客户端。")
		}
		return
	}
	exitCode = 0
}
