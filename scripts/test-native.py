"""Run native tests with the same Windows underlay policy used by builds."""
import os
import subprocess

from build_support import ROOT, go_environment


def main():
    go = ROOT / '.tools/go/bin/go.exe'
    if not go.is_file():
        raise SystemExit('Portable Go toolchain is missing: .tools/go/bin/go.exe')
    env = go_environment()
    subprocess.run([str(go), 'test', '-count=1', './...'],
                   cwd=ROOT / 'native', env=env, check=True)
    if os.name == 'nt':
        subprocess.run([str(go), 'test', '-count=1', '-run', '^TestClaudeBridgeUnderlay',
                        'tailscale.com/net/netmon'], cwd=ROOT / 'native', env=env, check=True)


if __name__ == '__main__':
    main()
