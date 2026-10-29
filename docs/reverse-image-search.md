# JICHO AI reverse-image search

Image description and reverse-image search perform different jobs. Qwen and Gemini describe content; online reverse-image search finds matching image copies in an external search index. Local matching searches only JICHO AI's own archive and cases.

## Recommended testing provider: SerpApi Google Lens

SerpApi currently lists 250 searches per month on its free plan; its Starter plan lists 1,000 searches for USD 25/month. Check the current [pricing](https://serpapi.com/pricing) before subscribing. This requires a SerpApi account, not a Google Cloud account.

1. Register for the free plan at [SerpApi](https://serpapi.com/).
2. Copy your private API key from the account dashboard into `C:\Users\pc\Documents\aivs\.env`:

```dotenv
REVERSE_IMAGE_PROVIDER=serpapi
SERPAPI_API_KEY=your_serpapi_key_here
```

3. Save locally, restart JICHO AI using `start-windows.bat`, and refresh the browser. Never paste the key into chat or commit `.env`.
4. Use **Reverse image search** for a new investigation or **Search prior postings** on a case image. Results appear inside JICHO AI. Case searches continue in Background tasks while you use other pages.

The connector uploads a resized, metadata-stripped JPEG copy to SerpApi's [Image API workflow](https://serpapi.com/google-lens-upload-an-image), then requests [Google Lens exact matches](https://serpapi.com/google-lens-exact-matches-api). Original files remain unchanged locally. Only use material cleared for external processing. Matches can be absent, inaccessible or undated; the original uploader is not guaranteed.

This provider option has been tested with simulated API responses. A live search is still required after you supply your own valid key. No account has been created and no paid subscription has been purchased for you.

## Manual testing fallback

Open a case's image and select **Search prior postings**, then **Use manual reverse search** when no provider is configured. The existing manual workflow offers Google Lens, TinEye and other services. Upload only cleared/public material, inspect the matching source pages, and record the links, service and dates as evidence leads in the case. Dates and similarity require review; an empty result does not establish originality.

Google provides [instructions for uploading a picture to Lens](https://support.google.com/websearch/answer/1325808?hl=en). This browser workflow does not require a Google Cloud project. It is manual, rather than an unattended API search.

## Enable automatic web matching

Cloud Vision is an alternative provider. It requires a Cloud Vision key, not a Gemini or Google Fact Check key.

1. Have the institution's administrator open [Google Cloud Console](https://console.cloud.google.com/) and select or create the institution's project.
2. Enable billing and the [Cloud Vision API](https://console.cloud.google.com/apis/library/vision.googleapis.com). Read the [pricing](https://cloud.google.com/vision/pricing); usage can incur charges.
3. Under APIs and Services → Credentials, create an API key. Restrict it to Cloud Vision API. Apply an appropriate server IP restriction if your institution has a stable public egress IP; a browser-referrer restriction is inappropriate for this server-side connector.
4. Store the key locally in `C:\Users\pc\Documents\aivs\.env`:

```dotenv
REVERSE_IMAGE_PROVIDER=google
GOOGLE_VISION_API_KEY=your_real_cloud_vision_key
```

5. Do not paste the key into chat or commit `.env`. Restart JICHO AI and refresh the browser.
6. Upload a public image through Reverse image search. The automatic investigation will run the configured connector. For an image already in a case, use **Search prior postings**, confirm external processing, and open **Background tasks** for the saved results.
7. Validate with a known previously published public image before relying on the service. Confirm that source-page links open and inspect the date and match labels.

Google's [setup guide](https://docs.cloud.google.com/vision/docs/setup) covers project, billing and API enablement; [Web Detection documentation](https://docs.cloud.google.com/vision/docs/detecting-web) describes matching-page results.

## What results mean

- **Configured** means a key exists, not that Google has accepted it. The first real search validates access; failures are shown explicitly.
- Matching pages are returned with publication dates where accessible. JICHO AI compares retrieved candidate images locally and distinguishes confirmed matches from provider-reported results it could not check.
- The earliest dated confirmed result is only the earliest among the returned accessible pages. It does not prove the first upload, original uploader, capture date or authenticity. Page publication dates can be wrong or edited.
- Private, removed, unindexed and access-restricted posts may be unavailable.
- Missing configuration, API failure and a successful search with zero matches are different states.

## Other automatic providers

[TinEye's API](https://help.tineye.com/article/241-can-i-use-tineye-for-commercial-purposes-or-high-volume-searching) is an alternative with its own account and paid search bundles; it does not require a Google Cloud account. JICHO AI supports Cloud Vision and SerpApi; TinEye API use would need an additional adapter. Gemini alone is not a replacement for this image-index matching workflow.

## Validation completed

Tests used a simulated provider to verify matching pages, local visual comparison, publication-date ordering, inaccessible-page handling, HTTP-200 provider error detection, absent-key handling, secret redaction and durable case results. Browser testing covered the image action, external-processing confirmation, background task and dated source links without script errors. No live Google search has been verified because the institution's Cloud Vision key has not been supplied.

## No matches and service failures
A successful Google Lens response can contain an `error` field saying it returned no results. JICHO AI treats only this exact no-result response, with HTTP success and provider status Success, as a completed search with no matches. It is not proof that the image is original. Missing or malformed responses, account errors, rate/quota limits and timeouts remain failures, with private error messages.

Google Lens searches have a separate 60-second default timeout, configurable through `SERPAPI_SEARCH_TIMEOUT_MS` (1–120 seconds). This avoids applying the shorter text-search timeout to image matching. No automatic paid retry or search-provider purchase is performed.

Live checks of this fix used a generated geometric image (completed with zero matches) and the previously used public military photo (three returned, locally confirmed matches). Case images were not automatically resent during troubleshooting.
