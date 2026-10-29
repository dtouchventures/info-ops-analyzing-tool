# Enable optional Gemini image descriptions

The feature is installed in the existing JICHO AI project. Local Ollama remains the default. Gemini stays disabled until both server settings below are supplied.

1. Create your own API key in [Google AI Studio](https://aistudio.google.com/apikey). Complete Google's account and terms steps yourself. Choose an image-capable model with free quota available in your account; the application cannot guarantee that a chosen model is free.
2. Open `C:\Users\pc\Documents\aivs\.env` locally and add these settings with your actual key and model name:

```dotenv
GEMINI_API_KEY=your_key_here
GEMINI_IMAGE_MODEL=your_available_model_name
```

3. Save the file and restart JICHO AI using your normal launcher. Refresh the browser. The upload form will show the configured model.
4. Select **Use Google Gemini for these public images** only for images cleared for external processing. Leave it unchecked for local processing.

Do not paste the key into chat or commit `.env`. It stays on the server and is not returned to the browser. Submitted copies are resized and stripped of embedded metadata. Originals stay unchanged locally. Gemini receives images, not the case's claims or full report. Uploaded and linked images belonging to the investigation are included; video frames are not sent by this feature.

Results are labelled as unverified AI observations. They do not prove authenticity, establish the first uploader, or replace reverse-image matching. Local checks continue when Gemini is unavailable or its quota is exhausted.

Google's unpaid-service data terms allow submitted content and responses to be used to improve products and reviewed by humans. Use public, cleared material only. See [data terms](https://ai.google.dev/gemini-api/terms), [pricing](https://ai.google.dev/gemini-api/docs/pricing), and [supported API connection](https://ai.google.dev/gemini-api/docs/openai).

Validation: integration tests used a simulated Gemini provider to verify consent, local default, bounded metadata-free image copies, labelled results, quota/error fallback, authenticated status, and credential redaction. Browser checks verified the option stays unchecked and disabled when configuration is missing. A live Google request requires your key and selected model.
