"""Real same-account high-to-normal Windows restart acceptance (one UAC prompt).

Run from a normal PowerShell 7 session. Only the compiled, isolated Go test phase
is elevated. No real profile, login, pairing or Tailscale network is opened.
Receipts and the synthetic fixture remain under .cache/validation for inspection.
"""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from build_support import ROOT, go_environment


def main():
    if sys.platform != 'win32':
        raise SystemExit('This acceptance test requires Windows and PowerShell 7.')
    pwsh = shutil.which('pwsh')
    go = ROOT / '.tools/go/bin/go.exe'
    if not pwsh or not go.is_file():
        raise SystemExit('PowerShell 7 and the repository Go toolchain are required.')
    version = subprocess.run([pwsh, '-NoProfile', '-NonInteractive', '-Command',
                              '$PSVersionTable.PSVersion.Major'], check=True,
                             capture_output=True, text=True).stdout.strip()
    if version != '7':
        raise SystemExit('The test runner requires PowerShell 7.')
    validation = ROOT / '.cache/validation'
    validation.mkdir(parents=True, exist_ok=True)
    fixture = Path(tempfile.mkdtemp(prefix='state-restart-', dir=validation))
    binary = fixture.parent / (fixture.name + '.test.exe')
    env = go_environment()
    subprocess.run([str(go), 'test', '-p=4', '-c', '-o', str(binary), './netcore'],
                   cwd=ROOT / 'native', env=env, check=True)

    def arguments(phase):
        tests = ('^(TestStateDirCrossPrivilegeRestart|TestPrepareStateDirAllowsEnabledAdministratorOwner)$'
                 if phase == 'elevated' else '^TestStateDirCrossPrivilegeRestart$')
        return ['-test.run=' + tests, '-test.v',
                '-test.count=1', '-test.timeout=60s',
                '-bridge-state-restart-phase=' + phase,
                '-bridge-state-restart-fixture=' + str(fixture)]

    def receipt(phase):
        path = fixture / (phase + '.json')
        if not path.is_file():
            raise RuntimeError(f'{phase}: no result receipt; test did not complete: {fixture}')
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('phase') != phase or data.get('passed') is not True:
            raise RuntimeError(f'{phase} failed: {json.dumps(data)}')
        return data

    # This proves the parent really has the ordinary token before requesting UAC.
    subprocess.run([str(binary), *arguments('baseline')], check=True)
    baseline = receipt('baseline')
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    print(f'Isolated test binary: {binary}\nSHA256: {digest}\nFixture: {fixture}', flush=True)
    print('The UAC prompt elevates only the isolated initialization test phase.', flush=True)
    quote = lambda value: "'" + value.replace("'", "''") + "'"
    command_line = subprocess.list2cmdline(arguments('elevated'))
    script = ("$ErrorActionPreference='Stop'; "
              f"$child = Start-Process -FilePath {quote(str(binary))} "
              f"-ArgumentList {quote(command_line)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; "
              "exit $child.ExitCode")
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    elevated = subprocess.run([pwsh, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
    high = receipt('elevated')
    elevated.check_returncode()
    subprocess.run([str(binary), *arguments('restart')], check=True)
    normal = receipt('restart')
    if (baseline['elevated'] or normal['elevated'] or not high['elevated']
            or len({baseline['userSid'], high['userSid'], normal['userSid']}) != 1
            or high['savedSha256'] != normal['savedSha256']
            or normal.get('unnormalizedControlRejected') is not True):
        raise RuntimeError('Cross-process token or saved-identity receipts disagree.')
    print(json.dumps({'passed': True, 'fixture': str(fixture),
                      'baseline': baseline, 'elevated': high, 'restart': normal}, indent=2))


if __name__ == '__main__':
    main()
