"""Build an offline Windows recovery EXE; never runs or changes WFP policy."""
import hashlib
import subprocess
import zipfile

from build_support import ROOT, atomic_write, go_environment


def main():
    go = ROOT / '.tools/go/bin/go.exe'
    if not go.is_file():
        raise SystemExit('Portable Go toolchain is missing: .tools/go/bin/go.exe')
    target = ROOT / 'release/ClaudeBridge-Network-Recovery-windows-x64.exe'
    target.parent.mkdir(exist_ok=True)
    subprocess.run([str(go), 'build', '-trimpath', '-ldflags=-s -w', '-o', str(target),
                    './cmd/bridge-guard-recovery'], cwd=ROOT / 'native', env=go_environment(), check=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    checksum = target.with_suffix('.sha256.txt')
    atomic_write(checksum, f'{digest}  {target.name}\n'.encode('ascii'))
    guide = target.parent / 'NETWORK-RECOVERY-README.txt'
    atomic_write(guide, '''Claude Bridge 离线网络恢复（Windows 10/11 x64）

用途：清除 Claude Bridge 写入的持久断线保护规则。无需联网、Node、Clash、PowerShell或原软件目录。

1. 将本压缩包拷到断网电脑，先完整解压。
2. 从托盘退出 Claude Bridge，避免操作期间再次启用保护。
3. 右键 ClaudeBridge-Network-Recovery-windows-x64.exe，选择“以管理员身份运行”，同意 Windows 授权。
4. 在窗口输入 RESTORE，再按回车。
5. 确认显示“剩余保护配置：0”。原来只有一份完整配置时通常撤除46条；多份或部分配置的数量会不同。
6. 退出 Clash 或关闭其 TUN/系统代理，重新打开浏览器测试直连。

恢复完成前不要删除原软件数据。主程序不再提供系统保护的启用功能。
本工具按显示名、确定性GUID和规则标记识别本软件的保护，不重置Windows防火墙，不修改其他软件规则。
如果出现错误，窗口会保留完整诊断。请记录错误文字再关闭，不要执行全局防火墙重置。
工具只确认本软件WFP规则的清除结果，不能保证其他网络配置也正常。

供技术排查：--scan 只读扫描并输出JSON；--restore 管理员下撤除所有本软件保护并输出JSON。
'''.replace('\n', '\r\n').encode('utf-8-sig'))
    archive = target.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
        for file in (target, checksum, guide):
            output.write(file, file.name)
    print(f'{archive}\n{target} ({target.stat().st_size} bytes)\nSHA256: {digest}')


if __name__ == '__main__':
    main()
