"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createCreatorsClient, createServer, getConfig, parseAmazonIndiaAsin, parsePort } = require("./server");

const env = {
  CREATORS_API_CREDENTIAL_ID: "test-id",
  CREATORS_API_CREDENTIAL_SECRET: "test-secret",
  CREATORS_API_CREDENTIAL_VERSION: "3.2",
  AMAZON_PARTNER_TAG: "test-21",
  FRONTEND_ORIGIN: "https://example.github.io"
};

const completeItem = {
  asin: "B000123456",
  detailPageURL: "https://www.amazon.in/dp/B000123456?tag=approved-21",
  images: { primary: { large: { url: "https://m.media-amazon.com/images/example.jpg" } } },
  itemInfo: {
    title: { displayValue: "Test product" },
    features: { displayValues: ["First feature", "Second feature"] }
  }
};

function createMockSdk(result, requestRecord = {}) {
  class ApiClient {}
  class GetItemsRequestContent {}
  class DefaultApi {
    constructor(apiClient) {
      requestRecord.apiClient = apiClient;
    }

    async getItems(marketplace, request) {
      requestRecord.marketplace = marketplace;
      requestRecord.request = request;
      return result;
    }
  }

  return { ApiClient, DefaultApi, GetItemsRequestContent };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test("extracts ASINs from supported Amazon.in product URLs", () => {
  assert.equal(parseAmazonIndiaAsin("https://www.amazon.in/dp/b000123456?tag=other-21"), "B000123456");
  assert.equal(parseAmazonIndiaAsin("https://amazon.in/gp/product/B000123456/"), "B000123456");
  assert.equal(parseAmazonIndiaAsin("https://m.amazon.in/gp/aw/d/B000123456"), "B000123456");
  assert.equal(parseAmazonIndiaAsin("https://www.amazon.in/dp/0132350882"), "0132350882");
});

test("rejects non-product, short, and non-India URLs", () => {
  assert.equal(parseAmazonIndiaAsin("https://amzn.in/d/006YE2UG"), null);
  assert.equal(parseAmazonIndiaAsin("https://www.amazon.com/dp/B000123456"), null);
  assert.equal(parseAmazonIndiaAsin("http://www.amazon.in/dp/B000123456"), null);
  assert.equal(parseAmazonIndiaAsin("https://www.amazon.in:8443/dp/B000123456"), null);
  assert.equal(parseAmazonIndiaAsin("https://example@www.amazon.in/dp/B000123456"), null);
  assert.equal(parseAmazonIndiaAsin("https://www.amazon.in/gp/cart/view.html"), null);
});

test("requires backend credentials and a documented Creators API v3 version", () => {
  assert.throws(() => getConfig({}), /CREATORS_API_CREDENTIAL_ID/);
  assert.throws(() => getConfig({ ...env, CREATORS_API_CREDENTIAL_VERSION: "2.2" }), /3\.1, 3\.2, or 3\.3/);
  assert.throws(() => getConfig({ ...env, CREATORS_API_CREDENTIAL_VERSION: "3.9" }), /3\.1, 3\.2, or 3\.3/);
  assert.throws(() => getConfig({ ...env, FRONTEND_ORIGIN: "http://192.168.1.20:5500" }), /https origin or an http loopback/);
  assert.equal(getConfig({ ...env, FRONTEND_ORIGIN: "http://127.0.0.1:5500" }).frontendOrigin, "http://127.0.0.1:5500");
  for (const version of ["3.1", "3.2", "3.3"]) {
    assert.equal(getConfig({ ...env, CREATORS_API_CREDENTIAL_VERSION: version }).credentialVersion, version);
  }
});

test("uses valid host-provided ports and rejects malformed values", () => {
  assert.equal(parsePort("10000"), 10000);
  assert.equal(parsePort(undefined), 3000);
  assert.throws(() => parsePort("10000invalid"), /PORT must be a valid TCP port/);
  assert.throws(() => parsePort("0"), /PORT must be a valid TCP port/);
  assert.throws(() => parsePort("65536"), /PORT must be a valid TCP port/);
});

test("uses the official SDK GetItems operation for Amazon India", async () => {
  const requestRecord = {};
  const creatorsClient = createCreatorsClient(
    getConfig(env),
    createMockSdk({ itemsResult: { items: [completeItem] } }, requestRecord)
  );

  assert.deepEqual(await creatorsClient.getItem("B000123456"), {
    asin: "B000123456",
    title: "Test product",
    image: "https://m.media-amazon.com/images/example.jpg",
    features: ["First feature", "Second feature"],
    detailPageURL: "https://www.amazon.in/dp/B000123456?tag=approved-21"
  });
  assert.equal(requestRecord.apiClient.credentialId, env.CREATORS_API_CREDENTIAL_ID);
  assert.equal(requestRecord.apiClient.credentialSecret, env.CREATORS_API_CREDENTIAL_SECRET);
  assert.equal(requestRecord.apiClient.version, env.CREATORS_API_CREDENTIAL_VERSION);
  assert.equal(requestRecord.marketplace, "www.amazon.in");
  assert.deepEqual(requestRecord.request.partnerTag, env.AMAZON_PARTNER_TAG);
  assert.deepEqual(requestRecord.request.itemIds, ["B000123456"]);
  assert.deepEqual(requestRecord.request.resources, [
    "images.primary.large",
    "itemInfo.title",
    "itemInfo.features"
  ]);
});

test("returns a missing primary image as null without inventing image data", async () => {
  const itemWithoutImage = { ...completeItem, images: undefined };
  const client = createCreatorsClient(
    getConfig(env),
    createMockSdk({ itemsResult: { items: [itemWithoutImage] } })
  );

  const product = await client.getItem("B000123456");
  assert.equal(product.image, null);
  assert.equal(product.title, "Test product");
});

test("treats an invalid primary image URL as missing without discarding the product", async () => {
  const client = createCreatorsClient(
    getConfig(env),
    createMockSdk({
      itemsResult: {
        items: [{ ...completeItem, images: { primary: { large: { url: "not a valid URL" } } } }]
      }
    })
  );

  assert.equal((await client.getItem("B000123456")).image, null);
});

test("maps Amazon throttling and hides SDK error details", async () => {
  const client = createCreatorsClient(getConfig(env), createMockSdk(null));
  const apiError = Object.assign(new Error("secret-token-value"), { status: 429 });
  const throttledClient = createCreatorsClient(getConfig(env), {
    ApiClient: class {},
    GetItemsRequestContent: class {},
    DefaultApi: class {
      async getItems() {
        throw apiError;
      }
    }
  });
  await assert.rejects(client.getItem("B000123456"), { status: 404 });
  await assert.rejects(throttledClient.getItem("B000123456"), {
    status: 429,
    message: /temporarily limiting/
  });
});

test("POST /api/import-product validates URLs and returns only clean product data", async () => {
  let lookupCount = 0;
  const server = createServer({
    config: getConfig(env),
    creatorsClient: {
      async getItem(asin) {
        lookupCount += 1;
        assert.equal(asin, "B000123456");
        return {
          asin,
          title: "Test product",
          image: null,
          features: [],
          detailPageURL: completeItem.detailPageURL
        };
      }
    }
  });
  await listen(server);
  const address = server.address();

  try {
    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/import-product`, {
      method: "POST",
      headers: {
        Origin: env.FRONTEND_ORIGIN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: "https://amzn.in/d/006YE2UG" })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_PRODUCT_URL");
    assert.equal(lookupCount, 0);

    const imported = await fetch(`http://127.0.0.1:${address.port}/api/import-product`, {
      method: "POST",
      headers: {
        Origin: env.FRONTEND_ORIGIN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: "https://www.amazon.in/dp/B000123456" })
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.headers.get("cache-control"), "no-store");
    assert.deepEqual(await imported.json(), {
      product: {
        asin: "B000123456",
        title: "Test product",
        image: null,
        features: [],
        detailPageURL: completeItem.detailPageURL
      }
    });
    assert.equal(lookupCount, 1);
  } finally {
    await close(server);
  }
});

test("restricts browser origins and exposes a credential-free health check", async () => {
  const server = createServer({
    config: getConfig(env),
    creatorsClient: { async getItem() { throw new Error("Must not be called"); } }
  });
  await listen(server);
  const address = server.address();

  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const blocked = await fetch(`http://127.0.0.1:${address.port}/api/import-product`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: "https://www.amazon.in/dp/B000123456" })
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), "null");
  } finally {
    await close(server);
  }
});
