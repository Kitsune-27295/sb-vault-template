"""Install or update the `sb` tool on this machine and wire this vault to it.

    python setup-sb.py                  # install or update `sb`, then set this vault up
    python setup-sb.py --check          # show what is installed and what is newest; change nothing
    python setup-sb.py --tool-only      # install or update `sb` only; leave this vault alone (CI)
    python setup-sb.py --add-to-path    # also put `sb` on your PATH (Windows: the user PATH)

No GitHub account or key is needed. The tool is downloaded over HTTPS from a public repository and
its sha256 is checked before anything is installed. `sb` lives in one folder per machine, shared by
all your vaults; nothing is installed inside the vault. Managed by `sb upgrade`: do not edit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import venv
from pathlib import Path

SOURCE = os.environ.get(
    "SB_SETUP_SOURCE", "https://raw.githubusercontent.com/Kitsune-27295/sb-vault-template/dist"
)
VAULT = Path(__file__).resolve().parent
WINDOWS = sys.platform == "win32"


def tool_home() -> Path:
    if os.environ.get("SB_HOME"):
        return Path(os.environ["SB_HOME"])
    if WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "sb"
    return Path.home() / ".local" / "share" / "sb"


def venv_python(home: Path) -> Path:
    return (
        home / "venv" / ("Scripts" if WINDOWS else "bin") / ("python.exe" if WINDOWS else "python")
    )


def installed(home: Path) -> dict[str, str] | None:
    try:
        data = json.loads((home / "installed.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and venv_python(home).exists() else None


def fetch(name: str) -> bytes:
    with urllib.request.urlopen(f"{SOURCE}/{name}", timeout=60) as response:
        return bytes(response.read())


def latest() -> dict[str, str]:
    data = json.loads(fetch("LATEST.json"))
    keys = ("version", "wheel", "sha256", "constraints", "constraints_sha256")
    if not all(isinstance(data.get(k), str) for k in keys):
        raise ValueError("LATEST.json is not in the expected shape")
    return {k: data[k] for k in keys}


def download(name: str, expected: str, folder: Path) -> Path:
    blob = fetch(name)
    if hashlib.sha256(blob).hexdigest() != expected:
        raise ValueError(f"{name} does not match its sha256; nothing was installed")
    path = folder / name
    path.write_bytes(blob)
    return path


def run(*args: str | Path) -> None:
    print("$", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], check=True)


def install(info: dict[str, str], home: Path) -> None:
    python = venv_python(home)
    if not python.exists():
        print(f"creating {home / 'venv'}", flush=True)
        venv.create(home / "venv", with_pip=True)
    with tempfile.TemporaryDirectory() as tmp:
        wheel = download(info["wheel"], info["sha256"], Path(tmp))
        pins = download(info["constraints"], info["constraints_sha256"], Path(tmp))
        before = installed(home)
        # The dependency versions the tests ran on, and binary wheels only: a package that ships
        # no wheel fails here instead of running its build script on your machine.
        run(
            *(python, "-m", "pip", "install", "--quiet", "--upgrade"),
            *("--only-binary", ":all:", "-c", pins, f"{wheel}[capture]"),
        )
        if before is None or before.get("sha256") != info["sha256"]:
            # Same version number, different build: pip would call it "already satisfied".
            run(python, "-m", "pip", "install", "--quiet", "--force-reinstall", "--no-deps", wheel)
    (home / "installed.json").write_text(json.dumps(info) + "\n", encoding="utf-8", newline="\n")


def wire_vault(home: Path) -> None:
    python = venv_python(home)
    run(python, "-m", "sb", "hook", "install", "--vault", VAULT)
    if (VAULT / ".git").exists():
        run("git", "-C", VAULT, "config", "core.hooksPath", ".githooks")
    run(python, "-m", "sb", "doctor", "--vault", VAULT)


def add_to_path(home: Path) -> None:
    scripts = venv_python(home).parent
    if sys.platform != "win32":
        print(f'add to your shell profile:  export PATH="{scripts}:$PATH"')
        return
    import winreg  # Windows only

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_ALL_ACCESS) as key:
        try:
            current, kind = winreg.QueryValueEx(key, "Path")
        except FileNotFoundError:
            current, kind = "", winreg.REG_EXPAND_SZ
        parts = [p for p in str(current).split(";") if p]
        if str(scripts) not in parts:
            winreg.SetValueEx(key, "Path", 0, kind, ";".join([str(scripts), *parts]))
    print(f"`sb` is on the user PATH ({scripts}); open a new terminal")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="change nothing, just report")
    parser.add_argument("--tool-only", action="store_true", help="do not wire this vault")
    parser.add_argument("--add-to-path", action="store_true", help="put `sb` on your PATH")
    args = parser.parse_args()
    if sys.version_info < (3, 12):  # noqa: UP036 - this file may be run by an older Python
        print(f"sb needs Python 3.12 or newer; this is {sys.version.split()[0]}", file=sys.stderr)
        return 1
    home = tool_home()
    try:
        newest = latest()
    except (OSError, ValueError) as exc:  # URLError is an OSError
        print(f"could not read the newest version from {SOURCE}: {exc}", file=sys.stderr)
        print("Check your connection and try again. Nothing was changed.", file=sys.stderr)
        return 1
    have = installed(home)
    print(f"installed: {have['version'] if have else 'none'}   newest: {newest['version']}")
    if args.check:
        return 0
    if have is None or have.get("sha256") != newest["sha256"]:
        try:
            install(newest, home)
        except (ValueError, subprocess.CalledProcessError, OSError) as exc:
            print(f"install failed: {exc}", file=sys.stderr)
            return 1
    else:
        print("the tool is already the newest")
    if args.tool_only:
        return 0
    wire_vault(home)
    if args.add_to_path:
        add_to_path(home)
    print("done. Next: open Claude Code in this folder and say: faz o onboarding")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
