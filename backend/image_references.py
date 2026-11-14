"""Optional Oxylabs image references. Never used as purchasing evidence."""

import asyncio
import ipaddress
import os
import time
from collections import OrderedDict
from typing import Literal
from urllib.parse import parse_qs, urlsplit

import httpx
from pydantic import BaseModel, Field


class ImageReference(BaseModel):
    title: str
    image_url: str
    source_url: str
    source_domain: str


class ImageReferences(BaseModel):
    status: Literal["loading", "ready", "empty", "not_configured", "unavailable"]
    images: list[ImageReference] = Field(default_factory=list)
    provider: str = "Oxylabs"


def public_https_url(value: object) -> str | None:
    """Only return public HTTPS references; the backend never fetches these URLs."""
    if not isinstance(value, str) or len(value) > 4096:
        return None
    if any(ord(char) < 33 for char in value) or "\\" in value:
        return None
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if "." not in host or host.endswith((".local", ".localhost", ".internal", ".test", ".invalid")):
            return None
        try:
            # Domain names are allowed; literal IP addresses must be globally routable.
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            if all(char.isdigit() or char == "." for char in host):
                return None
        return value
    except ValueError:
        return None


def source_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    # Oxylabs' documented Google results use /url?q=<original source>.
    if value.startswith("/url?"):
        value = parse_qs(urlsplit(value).query).get("q", [""])[0]
    return public_https_url(value)


def parse_images(payload: object) -> list[ImageReference]:
    images: list[ImageReference] = []
    seen: set[str] = set()
    pages = payload.get("results", []) if isinstance(payload, dict) else []
    if not isinstance(pages, list):
        return images
    for page in pages:
        if not isinstance(page, dict) or page.get("status_code", 200) != 200:
            continue
        content = page.get("json", page.get("content"))
        results = content.get("results") if isinstance(content, dict) else None
        organic = results.get("organic", []) if isinstance(results, dict) else []
        if not isinstance(organic, list):
            continue
        for item in organic:
            if not isinstance(item, dict):
                continue
            image = public_https_url(item.get("image")) or public_https_url(item.get("high_res_image"))
            source = source_url(item.get("link"))
            if not image or not source or image in seen:
                continue
            seen.add(image)
            title = item.get("title")
            images.append(ImageReference(
                title=title[:160] if isinstance(title, str) and title.strip() else "Product image reference",
                image_url=image, source_url=source,
                source_domain=urlsplit(source).hostname or "",
            ))
            if len(images) == 3:
                return images
    return images


_KESKO_CDN_TEMPLATE = "https://public.keskofiles.com/f/k-ruoka/product/{gtin}?h=400"
_THUMBNAIL_TTL_SECONDS = 3600


def _bing_thumbnail_url(query: str) -> str:
    from urllib.parse import quote_plus

    q = quote_plus(" ".join(query.split())[:120])
    return f"https://th.bing.com/th?q={q}&w=240&h=240&c=7&rs=1&p=0&dpr=2&pid=1.7&mkt=fi-FI"


class ImageSearch:
    async def resolve_product_thumbnail(
        self,
        product_id: str,
        query: str,
        gtins: list[str] | None = None,
    ) -> ImageReferences:
        """Resolve a product photo via GTIN CDN first (~0.25s) with fast Bing thumbnail fallback (~0.5s)."""
        thumb_cache: dict[str, tuple[float, ImageReferences]] = self.__dict__.setdefault("_thumb_cache_inst", {})
        cache_key = f"{product_id}:{','.join(gtins or [])}"
        cached = thumb_cache.get(cache_key)
        now = time.monotonic()
        if cached and now - cached[0] < _THUMBNAIL_TTL_SECONDS:
            return cached[1]

        valio_source = f"https://www.valioaimo.fi/tuotteet/{product_id}"
        clean_gtins = [g.strip() for g in (gtins or []) if g and g.strip().isdigit()]
        matched_url: str | None = None
        source_label = "K-Ruoka / GS1 GTIN CDN"

        if clean_gtins:
            async def probe_gtin(client: httpx.AsyncClient, gtin: str) -> str | None:
                candidate = _KESKO_CDN_TEMPLATE.format(gtin=gtin)
                if not public_https_url(candidate):
                    return None
                try:
                    resp = await client.head(candidate)
                    if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image/"):
                        return candidate
                except Exception:
                    return None
                return None

            async with httpx.AsyncClient(timeout=2.0, follow_redirects=True) as client:
                results = await asyncio.gather(*(probe_gtin(client, g) for g in clean_gtins[:4]))
                for hit in results:
                    if hit:
                        matched_url = hit
                        break

        if not matched_url:
            fallback = _bing_thumbnail_url(query or product_id)
            if public_https_url(fallback):
                matched_url = fallback
                source_label = "Bing Product Thumbnail"

        images = (
            [
                ImageReference(
                    title=query or f"SKU {product_id}",
                    image_url=matched_url,
                    source_url=valio_source if public_https_url(valio_source) else matched_url,
                    source_domain="valioaimo.fi",
                )
            ]
            if matched_url
            else []
        )
        result = ImageReferences(
            status="ready" if images else "empty",
            images=images,
            provider=source_label,
        )
        thumb_cache[cache_key] = (now, result)
        return result
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport
        self.cache: OrderedDict[str, tuple[float, ImageReferences]] = OrderedDict()
        self.pending: dict[str, asyncio.Task] = {}

    async def lookup(self, query: str) -> ImageReferences:
        """Start/poll a bounded job so scraper latency never holds a proxy request open."""
        query = " ".join(query.split())[:200]
        key = query.casefold()
        job = self.pending.get(key)
        if job:
            if not job.done():
                return ImageReferences(status="loading")
            self.pending.pop(key)
            try:
                return job.result()
            except Exception:
                return ImageReferences(status="unavailable")
        cached = self.cache.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1].model_copy(deep=True)
        for old_key, old_job in list(self.pending.items()):
            if old_job.done():
                self.pending.pop(old_key)
                if not old_job.cancelled():
                    old_job.exception()  # Retrieve any error from an abandoned lookup.
        if len(self.pending) >= 4:
            return ImageReferences(status="unavailable")
        self.pending[key] = asyncio.create_task(self.search(query))
        return ImageReferences(status="loading")

    async def search(self, query: str) -> ImageReferences:
        username = os.getenv("OXYLABS_USERNAME", "").strip()
        password = os.getenv("OXYLABS_PASSWORD", "").strip()
        api_key = (os.getenv("OXYLABS_WEB_API_KEY") or os.getenv("OXYLABS_API_KEY") or "").strip()
        if not api_key and (not username or not password):
            return ImageReferences(status="not_configured")
        query = " ".join(query.split())[:200]
        cached = self.cache.get(query.casefold())
        if cached and cached[0] > time.monotonic():
            return cached[1].model_copy(deep=True)
        try:
            if api_key:
                endpoint = "https://webapi.oxylabs.io/v1/scrape/google/search"
                options = {"headers": {"Authorization": f"Bearer {api_key}"},
                           "json": {"query": query, "output": ["json"], "tbm": "isch", "pages": 1, "safe_search": True}}
            else:
                endpoint = "https://realtime.oxylabs.io/v1/queries"
                options = {"auth": (username, password),
                           "json": {"source": "google_search", "query": query, "parse": True,
                                    "pages": 1, "context": [{"key": "tbm", "value": "isch"}]}}
            async with httpx.AsyncClient(timeout=90, transport=self.transport, follow_redirects=False, trust_env=False) as client:
                response = await asyncio.wait_for(client.post(
                    endpoint, **options,
                ), timeout=95)
                response.raise_for_status()
                images = parse_images(response.json())
        except (httpx.HTTPError, ValueError, TimeoutError):
            # Do not expose credentials, provider responses, or interrupt the order flow.
            return ImageReferences(status="unavailable")
        result = ImageReferences(status="ready" if images else "empty", images=images)
        self.cache[query.casefold()] = (time.monotonic() + (3600 if images else 60), result)
        self.cache.move_to_end(query.casefold())
        while len(self.cache) > 128:
            self.cache.popitem(last=False)
        return result.model_copy(deep=True)


image_search = ImageSearch()
