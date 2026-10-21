# Amazon Creators API backend

This separate Node.js service validates Amazon.in product URLs and uses Amazon's official Node.js Creators API SDK to call `GetItems`. The SDK source is vendored from Amazon's official SDK ZIP, version 1.3.0, with its Apache 2.0 license and notice in `vendor/creatorsapi-nodejs-sdk`.

The product endpoint is `POST /api/import-product`. Its JSON body is `{ "url": "https://www.amazon.in/dp/ASIN000000" }`; success returns only `{ "product": { "asin", "title", "image", "features", "detailPageURL" } }`. If Amazon does not return a usable primary image, `image` is `null`. Detail-page URL is returned by the GetItems item response; the SDK's GetItems request model has no separate resource for it. The backend requests the documented `images.primary.large`, `itemInfo.title`, and `itemInfo.features` resources.

## Prerequisites

- Node.js 20.12 or newer
- A fully approved Amazon.in Associates account and Creators API access
- A valid Amazon.in Partner Tag
- Your own Credential ID, Credential Secret, and credential version from Associates Central

Amazon's current onboarding guidance requires a fully accepted Associates account and qualifying sales for Creators API access. Credential versions `3.1`, `3.2`, and `3.3` are supported by the current SDK. Amazon.in is listed in the EU region; credentials and marketplace access must be approved for your account.

## Run locally in VS Code

In the VS Code terminal (PowerShell), from the repository root:

```powershell
Set-Location backend
Copy-Item .env.example .env
code .env
npm.cmd run build:sdk
npm.cmd test
npm.cmd start
```

Edit `backend/.env` with your real values before starting the service. The default frontend origin is the deployed GitHub Pages origin; for browser testing from a local development server such as VS Code Live Server at `http://127.0.0.1:5500`, change it to that exact local origin:

- `CREATORS_API_CREDENTIAL_ID`
- `CREATORS_API_CREDENTIAL_SECRET`
- `CREATORS_API_CREDENTIAL_VERSION` (the exact version assigned to your credentials)
- `AMAZON_PARTNER_TAG` (your own approved India tag)
- `FRONTEND_ORIGIN=https://ravindrabhavya718-oss.github.io`
- `PORT=3000` (hosting providers may set this automatically)

The `.env` file is ignored by Git. Never put these values in `index.html` or frontend configuration. `npm.cmd run build:sdk` installs/builds the official Amazon SDK from the vendored source; `npm.cmd test` uses a mock SDK and does not call Amazon. The SDK's upstream build-time dependencies report npm audit advisories during compilation; those packages are pruned afterward, and the runtime dependency audit (`npm audit --omit=dev`) reports zero vulnerabilities.

### Test locally

With the service running, open a second VS Code terminal:

```powershell
curl.exe -i http://localhost:3000/health
curl.exe -i -X POST http://localhost:3000/api/import-product `
  -H "Origin: https://ravindrabhavya718-oss.github.io" `
  -H "Content-Type: application/json" `
  -d "{\"url\":\"https://www.amazon.in/dp/PASTE_A_REAL_10_CHARACTER_ASIN\"}"
```

The health response should be `{"status":"ok"}`. The import command only succeeds if your credentials, Partner Tag, marketplace access, and ASIN are valid; these values have not been tested here. For local browser testing, set `IMPORT_API_URL` to `http://localhost:3000` and serve the frontend from the matching loopback origin in `FRONTEND_ORIGIN`. For the curl command above, keep the GitHub Pages origin in `.env`; it sends that origin explicitly. The deployed GitHub Pages site is HTTPS and therefore requires a deployed HTTPS backend URL.

Accepted URLs are HTTPS pages on `amazon.in`, `www.amazon.in`, or `m.amazon.in` using `/dp/ASIN`, `/gp/product/ASIN`, or `/gp/aw/d/ASIN`. Short links such as `amzn.in/d/...` are rejected because the ASIN cannot be read without following the link.

## Configure the static frontend

GitHub Pages cannot read server environment variables, so the page has one public URL setting in `index.html`:

```js
const IMPORT_API_URL = "";
```

For local testing, set it to `http://localhost:3000`. Before publishing the frontend, set it to the separately deployed backend's public HTTPS origin, with no trailing path. This value is only the public endpoint URL; it is not a credential.

Imported Amazon content is saved in the visitor's browser for up to 24 hours and is not published into the shared website catalog. GitHub Pages is static hosting and does not provide a safe browser-to-repository write path.

## Deploy the backend separately

For example, create a Render Web Service connected to this repository:

1. Set the service root directory to `backend`.
2. Use Node.js 20.12 or newer.
3. Set the build command to `npm run build:sdk && npm test`.
4. Set the start command to `npm start`.
5. Enter the credential ID, credential secret, credential version, Partner Tag, and `FRONTEND_ORIGIN` in the hosting provider's **backend service environment variables**. Do not add credentials as GitHub Pages settings or frontend build variables.
6. Deploy the backend yourself, then confirm `https://YOUR-BACKEND-HOST/health` returns `{"status":"ok"}`.
7. Set `IMPORT_API_URL` in `index.html` to `https://YOUR-BACKEND-HOST` and publish the frontend yourself when ready.

CORS permits the configured GitHub Pages origin only, the endpoint validates the posted URL, limits requests, bounds the body size, and avoids logging upstream error details. CORS is not authentication; keep this service scoped to your expected traffic and use provider-level rate limiting if the service becomes public at scale.

No live Amazon Creators API request or hosting deployment was performed. The automated tests verify URL handling, SDK request construction, response validation, the health check, and CORS behavior using mock responses only.

## Official references

- [Amazon India Creators API SDK guide](https://affiliate-program.amazon.in/creatorsapi/docs/en-us/get-started/using-sdk)
- [Amazon India Creators API GetItems operation](https://affiliate-program.amazon.in/creatorsapi/docs/en-us/api-reference/operations/get-items)
- [Creators API request headers and marketplace reference](https://affiliate-program.amazon.in/creatorsapi/docs/en-us/concepts/common-request-headers-and-parameters)
- [Creators API best programming practices](https://affiliate-program.amazon.in/creatorsapi/docs/en-us/concepts/best-programming-practices)
- [Amazon.in Associates Program Operating Agreement](https://affiliate-program.amazon.in/help/operating/agreement)
