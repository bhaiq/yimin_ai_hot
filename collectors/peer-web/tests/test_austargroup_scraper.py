from __future__ import annotations

import sys
import unittest
from pathlib import Path


COLLECTOR_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(COLLECTOR_ROOT))

try:
    import austargroup_scraper as scraper  # noqa: E402
except ModuleNotFoundError as exc:  # pragma: no cover - local minimal Python
    if exc.name != "lxml":
        raise
    scraper = None


class FakePage:
    def __init__(self, responses: list[object]) -> None:
        self.responses = list(responses)
        self.wait_calls = 0
        self.url = "https://www.austargroup.com/"

    def content(self) -> str:
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return str(response)

    def wait_for_timeout(self, _: int) -> None:
        self.wait_calls += 1


@unittest.skipIf(scraper is None, "lxml is not installed")
class WaitForRealPageTests(unittest.TestCase):
    def test_retries_while_page_is_navigating(self) -> None:
        page = FakePage(
            [
                RuntimeError(
                    "Page.content: Unable to retrieve content because "
                    "the page is navigating and changing the content."
                ),
                '<a href="/visa/info_123.html">项目</a>',
            ]
        )

        content = scraper.wait_for_real_page(
            page, r"/(?:visa|passport)/info_\d+\.html"
        )

        self.assertIn("info_123.html", content)
        self.assertEqual(page.wait_calls, 1)

    def test_does_not_hide_unrelated_browser_errors(self) -> None:
        page = FakePage([RuntimeError("browser process exited")])

        with self.assertRaisesRegex(RuntimeError, "browser process exited"):
            scraper.wait_for_real_page(page, r"expected")


if __name__ == "__main__":
    unittest.main()
