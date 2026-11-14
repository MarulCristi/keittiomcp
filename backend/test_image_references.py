import asyncio
import json
import os
import unittest
from unittest.mock import patch

import httpx

from image_references import ImageSearch, parse_images, public_https_url


def payload(items):
    return {"results": [{"status_code": 200, "content": {"results": {"organic": items}}}]}


def item(number=1):
    return {"title": f"Milk carton {number}", "image": f"https://images.example.com/{number}.jpg",
            "link": f"/url?q=https%3A%2F%2Fshop.example.com%2Fmilk-{number}&sa=U", "domain": "untrusted.example.com"}


class ImageParserTests(unittest.TestCase):
    def test_unwraps_sources_deduplicates_and_caps_three(self):
        result = parse_images(payload([item(), item(), item(2), item(3), item(4)]))
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0].source_url, "https://shop.example.com/milk-1")
        self.assertEqual(result[0].source_domain, "shop.example.com")

    def test_rejects_unsafe_urls_and_malformed_provider_data(self):
        for url in ["javascript:alert(1)", "data:image/svg+xml,test", "http://example.com/a", "https://127.0.0.1/a",
                    "https://10.0.0.1/a", "https://[::1]/a", "https://localhost/a", "https://a.local/a",
                    "https://user:password@example.com/a", "https://example.com:8000/a", "https://a.com\\@127.0.0.1/x"]:
            self.assertIsNone(public_https_url(url), url)
        for malformed in [None, {}, {"results": None}, {"results": [None]}, payload([None, {}, {"image": [], "link": []}])]:
            self.assertEqual(parse_images(malformed), [])

    def test_web_api_base64_thumbnail_uses_original_website_image(self):
        record = {**item(), "image": "data:image/jpeg;base64,AAAA", "high_res_image": "https://cdn.valio.fi/mediafiles/example"}
        result = parse_images({"results": [{"json": {"results": {"organic": [record]}}}]})
        self.assertEqual(result[0].image_url, record["high_res_image"])


class ImageSearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"OXYLABS_API_KEY": "", "OXYLABS_WEB_API_KEY": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    async def test_polling_shares_one_lookup_and_never_waits_for_provider(self):
        gate = asyncio.Event()
        calls = []
        async def handler(request):
            calls.append(request)
            await gate.wait()
            return httpx.Response(200, json=payload([item()]))
        with patch.dict(os.environ, {"OXYLABS_USERNAME": "test-user", "OXYLABS_PASSWORD": "test-secret"}):
            search = ImageSearch(httpx.MockTransport(handler))
            self.assertEqual((await search.lookup("milk")).status, "loading")
            self.assertEqual((await search.lookup("milk")).status, "loading")
            await asyncio.sleep(0)
            gate.set()
            await search.pending["milk"]
            self.assertEqual((await search.lookup("milk")).status, "ready")
            self.assertEqual((await search.lookup("milk")).status, "ready")
        self.assertEqual(len(calls), 1)

    async def test_limits_concurrent_lookups(self):
        with patch.dict(os.environ, {"OXYLABS_USERNAME": "test-user", "OXYLABS_PASSWORD": "test-secret"}):
            search = ImageSearch(httpx.MockTransport(lambda request: httpx.Response(200, json=payload([]))))
            for index in range(4):
                self.assertEqual((await search.lookup(f"milk {index}")).status, "loading")
            self.assertEqual((await search.lookup("fifth request")).status, "unavailable")
            await asyncio.gather(*search.pending.values())

    async def test_web_api_key_uses_documented_endpoint_and_parsed_json(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://webapi.oxylabs.io/v1/scrape/google/search")
            self.assertEqual(request.headers["authorization"], "Bearer test-token")
            self.assertEqual(json.loads(request.content)["tbm"], "isch")
            return httpx.Response(200, json={"results": [{"json": {"results": {"organic": [item()]}}}]})
        with patch.dict(os.environ, {"OXYLABS_API_KEY": "test-token"}):
            result = await ImageSearch(httpx.MockTransport(handler)).search("milk")
        self.assertEqual(result.status, "ready")
        self.assertEqual(len(result.images), 1)

    async def test_missing_credentials_never_calls_provider(self):
        def handler(request):
            self.fail("No network call should be attempted")
        with patch.dict(os.environ, {"OXYLABS_USERNAME": "", "OXYLABS_PASSWORD": ""}):
            result = await ImageSearch(httpx.MockTransport(handler)).search("milk")
        self.assertEqual(result.status, "not_configured")

    async def test_provider_contract_cache_and_no_credentials_in_response(self):
        calls = []
        def handler(request):
            calls.append(request)
            body = json.loads(request.content)
            self.assertEqual(body["source"], "google_search")
            self.assertEqual(body["query"], "Valio milk")
            self.assertEqual(body["context"], [{"key": "tbm", "value": "isch"}])
            self.assertEqual(request.url.host, "realtime.oxylabs.io")
            return httpx.Response(200, json=payload([item()]))
        with patch.dict(os.environ, {"OXYLABS_USERNAME": "test-user", "OXYLABS_PASSWORD": "test-secret"}):
            search = ImageSearch(httpx.MockTransport(handler))
            result = await search.search("Valio milk")
            result.images.clear()
            cached = await search.search("Valio milk")
        self.assertEqual(len(calls), 1)
        self.assertEqual(cached.status, "ready")
        self.assertEqual(len(cached.images), 1)
        self.assertNotIn("test-secret", cached.model_dump_json())

    async def test_failures_are_optional_and_do_not_leak_provider_body(self):
        for status in [401, 429, 500]:
            with patch.dict(os.environ, {"OXYLABS_USERNAME": "test-user", "OXYLABS_PASSWORD": "test-secret"}):
                search = ImageSearch(httpx.MockTransport(lambda request: httpx.Response(status, text="test-secret")))
                result = await search.search("milk")
            self.assertEqual(result.status, "unavailable")
            self.assertNotIn("test-secret", result.model_dump_json())

    async def test_timeout_and_no_results(self):
        def timeout(request):
            raise httpx.ReadTimeout("timeout")
        with patch.dict(os.environ, {"OXYLABS_USERNAME": "test-user", "OXYLABS_PASSWORD": "test-secret"}):
            self.assertEqual((await ImageSearch(httpx.MockTransport(timeout)).search("milk")).status, "unavailable")
            empty = await ImageSearch(httpx.MockTransport(lambda request: httpx.Response(200, json=payload([])))).search("milk")
            self.assertEqual(empty.status, "empty")


if __name__ == "__main__":
    unittest.main()
