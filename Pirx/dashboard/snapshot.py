#!/usr/bin/env python3
"""Export consistent, read-only reporting snapshots; never mount runtime data into Grafana."""
import argparse
import os
from pathlib import Path
import sqlite3
import tempfile
import time

SOURCES = {"pirx.sqlite": {"sessions", "turns", "operations"}, "gpu.sqlite": {"gpu_samples"}}

def snapshot(source: Path, destination: Path, required: set[str]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=destination.parent)
    os.close(fd)
    try:
        source_db = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
        target_db = sqlite3.connect(temporary)
        try:
            deadline = time.monotonic() + 20
            def progress(status, remaining, total):
                if time.monotonic() > deadline:
                    raise TimeoutError("snapshot exceeded deadline")
            source_db.backup(target_db, pages=128, progress=progress, sleep=0.05)
            tables = {row[0] for row in target_db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required <= tables or any(name.startswith("runtime_") for name in tables):
                raise ValueError("source is not an approved reporting database")
            target_db.execute("PRAGMA journal_mode=DELETE")
        finally:
            target_db.close()
            source_db.close()
        os.chmod(temporary, 0o444)
        os.replace(temporary, destination)
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(temporary + suffix).unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--watch", action="store_true")
    args = parser.parse_args()
    while True:
        failed = False
        for name, required in SOURCES.items():
            try:
                snapshot(args.source / name, args.destination / name, required)
                print(f"snapshot_ready database={name} timestamp={int(time.time())}", flush=True)
            except (OSError, sqlite3.Error, ValueError, TimeoutError) as error:
                failed = True
                print(f"snapshot_failed database={name} code={type(error).__name__}; previous snapshot retained", flush=True)
        if not args.watch:
            return int(failed)
        time.sleep(30)

if __name__ == "__main__":
    raise SystemExit(main())
