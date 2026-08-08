"""Proxy helpers shared by browser-based peer website collectors."""

from __future__ import annotations

import os
from urllib.parse import urlsplit


def playwright_proxy_options() -> dict[str, str] | None:
    proxy_url = str(
        os.environ.get("PEER_WEBSITE_EFFECTIVE_PROXY_URL") or ""
    ).strip()
    require_proxy = str(
        os.environ.get("PEER_WEBSITE_REQUIRE_PROXY") or ""
    ).strip().lower() in {"1", "true", "yes", "on"}
    if not proxy_url:
        if require_proxy:
            raise RuntimeError("官网采集要求强制代理，但浏览器未收到代理配置")
        return None

    try:
        parsed = urlsplit(proxy_url)
        proxy_port = parsed.port
    except ValueError as error:
        raise RuntimeError("浏览器代理地址格式无效") from error
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or proxy_port is None
    ):
        raise RuntimeError("浏览器代理必须是带端口的本机 HTTP(S) 地址")
    return {"server": proxy_url}
