import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("snapshot.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SnapshotTest(unittest.TestCase):
    def test_wal_snapshot_is_readable_and_rejects_runtime_without_losing_previous(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "chat.sqlite"
            destination = Path(root) / "export" / "pirx.sqlite"
            db = sqlite3.connect(source)
            try:
                db.execute("PRAGMA journal_mode=WAL")
                for name in ("sessions", "turns", "operations"):
                    db.execute(f"CREATE TABLE {name}(id TEXT)")
                db.execute("INSERT INTO sessions VALUES ('live-wal-row')")
                db.commit()
                module.snapshot(source, destination, module.SOURCES["pirx.sqlite"])
                copy = sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True)
                try:
                    self.assertEqual(copy.execute("SELECT id FROM sessions").fetchone()[0], "live-wal-row")
                finally:
                    copy.close()
                previous = destination.read_bytes()
                db.execute("CREATE TABLE runtime_tasks(id TEXT)")
                db.commit()
                with self.assertRaises(ValueError):
                    module.snapshot(source, destination, module.SOURCES["pirx.sqlite"])
                self.assertEqual(destination.read_bytes(), previous)
                self.assertEqual(list(destination.parent.glob(".snapshot-*")), [])
            finally:
                db.close()

if __name__ == "__main__":
    unittest.main()
