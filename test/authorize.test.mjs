import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadAloudHandler, createReadAloudExpressHandler } from "../dist/server.js";

function fakeRes() {
  const sent = {};
  const res = {
    status(code) { sent.status = code; return res; },
    json(body) { sent.body = body; },
    setHeader() {},
  };
  return { sent, res };
}

test("the Fetch handler passes the Request to authorize", async () => {
  let seen;
  const handler = createReadAloudHandler({
    authorize: (body, request) => {
      seen = { body, auth: request.headers.get("authorization") };
      return false;
    },
  });
  const res = await handler(
    new Request("http://x/", {
      method: "POST",
      headers: { authorization: "Bearer abc" },
      body: JSON.stringify({ text: "hi" }),
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(seen.auth, "Bearer abc");
  assert.equal(seen.body.text, "hi");
});

test("the Express handler passes req to authorize", async () => {
  let seen;
  const { sent, res } = fakeRes();
  const req = { body: { text: "hi" }, headers: { authorization: "Bearer abc" } };
  await createReadAloudExpressHandler({
    authorize: (body, r) => {
      seen = r;
      return false;
    },
  })(req, res);
  assert.equal(sent.status, 401);
  assert.equal(seen, req);
  assert.equal(seen.headers.authorization, "Bearer abc");
});

test("an authorize that only reads the body still works", async () => {
  const { sent, res } = fakeRes();
  await createReadAloudExpressHandler({ authorize: (body) => body.text !== "hi" })({ body: { text: "hi" } }, res);
  assert.equal(sent.status, 401);
});
