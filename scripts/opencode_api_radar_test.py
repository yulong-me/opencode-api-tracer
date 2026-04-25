import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from opencode_api_radar import JsonlTailer, load_events, summarize_sessions


class RadarParserTest(unittest.TestCase):
    def test_load_events_reads_jsonl_files_and_skips_bad_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.jsonl").write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "kind": "request",
                                "id": 1,
                                "sessionID": "ses_a",
                                "timestamp": "2026-04-25T01:00:00.000Z",
                                "body": {"messages": [{"role": "user", "content": "hello"}]},
                            }
                        ),
                        "{bad json",
                        json.dumps(
                            {
                                "kind": "response",
                                "id": 1,
                                "sessionID": "ses_a",
                                "timestamp": "2026-04-25T01:00:01.000Z",
                                "status": 200,
                                "body": {"answer": "OK"},
                            }
                        ),
                    ]
                )
            )

            events = load_events(root)

            self.assertEqual([event["kind"] for event in events], ["request", "response"])
            self.assertEqual(events[0]["sessionID"], "ses_a")
            self.assertEqual(events[0]["file"].name, "a.jsonl")

    def test_summarize_sessions_counts_and_sorts_by_latest_activity(self):
        events = [
            {"sessionID": "ses_old", "timestamp": "2026-04-25T01:00:00.000Z", "kind": "request"},
            {"sessionID": "ses_new", "timestamp": "2026-04-25T02:00:00.000Z", "kind": "request"},
            {"sessionID": "ses_old", "timestamp": "2026-04-25T01:00:01.000Z", "kind": "response"},
        ]

        sessions = summarize_sessions(events)

        self.assertEqual([item["sessionID"] for item in sessions], ["ses_new", "ses_old"])
        self.assertEqual(sessions[1]["count"], 2)
        self.assertEqual(sessions[1]["start_time"], "2026-04-25T01:00:00.000Z")
        self.assertEqual(sessions[1]["end_time"], "2026-04-25T01:00:01.000Z")

    def test_tailer_loads_history_then_only_new_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "trace.jsonl"
            target.write_text(
                json.dumps(
                    {
                        "kind": "request",
                        "id": 1,
                        "sessionID": "ses_a",
                        "timestamp": "2026-04-25T01:00:00.000Z",
                        "body": {"messages": [{"role": "user", "content": "hello"}]},
                    }
                )
                + "\n"
            )
            tailer = JsonlTailer(root, "ses_a")

            self.assertEqual(len(tailer.poll()), 1)

            with target.open("a") as handle:
                handle.write(
                    json.dumps(
                        {
                            "kind": "response",
                            "id": 1,
                            "sessionID": "ses_a",
                            "timestamp": "2026-04-25T01:00:01.000Z",
                            "status": 200,
                            "body": {"answer": "OK"},
                        }
                    )
                    + "\n"
                )

            rows = tailer.poll()

            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["kind"], "response")

    def test_cli_help_imports_under_python39_when_available(self):
        python39 = shutil.which("python3.9")
        if not python39:
            self.skipTest("python3.9 is not installed")

        script = Path(__file__).with_name("opencode_api_radar.py")
        result = subprocess.run([python39, str(script), "--help"], capture_output=True, text=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OpenCode API JSONL radar", result.stdout)


if __name__ == "__main__":
    unittest.main()
