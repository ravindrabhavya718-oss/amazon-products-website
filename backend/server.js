"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const MARKETPLACE = "www.amazon.in";
const CREATORS_API_RESOURCES = [
  "images.primary.large",
  "itemInfo.title",
  "itemInfo.features"
];
const MAX_BODY_BYTES = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseAmazonIndiaAsin(value) {
  if (typeof value !== "string" || value.length > 2048) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !["amazon.in", "www.amazon.in", "m.amazon.in"].includes(url.hostname.toLowerCase())) {
    return null;
  }

  const match = url.pathname.match(/^\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i);
  return match ? match[1].toUpperCase() : null;
}

function getConfig(env) {
  const names = [
    "CREATORS_API_CREDENTIAL_ID",
    "CREATORS_API_CREDENTIAL_SECRET",
    "CREATORS_API_CREDENTIAL_VERSION",
    "AMAZON_PARTNER_TAG",
    "FRONTEND_ORIGIN"
  ];
  const missing = names.filter(name => !env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (!["3.1", "3.2", "3.3"].includes(env.CREATORS_API_CREDENTIAL_VERSION)) {
    throw new Error("CREATORS_API_CREDENTIAL_VERSION must be 3.1, 3.2, or 3.3.");
  }

  let frontendOrigin;
  try {
    frontendOrigin = new URL(env.FRONTEND_ORIGIN).origin;
  } catch {
    throw new Error("FRONTEND_ORIGIN must be a valid website origin.");
  }
  const localDevelopmentOrigin = frontendOrigin.startsWith("http://") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(frontendOrigin).hostname);
  if (frontendOrigin !== env.FRONTEND_ORIGIN ||
      (!frontendOrigin.startsWith("https://") && !localDevelopmentOrigin)) {
    throw new Error("FRONTEND_ORIGIN must be an https origin or an http loopback origin for local development.");
  }

  return {
    credentialId: env.CREATORS_API_CREDENTIAL_ID,
    credentialSecret: env.CREATORS_API_CREDENTIAL_SECRET,
    credentialVersion: env.CREATORS_API_CREDENTIAL_VERSION,
    partnerTag: env.AMAZON_PARTNER_TAG,
    frontendOrigin
  };
}

function createCreatorsClient(config, sdk = require("./vendor/creatorsapi-nodejs-sdk/dist")) {
  const apiClient = new sdk.ApiClient();
  apiClient.credentialId = config.credentialId;
  apiClient.credentialSecret = config.credentialSecret;
  apiClient.version = config.credentialVersion;
  const api = new sdk.DefaultApi(apiClient);

  return {
    async getItem(asin) {
      const request = new sdk.GetItemsRequestContent();
      request.partnerTag = config.partnerTag;
      request.itemIds = [asin];
      request.resources = CREATORS_API_RESOURCES;

      let result;
      try {
        result = await api.getItems(MARKETPLACE, request);
      } catch (error) {
        const status = error?.status || error?.statusCode || error?.response?.status;
        if (status === 429) {
          throw new HttpError(429, "AMAZON_RATE_LIMITED", "Amazon is temporarily limiting requests. Please wait and try again.");
        }
        if (status === 404) {
          throw new HttpError(404, "PRODUCT_NOT_FOUND", "No Amazon.in product was found for that ASIN.");
        }
        throw new HttpError(502, "AMAZON_REQUEST_FAILED", "Amazon could not complete the product lookup. Check API access and backend credentials.");
      }

      const item = result?.itemsResult?.items?.find(entry => entry.asin?.toUpperCase() === asin);
      if (!item) {
        throw new HttpError(404, "PRODUCT_NOT_FOUND", "No Amazon.in product was found for that ASIN.");
      }

      const title = item.itemInfo?.title?.displayValue;
      const image = item.images?.primary?.large?.url;
      const detailPageURL = item.detailPageURL;
      const features = item.itemInfo?.features?.displayValues;
      let imageUrl = null;
      let affiliateUrl;
      try {
        affiliateUrl = typeof detailPageURL === "string" ? new URL(detailPageURL) : null;
      } catch {
        throw new HttpError(502, "AMAZON_INCOMPLETE_PRODUCT", "Amazon did not return a valid product link.");
      }
      if (typeof image === "string") {
        try {
          imageUrl = new URL(image);
        } catch {
          imageUrl = null;
        }
      }

      if (typeof title !== "string" || !title.trim() ||
          !affiliateUrl || affiliateUrl.protocol !== "https:" ||
          !["amazon.in", "www.amazon.in"].includes(affiliateUrl.hostname)) {
        throw new HttpError(502, "AMAZON_INCOMPLETE_PRODUCT", "Amazon did not return the required product title and affiliate link.");
      }

      return {
        asin,
        title: title.trim().slice(0, 500),
        image: imageUrl?.protocol === "https:" && imageUrl.hostname === "m.media-amazon.com" ? image : null,
        features: Array.isArray(features)
          ? features.filter(feature => typeof feature === "string").slice(0, 10).map(feature => feature.slice(0, 1000))
          : [],
        detailPageURL
      };
    }
  };
}

function sendJson(response, status, value, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new HttpError(413, "REQUEST_TOO_LARGE", "The request is too large.");
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Send a valid JSON request.");
  }
}

function getClientAddress(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  return typeof forwardedFor === "string"
    ? forwardedFor.split(",")[0].trim()
    : request.socket.remoteAddress || "unknown";
}

function createServer({ config, creatorsClient, now = Date.now } = {}) {
  const productClient = creatorsClient || createCreatorsClient(config);
  const requestTimes = new Map();

  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" }, "*");
      return;
    }

    const origin = request.headers.origin;
    if (origin !== config.frontendOrigin) {
      sendJson(response, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "This website is not allowed to use this service." } }, "null");
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin"
      });
      response.end();
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/import-product") {
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Endpoint not found." } }, origin);
      return;
    }

    const currentTime = now();
    if (requestTimes.size > 1000) {
      for (const [client, recentTimes] of requestTimes) {
        if (!recentTimes.some(time => currentTime - time < RATE_LIMIT_WINDOW_MS)) {
          requestTimes.delete(client);
        }
      }
    }
    const address = getClientAddress(request);
    const times = (requestTimes.get(address) || []).filter(time => currentTime - time < RATE_LIMIT_WINDOW_MS);
    if (times.length >= RATE_LIMIT_MAX_REQUESTS) {
      sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "Too many import requests. Please wait a minute and try again." } }, origin);
      return;
    }
    times.push(currentTime);
    requestTimes.set(address, times);

    try {
      if (!request.headers["content-type"]?.includes("application/json")) {
        throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as JSON.");
      }

      const body = await readJson(request);
      const asin = parseAmazonIndiaAsin(body?.url);
      if (!asin) {
        throw new HttpError(400, "INVALID_PRODUCT_URL", "Paste a full HTTPS Amazon.in product URL using /dp/, /gp/product/, or /gp/aw/d/ and a 10-character ASIN.");
      }

      const product = await productClient.getItem(asin);
      sendJson(response, 200, { product }, origin);
    } catch (error) {
      const httpError = error instanceof HttpError
        ? error
        : new HttpError(500, "INTERNAL_ERROR", "The product import could not be completed.");
      if (httpError.status >= 500) {
        console.error(`Product import failed (${httpError.code}).`);
      }
      sendJson(response, httpError.status, {
        error: { code: httpError.code, message: httpError.message }
      }, origin);
    }
  });
}

if (require.main === module) {
  let config;
  try {
    config = getConfig(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }

  if (config) {
    const port = Number.parseInt(process.env.PORT || "3000", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("PORT must be a valid TCP port.");
      process.exitCode = 1;
    } else {
      createServer({ config }).listen(port, () => {
        console.log(`Creators API backend listening on port ${port}.`);
      });
    }
  }
}

module.exports = { createCreatorsClient, createServer, getConfig, parseAmazonIndiaAsin };
