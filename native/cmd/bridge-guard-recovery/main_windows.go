//go:build windows

package main

import (
	"bridge.local/client/netcore"
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

func main() {
	// Keep Chinese instructions readable in the Windows console, offline too.
	setOutputCP := windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleOutputCP")
	_, _, _ = setOutputCP.Call(65001)
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}

func run(args []string, input io.Reader, output io.Writer) int {
	interactive := len(args) == 0
	if !interactive && (len(args) != 1 || (args[0] != "--scan" && args[0] != "--restore")) {
		fmt.Fprintln(output, "Claude Bridge 离线网络恢复工具（Windows x64）\n双击：交互恢复；--scan：只读扫描；--restore：撤除本软件所有断线保护规则。\n请先退出 Claude Bridge，恢复操作须右键选择“以管理员身份运行”。")
		if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
			return 0
		}
		return 2
	}
	reader := bufio.NewReader(input)
	if interactive {
		fmt.Fprintln(output, "Claude Bridge 离线网络恢复工具\n请先从托盘退出 Claude Bridge。\n将撤除本机所有 Claude Bridge 断线保护规则，包括旧目录和其他用户留下的配置。\n不会重置 Windows 防火墙，也不会修改其他软件的规则。")
		if !windows.GetCurrentProcessToken().IsElevated() {
			fmt.Fprintln(output, "\n需要管理员权限。请关闭本窗口，右键本工具，选择“以管理员身份运行”。\n按回车关闭。")
			_, _ = reader.ReadString('\n')
			return 1
		}
		fmt.Fprintln(output, "\n输入 RESTORE 并按回车恢复网络；直接按回车取消：")
		answer, err := reader.ReadString('\n')
		if err != nil || strings.TrimSpace(answer) != "RESTORE" {
			fmt.Fprintln(output, "已取消，没有修改任何规则。")
			return 0
		}
	}
	restore := interactive || args[0] == "--restore"
	report, err := netcore.RecoverNetworkGuard(restore)
	envelope := struct {
		netcore.NetworkGuardRecoveryReport
		Error string `json:"error,omitempty"`
	}{NetworkGuardRecoveryReport: report}
	exitCode := 0
	if err != nil {
		envelope.Error = err.Error()
		exitCode = 1
	}
	_ = json.NewEncoder(output).Encode(envelope)
	if interactive {
		if err != nil {
			fmt.Fprintln(output, "\n恢复未完成。请保留上面的完整错误文字，以便继续处理。")
		} else {
			fmt.Fprintf(output, "\n已撤除 %d 条规则、%d 份保护配置；剩余保护配置：%d。\n", report.RemovedFilters, report.RemovedProfiles, report.RemainingProfiles)
			fmt.Fprintln(output, "请退出 Clash 或关闭 Clash 的 TUN/系统代理，然后重新打开浏览器测试直连。\n恢复工具只确认本软件的保护规则已清除，不检测其他原因造成的断网。\n在修复版本验证前，请保持断线保护关闭。")
		}
		fmt.Fprintln(output, "\n按回车关闭。")
		_, _ = reader.ReadString('\n')
	}
	return exitCode
}
