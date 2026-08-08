from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


COLLECTOR_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_ROOT))

import peer_website_runner as runner  # noqa: E402


class FakeProcess:
    def __init__(self, return_code: int = 0) -> None:
        self.pid = 999_999
        self.returncode = return_code

    def wait(self, timeout: int | None = None) -> int:
        return self.returncode


class PeerWebsiteRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.definition = runner.COLLECTORS[0]

    def test_normalize_project_keeps_stable_source_identity(self) -> None:
        project = runner.normalize_project(
            {
                "project_id": 123,
                "source_url": "https://www.aqyimin.com/detail/123",
                "project_name": "测试项目",
                "category": "加拿大",
                "investment_amount": "100 万加元",
                "application_process": [{"number": "1", "stage": "准备"}],
            },
            self.definition,
            "2026-08-08T02:30:00+08:00",
        )
        self.assertEqual(project["source_project_id"], "123")
        self.assertEqual(
            project["canonical_url"],
            "https://www.aqyimin.com/detail/123",
        )
        self.assertEqual(project["country_or_region"], "加拿大")
        self.assertEqual(project["process_source_type"], "html_text")

    def test_build_snapshot_uses_v1_contract(self) -> None:
        started = runner.datetime(2026, 8, 8, 2, 30, tzinfo=runner.CHINA_TIMEZONE)
        finished = runner.datetime(2026, 8, 8, 3, 30, tzinfo=runner.CHINA_TIMEZONE)
        snapshot = runner.build_snapshot(
            "web-test-20260808",
            started,
            finished,
            [{"peer_code": "peer-a"}],
        )
        self.assertEqual(snapshot["schema_version"], "peer-website-snapshot/v1")
        self.assertEqual(snapshot["started_at"], "2026-08-08T02:30:00+08:00")
        self.assertEqual(snapshot["collectors"][0]["peer_code"], "peer-a")

    def test_duplicate_source_ids_are_stably_scoped_by_project_evidence(self) -> None:
        projects = [
            {
                "source_project_id": "shared-id",
                "canonical_url": "https://welltrendvisa.com/europe#shared-id",
                "project_name": "欧洲项目",
            },
            {
                "source_project_id": "shared-id",
                "canonical_url": "https://welltrendvisa.com/australia#shared-id",
                "project_name": "澳洲项目",
            },
        ]
        runner.disambiguate_project_identities(projects)
        self.assertNotEqual(
            projects[0]["source_project_id"], projects[1]["source_project_id"]
        )
        self.assertTrue(projects[0]["source_project_id"].startswith("shared-id@"))

    def test_welltrend_ids_are_scoped_even_when_only_one_duplicate_is_seen(self) -> None:
        definition = next(
            item for item in runner.COLLECTORS if item.peer_code == "peer-g"
        )
        project = runner.normalize_project(
            {
                "project_id": "shared-id",
                "source_url": "https://welltrendvisa.com/europe#shared-id",
                "project_name": "欧洲项目",
            },
            definition,
            "2026-08-08T02:30:00+08:00",
        )
        self.assertTrue(project["source_project_id"].startswith("shared-id@"))

    def test_execute_collector_marks_mixed_results_partial(self) -> None:
        raw_records = [
            {
                "scrape_status": "ok",
                "project_slug": "valid-project",
                "source_url": "https://www.aqyimin.com/detail/valid-project",
                "project_name": "有效项目",
                "category": "美国",
            },
            {
                "scrape_status": "error",
                "source_url": "https://www.aqyimin.com/detail/broken",
                "project_name": "失败项目",
                "error": "页面模板变化",
            },
        ]

        def fake_popen(command: list[str], **_: object) -> FakeProcess:
            output_directory = Path(command[command.index("--output-dir") + 1])
            output_directory.mkdir(parents=True, exist_ok=True)
            (output_directory / self.definition.output_name).write_text(
                json.dumps(raw_records, ensure_ascii=False),
                encoding="utf-8",
            )
            return FakeProcess()

        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(runner.subprocess, "Popen", side_effect=fake_popen):
                payload, manifest = runner.execute_collector(
                    self.definition,
                    Path(temporary),
                    "test-version",
                    60,
                )
        self.assertEqual(payload["status"], "partial")
        self.assertEqual(payload["success_count"], 1)
        self.assertEqual(payload["failed_count"], 1)
        self.assertEqual(payload["projects"][0]["source_project_id"], "valid-project")
        self.assertIn("页面模板变化", payload["error"])
        self.assertEqual(manifest["return_code"], 0)

    def test_execute_collector_rejects_invalid_success_record(self) -> None:
        raw_records = [{"scrape_status": "ok", "project_name": "缺少网址"}]

        def fake_popen(command: list[str], **_: object) -> FakeProcess:
            output_directory = Path(command[command.index("--output-dir") + 1])
            output_directory.mkdir(parents=True, exist_ok=True)
            (output_directory / self.definition.output_name).write_text(
                json.dumps(raw_records, ensure_ascii=False),
                encoding="utf-8",
            )
            return FakeProcess()

        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(runner.subprocess, "Popen", side_effect=fake_popen):
                payload, _ = runner.execute_collector(
                    self.definition,
                    Path(temporary),
                    "test-version",
                    60,
                )
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["success_count"], 0)
        self.assertEqual(payload["failed_count"], 1)
        self.assertEqual(payload["projects"], [])
        self.assertIn("缺少名称或官网链接", payload["error"])

    def test_safe_text_redacts_credentials(self) -> None:
        text = runner.safe_text("request failed token=very-secret-value")
        self.assertNotIn("very-secret-value", text)
        self.assertIn("[REDACTED]", text)

    def test_peer_proxy_is_scoped_to_only_the_configured_collector(self) -> None:
        peer_b = next(
            item for item in runner.COLLECTORS if item.peer_code == "peer-b"
        )
        with patch.dict(
            runner.os.environ,
            {
                "HTTP_PROXY": "http://global-proxy.example:8080",
                "PEER_WEBSITE_PEER_B_PROXY_URL": "http://127.0.0.1:17890",
            },
            clear=False,
        ):
            peer_b_environment, peer_b_proxy = runner.build_collector_environment(
                peer_b
            )
            peer_a_environment, peer_a_proxy = runner.build_collector_environment(
                self.definition
            )

        self.assertTrue(peer_b_proxy)
        self.assertEqual(
            peer_b_environment["HTTPS_PROXY"], "http://127.0.0.1:17890"
        )
        self.assertFalse(peer_a_proxy)
        self.assertNotIn("HTTP_PROXY", peer_a_environment)
        self.assertNotIn("http_proxy", peer_a_environment)

    def test_peer_proxy_rejects_non_loopback_address(self) -> None:
        peer_b = next(
            item for item in runner.COLLECTORS if item.peer_code == "peer-b"
        )
        with patch.dict(
            runner.os.environ,
            {"PEER_WEBSITE_PEER_B_PROXY_URL": "http://proxy.example:8080"},
            clear=False,
        ):
            with self.assertRaisesRegex(ValueError, "本机 HTTP"):
                runner.build_collector_environment(peer_b)

    def test_import_rejections_are_counted_as_incomplete(self) -> None:
        result = {
            "http_status": 201,
            "response": {
                "ok": True,
                "status": "partial",
                "collectors": [
                    {"status": "completed"},
                    {"status": "rejected"},
                ],
            },
        }
        self.assertEqual(
            runner.count_non_completed_import_collectors(result), 1
        )


if __name__ == "__main__":
    unittest.main()
