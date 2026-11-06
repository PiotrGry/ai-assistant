from pathlib import Path
import os
import subprocess
import tempfile
import unittest


class DashboardStartupTest(unittest.TestCase):
    def test_custom_database_paths_are_canonicalized_for_the_read_only_exporter(self):
        dashboard = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as root_value:
            root = Path(root_value)
            home = root / "home"
            chat = root / "custom" / "chat-data.sqlite"
            gpu = root / "metrics" / "gpu-data.sqlite"
            export = root / "exports"
            grafana = root / "grafana"
            key = root / "age.txt"
            tools = root / "bin"
            for path in (home, chat.parent, gpu.parent, tools):
                path.mkdir(parents=True, exist_ok=True)
            chat.touch()
            key.touch()
            capture = root / "environment.txt"
            sops = tools / "sops"
            sops.write_text("#!/bin/sh\nenv | sort > \"$PIRX_TEST_CAPTURE\"\n", encoding="utf8")
            sops.chmod(0o755)
            environment = {
                **os.environ,
                "HOME": str(home),
                "PATH": f"{tools}:{os.environ['PATH']}",
                "SOPS_AGE_KEY_FILE": str(key),
                "PIRX_STORAGE_FILE": str(chat.parent / ".." / chat.parent.name / chat.name),
                "PIRX_GPU_DB": str(gpu),
                "PIRX_DASHBOARD_EXPORT_DIR": str(export),
                "PIRX_GRAFANA_DATA_DIR": str(grafana),
                "PIRX_TEST_CAPTURE": str(capture),
            }
            subprocess.run([str(dashboard / "up.sh")], cwd=dashboard, env=environment, check=True, timeout=10)
            values = dict(line.split("=", 1) for line in capture.read_text(encoding="utf8").splitlines() if "=" in line)
            self.assertEqual(values["PIRX_DASHBOARD_CHAT_DIR"], str(chat.parent.resolve()))
            self.assertEqual(values["PIRX_DASHBOARD_CHAT_NAME"], chat.name)
            self.assertEqual(values["PIRX_DASHBOARD_GPU_DIR"], str(gpu.parent.resolve()))
            self.assertEqual(values["PIRX_DASHBOARD_GPU_NAME"], gpu.name)
            self.assertEqual(values["PIRX_DASHBOARD_EXPORT_DIR"], str(export.resolve()))
            self.assertEqual(values["PIRX_GRAFANA_DATA_DIR"], str(grafana.resolve()))
            self.assertTrue(values["PIRX_DASHBOARD_UID"].isdigit())
            self.assertTrue(values["PIRX_DASHBOARD_GID"].isdigit())
            self.assertEqual(export.stat().st_mode & 0o077, 0)
            self.assertEqual(grafana.stat().st_mode & 0o077, 0)


if __name__ == "__main__":
    unittest.main()
