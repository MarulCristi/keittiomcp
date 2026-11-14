# Website image references

The chat fetches up to three small website images after a catalog lookup or agent result, using the selected product name. It does not send the chef's full request, kitchen rules, order amounts or supplier margins to the image provider. Images are illustrative search matches, not confirmation of the exact SKU, dietary suitability, availability or price.

Add a Web API key to the ignored repository `.env` or `backend/.env`, then restart the backend:

```dotenv
OXYLABS_API_KEY=your_web_api_key
```

`OXYLABS_WEB_API_KEY` is also supported and takes precedence. For the older Web Scraper API, use these instead:

```dotenv
OXYLABS_USERNAME=your_web_scraper_api_username
OXYLABS_PASSWORD=your_web_scraper_api_password
```

Use Web Scraper API credentials, not a dashboard login or proxy credentials. These variables must never use a `NEXT_PUBLIC_` prefix.

`GET /api/image_references?query=Valio%20milk` starts or polls a lookup and returns `{status, provider, images}`. Each image has `title`, `image_url`, `source_url`, and `source_domain`. Status is `loading`, `ready`, `empty`, `not_configured`, or `unavailable`. The frontend polls every two seconds, with at most four concurrent backend lookups. Missing credentials, provider errors and timeouts do not block purchasing. Successful lookups are cached in memory for one hour (maximum 128 queries); empty lookups for one minute. The browser also deduplicates queries and offers retry for failures.

The Web API implementation uses `/v1/scrape/google/search`, `output: ["json"]`, and `tbm: "isch"`: https://developers.oxylabs.io/api-reference/dedicated-scrapers/search-engine-scrapers

The older Web Scraper API uses `google_search`, parsed results, and `context: tbm=isch`: https://developers.oxylabs.io/api-targets/search-engines/google/search/image-search

Images load directly from the returned public HTTPS image URL without a backend image proxy or generation. Each card links to the original source; broken images keep a usable source link. Images belong to their respective owners. Browser preview still uses the real image endpoint when it is available; purchasing remains simulated. No image results feed back into purchasing decisions.

Run the isolated backend checks from the repository root:

```powershell
backend/.venv/Scripts/python.exe -m unittest discover -s backend -p test_image_references.py
```

This endpoint follows the existing hackathon API's access model. Authentication and shared rate limiting are needed before public deployment; cache limits are not a substitute for those controls.
