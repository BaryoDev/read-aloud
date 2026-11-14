# Changelog

## Unreleased

## 0.2.0 - 2026-11-14

- Add an Azure AI Speech backend (`AzureSpeechTTS`, and `backend: "azure"` or `azure: { key, region }` on the handlers). It uses the documented REST text to speech endpoint, with a timeout and a cap on the audio size. It returns no word timings.
- With no Azure settings the handlers still use the Edge engine, as before.
- Docs: the Edge endpoint is unofficial and has answered 403 since about October 12 2026. It is best effort. Use the Azure backend for anything that has to work.
