#!/usr/bin/env python3
"""Refresh Media Ingest's YouTube-only cookie jar from the host's Ubuntu (snap) Firefox profile.

YouTube rotates its session cookies only inside a live browser, so a static export goes stale. With
--visit, the real desktop Firefox opens YouTube first (and closes again if this script started it),
letting the session rotate before export. The exported jar is checked against a login-only YouTube
feed before it replaces the deployed jar; a logged-out export never overwrites the previous jar.

The jar lands at /data/cookies/youtube.txt in the deployment's media volume; point
YT_DLP_COOKIES_PATH (or the YouTube entry of YT_DLP_AUTH_JSON) at it. Compose runs in this checkout.
"""
import argparse
import configparser
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import time

os.umask(0o077)
repo_root = Path(__file__).resolve().parent.parent
profile_root = Path.home() / "snap/firefox/common/.mozilla/firefox"
UNIT = "media-ingest-youtube-cookies"
YOUTUBE_URL = "https://www.youtube.com/"
LOGGED_OUT_EXIT = 3
# Runs inside a one-off api container: stage the jar, optionally prove it is logged in, then swap it in.
INSTALL_JAR = r"""umask 077; mkdir -p /data/cookies
tmp=$(mktemp /data/cookies/.youtube.XXXXXX); trap 'rm -f "$tmp" /tmp/jar-check' EXIT
cat > "$tmp"
if [ "$VERIFY" = 1 ]; then
  cp "$tmp" /tmp/jar-check
  yt-dlp --cookies /tmp/jar-check --flat-playlist -I 1 --simulate --quiet --no-warnings -O id :ytsubs >/dev/null || exit 3
fi
mv -f "$tmp" /data/cookies/youtube.txt"""


def default_profile() -> str:
    ini = configparser.ConfigParser(interpolation=None)
    if not ini.read(profile_root / "profiles.ini"):
        raise SystemExit("Firefox profiles.ini not found; supply the profile directory name.")
    for section in ini.sections():
        entry = ini[section]
        if section.startswith("Profile") and entry.get("Default") == "1" and entry.get("IsRelative", "1") == "1":
            return entry.get("Path", "")
    raise SystemExit("No default Firefox profile found; supply the profile directory name.")


def resolve_profile(name: str | None) -> Path:
    profile = name or default_profile()
    if not profile or Path(profile).name != profile:
        raise SystemExit("Supply the existing Firefox profile directory name.")
    path = (profile_root / profile).resolve(strict=True)
    if not path.is_relative_to(profile_root.resolve()):
        raise SystemExit("Firefox profile is outside the expected profile root.")
    return path


def firefox_binary() -> str:
    return shutil.which("firefox") or "/snap/bin/firefox"


def firefox_running() -> bool:
    return subprocess.run(["pgrep", "-u", str(os.getuid()), "-x", "firefox"], capture_output=True).returncode == 0


def desktop_available() -> bool:
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
    wayland = os.environ.get("WAYLAND_DISPLAY")
    display = os.environ.get("DISPLAY", "")
    return bool(wayland and (runtime / wayland).exists()) or bool(
        display.startswith(":") and Path(f"/tmp/.X11-unix/X{display[1:].split('.')[0]}").exists()
    )


def visit_youtube(profile: Path, seconds: int) -> None:
    """Load YouTube in Firefox so the session rotates, then close the browser if this script opened it."""
    if firefox_running():
        # The profile is locked by the running browser; hand it the URL and leave the user's session alone.
        subprocess.run([firefox_binary(), "--new-tab", YOUTUBE_URL], check=True, timeout=60,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(seconds)
        print("Opened YouTube in the running Firefox.")
        return
    args = [firefox_binary(), "--profile", str(profile), YOUTUBE_URL]
    if not desktop_available():
        args.insert(1, "--headless")
    browser = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        browser.wait(timeout=seconds)
        raise SystemExit(f"Firefox exited early with status {browser.returncode}.")
    except subprocess.TimeoutExpired:
        pass
    browser.send_signal(signal.SIGTERM)  # Firefox treats SIGTERM as a normal quit and flushes cookies.
    try:
        browser.wait(timeout=60)
    except subprocess.TimeoutExpired:
        os.killpg(browser.pid, signal.SIGKILL)
        browser.wait()
        raise SystemExit("Firefox did not quit cleanly; cookies may be unflushed.")
    print("Visited YouTube in Firefox" + (" (headless: no desktop session)." if "--headless" in args else "."))


def export_cookies(profile: Path) -> list[str]:
    database = (profile / "cookies.sqlite").resolve(strict=True)
    if not database.is_relative_to(profile_root.resolve()):
        raise SystemExit("Firefox cookie database is outside the expected profile root.")
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)
    connection.execute("PRAGMA query_only = ON")
    lines = ["# Netscape HTTP Cookie File", "# Restricted to youtube.com and subdomains"]
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        for host, name, value, path, expiry, secure, http_only in connection.execute(
            "SELECT host,name,value,path,expiry,isSecure,isHttpOnly FROM moz_cookies "
            # First-party jar only: partitioned (embedded), container and private-browsing copies carry
            # originAttributes and would shadow the real session cookies in a flat Netscape jar.
            "WHERE (host = 'youtube.com' OR host LIKE '%.youtube.com') AND originAttributes = ''"
        ):
            expires = int((expiry or 0) / (1000 if version >= 16 else 1))
            if expires and expires <= time.time():
                continue
            row = (
                ("#HttpOnly_" if http_only else "") + host,
                "TRUE" if host.startswith(".") else "FALSE",
                path or "/",
                "TRUE" if secure else "FALSE",
                str(expires), name, value,
            )
            if not name or any(any(c in field for c in "\t\r\n") for field in row):
                raise SystemExit("Unsupported cookie record; previous jar preserved.")
            lines.append("\t".join(row))
    finally:
        connection.close()
    if len(lines) == 2:
        raise SystemExit("No unexpired YouTube cookies found; previous jar preserved.")
    return lines


def install_jar(lines: list[str], verify: bool) -> None:
    result = subprocess.run(
        ["docker", "compose", "run", "--rm", "--no-deps", "-T", "-e", f"VERIFY={int(verify)}",
         "--entrypoint", "sh", "api", "-ec", INSTALL_JAR],
        input=("\n".join(lines) + "\n").encode(), cwd=repo_root, stdout=subprocess.DEVNULL,
    )
    if result.returncode == LOGGED_OUT_EXIT:
        raise SystemExit(
            "YouTube rejected the exported session (logged out or revoked); previous jar preserved. "
            "Log in to YouTube in the desktop Firefox, then rerun."
        )
    if result.returncode:
        raise SystemExit(f"Installing the cookie jar failed with status {result.returncode}.")


def install_timer(profile_arg: str | None, schedule: str, seconds: int) -> None:
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    command = [str(Path(__file__).resolve()), "--visit", "--visit-seconds", str(seconds)]
    if profile_arg:
        command.append(profile_arg)
    (units / f"{UNIT}.service").write_text(
        "[Unit]\nDescription=Refresh Media Ingest YouTube cookies through the desktop Firefox\n\n"
        "[Service]\nType=oneshot\nEnvironment=PATH=/snap/bin:/usr/local/bin:/usr/bin:/bin\n"
        f"ExecStart=/usr/bin/python3 -I {' '.join(command)}\nTimeoutStartSec=15min\n"
    )
    (units / f"{UNIT}.timer").write_text(
        "[Unit]\nDescription=Weekly Media Ingest YouTube cookie refresh\n\n"
        f"[Timer]\nOnCalendar={schedule}\nRandomizedDelaySec=30min\nPersistent=true\n\n"
        "[Install]\nWantedBy=timers.target\n"
    )
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", f"{UNIT}.timer"], check=True)
    print(f"Installed {UNIT}.timer ({schedule}). Run it now with: systemctl --user start {UNIT}.service")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("profile", nargs="?", help="Firefox profile directory name (default: the Default=1 profile)")
    parser.add_argument("--visit", action="store_true", help="open YouTube in the desktop Firefox before exporting")
    parser.add_argument("--visit-seconds", type=int, default=90, help="how long to keep YouTube open (default 90)")
    parser.add_argument("--no-verify", action="store_true", help="install the jar without checking that it is logged in")
    parser.add_argument("--install-timer", action="store_true", help="install and enable a systemd user timer running --visit")
    parser.add_argument("--schedule", default="Sun *-*-* 05:00:00", help="timer OnCalendar value (default weekly, Sunday 05:00)")
    args = parser.parse_args()
    if args.install_timer:
        resolve_profile(args.profile)
        install_timer(args.profile, args.schedule, args.visit_seconds)
        return
    profile = resolve_profile(args.profile)
    if args.visit:
        visit_youtube(profile, args.visit_seconds)
    install_jar(export_cookies(profile), verify=not args.no_verify)
    print("YouTube-only cookie jar refreshed" + ("." if args.no_verify else " and verified as logged in."))


if __name__ == "__main__":
    main()
