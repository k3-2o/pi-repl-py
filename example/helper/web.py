"""A small, provider-backed web client for the persistent pi-repl workspace."""

helper_description = """web — preloaded web client object for live web work.
Call its methods directly: web.search(query) to find sources, web.read(url_or_result) to read a known page, and web.map(url) to discover pages inside a site. It uses EXA_API_KEY, TAVILY_API_KEY, SERPER_API_KEY, and FIRECRAWL_API_KEY from the process environment; provider choice, fallback, response normalization, and balancing stay inside the object. Instead of: inventing a public search URL, browser User-Agent, and HTML scraper with urllib.

Search intelligently: compose precise, focused queries and split complex questions into targeted searches instead of writing one bloated query. web.search() returns a list of _SearchResult dataclass instances — access fields by attribute (result.title, result.url, result.snippet, result.provider) or result.as_dict(); they are not dicts and have no .get() method. Keep results in variables; do not print entire result lists, raw responses, or full page bodies. Inspect only bounded fields and slices such as result.title, result.url, result.snippet, results[:5], or page.text[:4000]. Read only promising sources, prefer primary sources, compare independent results, and print compact evidence with URLs. Use web.map only when exploring a known site. Avoid context bloat at every step."""

import json as _json
import os as _os
import time as _time
import urllib.error as _url_error
import urllib.request as _url_request
from dataclasses import dataclass as _dataclass
from urllib.parse import urlsplit as _urlsplit, urlunsplit as _urlunsplit


_TIMEOUT_SECONDS = 45
_READ_TIMEOUT_SECONDS = 60
_MAP_TIMEOUT_SECONDS = 60


@_dataclass
class _SearchResult:
    title: str
    url: str
    snippet: str = ""
    provider: str = ""
    score: float | None = None
    published: str | None = None

    def __repr__(self) -> str:
        title = self.title or self.url
        return f"SearchResult({title!r}, {self.url!r})"

    def __getitem__(self, key: str):
        return getattr(self, key)

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "provider": self.provider,
            "score": self.score,
            "published": self.published,
        }


@_dataclass
class _Page:
    url: str
    text: str
    title: str = ""
    provider: str = ""

    @property
    def markdown(self) -> str:
        return self.text

    def __repr__(self) -> str:
        title = f" {self.title!r}" if self.title else ""
        return f"Page({self.url!r}{title}, {len(self.text):,} chars, provider={self.provider!r})"


class _ProviderError(RuntimeError):
    def __init__(self, provider: str, message: str):
        self.provider = provider
        super().__init__(f"{provider}: {message}")


@_dataclass
class _ProviderState:
    uses: int = 0
    failures: int = 0
    cooldown_until: float = 0.0


class _Web:
    """Private implementation; only the configured ``web`` object is exposed."""

    _ENV_KEYS = {
        "exa": "EXA_API_KEY",
        "tavily": "TAVILY_API_KEY",
        "serper": "SERPER_API_KEY",
        "firecrawl": "FIRECRAWL_API_KEY",
    }

    # Search rotates through all four. A failed provider is skipped and cooled down.
    _SEARCH_RING = ("serper", "exa", "tavily", "firecrawl")

    # This is deliberately a priority order, as requested: Firecrawl first,
    # Tavily second, Exa last. A later provider is used only when an earlier one fails.
    _READ_ORDER = ("firecrawl", "tavily", "exa")

    # Both support mapping; the cursor shares usage between them over repeated calls.
    _MAP_RING = ("tavily", "firecrawl")

    def __init__(self):
        # The keys come from the environment inherited by the Pi process. This does
        # not read, source, or print the user's shell configuration file.
        self._keys = {name: _os.environ.get(env_name) for name, env_name in self._ENV_KEYS.items()}
        self._state = {name: _ProviderState() for name in self._ENV_KEYS}
        self._cursor = {"search": 0, "map": 0}

    def search(self, query: str, limit: int = 5) -> list[_SearchResult]:
        """Search the web; rotate providers and fall back on failure."""
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")
        limit = self._limit(limit)

        data, provider = self._run(
            self._SEARCH_RING,
            "search",
            lambda name: self._provider_search(name, query.strip(), limit),
            timeout=_TIMEOUT_SECONDS,
        )
        return self._normalize_search(provider, data, limit)

    def read(self, url_or_result: str | _SearchResult) -> _Page:
        """Read a known URL as clean text/Markdown; Firecrawl, then Tavily, then Exa."""
        url = self._coerce_url(url_or_result)
        data, provider = self._run(
            self._READ_ORDER,
            "read",
            lambda name: self._provider_read(name, url),
            timeout=_READ_TIMEOUT_SECONDS,
        )
        return self._normalize_page(provider, data, url)

    def map(self, url: str, limit: int = 50) -> list[str]:
        """Discover URLs inside a site using Tavily and Firecrawl with fallback."""
        if not isinstance(url, str) or not url.strip():
            raise ValueError("url must be a non-empty string")
        limit = self._limit(limit, maximum=500)

        data, provider = self._run(
            self._MAP_RING,
            "map",
            lambda name: self._provider_map(name, url.strip(), limit),
            timeout=_MAP_TIMEOUT_SECONDS,
        )
        return self._normalize_map(provider, data, limit)

    def _run(self, providers, operation: str, call, *, timeout: int):
        del timeout  # provider methods use the operation-specific constants.
        order = self._available_order(providers, operation)
        if not order:
            missing = [self._ENV_KEYS[name] for name in providers if not self._keys.get(name)]
            raise RuntimeError("no configured provider is available" + (f"; missing {', '.join(missing)}" if missing else ""))

        errors = []
        for provider in order:
            try:
                data = call(provider)
            except Exception as exc:
                self._record_failure(provider)
                errors.append(str(exc))
                continue

            state = self._state[provider]
            state.uses += 1
            state.failures = 0
            state.cooldown_until = 0.0
            if operation in self._cursor:
                ring = self._SEARCH_RING if operation == "search" else self._MAP_RING
                self._cursor[operation] = (ring.index(provider) + 1) % len(ring)
            return data, provider

        detail = "; ".join(errors) if errors else "all attempts failed"
        raise RuntimeError(f"web.{operation} failed across available providers: {detail}")

    def _available_order(self, providers, operation: str) -> list[str]:
        available = [name for name in providers if self._keys.get(name)]
        if not available:
            return []

        if operation in self._cursor:
            ring = self._SEARCH_RING if operation == "search" else self._MAP_RING
            start = self._cursor[operation] % len(ring)
            rotated = list(ring[start:]) + list(ring[:start])
            order = [name for name in rotated if name in available]
        else:
            order = available

        now = _time.monotonic()
        ready = [name for name in order if self._state[name].cooldown_until <= now]
        # If every configured provider is cooling down, permit the one whose cooldown
        # expires first rather than reporting a permanent outage.
        return ready or [min(order, key=lambda name: self._state[name].cooldown_until)]

    def _record_failure(self, provider: str) -> None:
        state = self._state[provider]
        state.failures += 1
        # Back off failed providers so repeated cells do not hammer a broken endpoint.
        state.cooldown_until = _time.monotonic() + min(300, 15 * (2 ** min(state.failures - 1, 4)))

    @staticmethod
    def _limit(value: int, maximum: int = 100) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError("limit must be an integer")
        if value < 1:
            raise ValueError("limit must be at least 1")
        return min(value, maximum)

    @staticmethod
    def _coerce_url(value: str | _SearchResult) -> str:
        if isinstance(value, _SearchResult):
            value = value.url
        if not isinstance(value, str) or not value.strip():
            raise ValueError("read expects a URL or a result returned by web.search()")
        return value.strip()

    def _provider_search(self, provider: str, query: str, limit: int):
        if provider == "exa":
            return self._post(
                provider,
                "https://api.exa.ai/search",
                {"query": query, "numResults": limit},
                timeout=_TIMEOUT_SECONDS,
                api_key_header="x-api-key",
            )
        if provider == "tavily":
            return self._post(
                provider,
                "https://api.tavily.com/search",
                {"query": query, "max_results": limit, "search_depth": "basic", "include_answer": False},
                timeout=_TIMEOUT_SECONDS,
                bearer=True,
            )
        if provider == "serper":
            return self._post(
                provider,
                "https://google.serper.dev/search",
                {"q": query, "num": limit},
                timeout=_TIMEOUT_SECONDS,
                api_key_header="X-API-KEY",
            )
        if provider == "firecrawl":
            return self._post(
                provider,
                "https://api.firecrawl.dev/v2/search",
                {"query": query, "limit": limit},
                timeout=_TIMEOUT_SECONDS,
                bearer=True,
            )
        raise _ProviderError(provider, "search is not supported")

    def _provider_read(self, provider: str, url: str):
        if provider == "firecrawl":
            return self._post(
                provider,
                "https://api.firecrawl.dev/v2/scrape",
                {"url": url, "formats": ["markdown"]},
                timeout=_READ_TIMEOUT_SECONDS,
                bearer=True,
            )
        if provider == "tavily":
            return self._post(
                provider,
                "https://api.tavily.com/extract",
                {"urls": [url]},
                timeout=_READ_TIMEOUT_SECONDS,
                bearer=True,
            )
        if provider == "exa":
            return self._post(
                provider,
                "https://api.exa.ai/contents",
                {"urls": [url], "text": True},
                timeout=_READ_TIMEOUT_SECONDS,
                api_key_header="x-api-key",
            )
        raise _ProviderError(provider, "read is not supported")

    def _provider_map(self, provider: str, url: str, limit: int):
        if provider == "tavily":
            return self._post(
                provider,
                "https://api.tavily.com/map",
                {"url": url, "max_depth": 1, "max_breadth": min(limit, 20), "limit": limit},
                timeout=_MAP_TIMEOUT_SECONDS,
                bearer=True,
            )
        if provider == "firecrawl":
            return self._post(
                provider,
                "https://api.firecrawl.dev/v2/map",
                {"url": url, "limit": limit},
                timeout=_MAP_TIMEOUT_SECONDS,
                bearer=True,
            )
        raise _ProviderError(provider, "map is not supported")

    def _post(
        self,
        provider: str,
        endpoint: str,
        payload: dict,
        *,
        timeout: int,
        bearer: bool = False,
        api_key_header: str | None = None,
    ) -> dict:
        key = self._keys.get(provider)
        if not key:
            raise _ProviderError(provider, f"{self._ENV_KEYS[provider]} is not set")

        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {key}"
        elif api_key_header:
            headers[api_key_header] = key
        request = _url_request.Request(
            endpoint,
            data=_json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with _url_request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", "replace")
        except _url_error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            detail = body[:400].replace("\n", " ")
            raise _ProviderError(provider, f"HTTP {exc.code}: {detail}") from exc
        except (_url_error.URLError, TimeoutError, OSError) as exc:
            raise _ProviderError(provider, str(exc)) from exc

        try:
            data = _json.loads(body)
        except _json.JSONDecodeError as exc:
            raise _ProviderError(provider, "returned non-JSON data") from exc
        if not isinstance(data, dict):
            raise _ProviderError(provider, "returned an unexpected JSON shape")
        return data

    def _normalize_search(self, provider: str, data: dict, limit: int) -> list[_SearchResult]:
        if provider == "exa":
            items = data.get("results", [])
        elif provider == "tavily":
            items = data.get("results", [])
        elif provider == "serper":
            items = data.get("organic", [])
        else:
            body = data.get("data", data)
            items = body.get("web", []) if isinstance(body, dict) else []
            if not items and isinstance(body, dict):
                items = body.get("results", [])

        results = []
        seen = set()
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or item.get("link")
            if not isinstance(url, str) or not url:
                continue
            key = self._canonical_url(url)
            if key in seen:
                continue
            seen.add(key)
            snippet = item.get("snippet") or item.get("content") or item.get("description") or ""
            if not snippet and isinstance(item.get("highlights"), list):
                snippet = " ".join(str(part) for part in item["highlights"])
            results.append(
                _SearchResult(
                    title=str(item.get("title") or ""),
                    url=url,
                    snippet=str(snippet or ""),
                    provider=provider,
                    score=self._number(item.get("score")),
                    published=item.get("publishedDate") or item.get("published_date") or item.get("date"),
                )
            )
            if len(results) >= limit:
                break
        return results

    def _normalize_page(self, provider: str, data: dict, requested_url: str) -> _Page:
        title = ""
        text = ""
        final_url = requested_url

        if provider == "firecrawl":
            body = data.get("data", data)
            if isinstance(body, dict):
                text = body.get("markdown") or body.get("content") or body.get("text") or ""
                metadata = body.get("metadata") or {}
                if isinstance(metadata, dict):
                    title = metadata.get("title") or ""
                    final_url = metadata.get("sourceURL") or metadata.get("url") or requested_url
        elif provider == "tavily":
            items = data.get("results", [])
            item = items[0] if isinstance(items, list) and items else {}
            if isinstance(item, dict):
                text = item.get("raw_content") or item.get("content") or ""
                title = item.get("title") or ""
                final_url = item.get("url") or requested_url
        else:  # Exa Contents
            items = data.get("results", [])
            item = items[0] if isinstance(items, list) and items else {}
            if isinstance(item, dict):
                text = item.get("text") or item.get("content") or ""
                title = item.get("title") or ""
                final_url = item.get("url") or requested_url

        return _Page(url=str(final_url), text=str(text), title=str(title), provider=provider)

    def _normalize_map(self, provider: str, data: dict, limit: int) -> list[str]:
        body = data.get("data", data)
        if not isinstance(body, dict):
            return []
        # Tavily returns ``results``; Firecrawl Map returns ``links``.
        items = body.get("results", []) if provider == "tavily" else body.get("links", [])
        if isinstance(items, dict):
            items = items.get("urls", []) or items.get("links", [])
        results = []
        seen = set()
        for item in items if isinstance(items, list) else []:
            value = item.get("url") if isinstance(item, dict) else item
            if not isinstance(value, str) or not value:
                continue
            key = self._canonical_url(value)
            if key not in seen:
                seen.add(key)
                results.append(value)
            if len(results) >= limit:
                break
        return results

    @staticmethod
    def _canonical_url(value: str) -> str:
        try:
            parts = _urlsplit(value.strip())
            host = (parts.hostname or "").lower()
            if not host:
                return value.strip()
            port = parts.port
            netloc = host
            if port and not ((parts.scheme == "http" and port == 80) or (parts.scheme == "https" and port == 443)):
                netloc = f"{host}:{port}"
            path = parts.path.rstrip("/") or "/"
            return _urlunsplit((parts.scheme.lower(), netloc, path, parts.query, ""))
        except ValueError:
            return value.strip()

    @staticmethod
    def _number(value):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# One configured object is exposed to the REPL. Construction reads env only; no API
# request happens until the model calls one of its methods.
web = _Web()
