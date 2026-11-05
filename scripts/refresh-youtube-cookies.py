#!/usr/bin/env python3
"""Refresh Media Ingest's YouTube-only cookie jar from the host's Ubuntu (snap) Firefox profile.

Usage: scripts/refresh-youtube-cookies.py [PROFILE_DIR_NAME]

Without an argument, the profile marked Default=1 in profiles.ini is used. The jar is written atomically
to /data/cookies/youtube.txt in the deployment's media volume; point YT_DLP_COOKIES_PATH (or the YouTube
entry of YT_DLP_AUTH_JSON) at that path. Run it from any directory: Compose runs in this checkout.
"""
import configparser
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

os.umask(0o077)
repo_root = Path(__file__).resolve().parent.parent
profile_root = Path.home() / "snap/firefox/common/.mozilla/firefox"


def default_profile() -> str:
    ini = configparser.ConfigParser(interpolation=None)
    if not ini.read(profile_root / "profiles.ini"):
        raise SystemExit("Firefox profiles.ini not found; supply the profile directory name.")
    for section in ini.sections():
        entry = ini[section]
        if section.startswith("Profile") and entry.get("Default") == "1" and entry.get("IsRelative", "1") == "1":
            return entry.get("Path", "")
    raise SystemExit("No default Firefox profile found; supply the profile directory name.")


if len(sys.argv) > 2:
    raise SystemExit(__doc__)
profile = sys.argv[1] if len(sys.argv) == 2 else default_profile()
if not profile or Path(profile).name != profile:
    raise SystemExit("Supply the existing Firefox profile directory name.")
database = (profile_root / profile / "cookies.sqlite").resolve(strict=True)
if not database.is_relative_to(profile_root.resolve()):
    raise SystemExit("Firefox cookie database is outside the expected profile root.")
connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)
connection.execute("PRAGMA query_only = ON")
lines = ["# Netscape HTTP Cookie File", "# Restricted to youtube.com and subdomains"]
try:
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    for host, name, value, path, expiry, secure, http_only in connection.execute(
        "SELECT host,name,value,path,expiry,isSecure,isHttpOnly FROM moz_cookies "
        "WHERE host = 'youtube.com' OR host LIKE '%.youtube.com'"
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
subprocess.run(
    ["docker", "compose", "run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "api", "-ec",
     'umask 077; mkdir -p /data/cookies; tmp=$(mktemp /data/cookies/.youtube.XXXXXX); cat > "$tmp"; mv -f "$tmp" /data/cookies/youtube.txt'],
    input=("\n".join(lines) + "\n").encode(), check=True,
    cwd=repo_root,
)
print("YouTube-only cookie jar refreshed.")
