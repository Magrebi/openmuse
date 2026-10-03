import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_INPUT_BUDGET,
  BrowserInputGuard,
  browserInputSchema,
  clickInputSchema,
  containsSecret,
  keyInputSchema,
  looksCredentialed,
  looksTransactional,
  originOf,
  scrollInputSchema,
  typeInputSchema,
} from "../apps/server/src/engine/browser-input.ts";

test("input schemas mirror the worker's own bounds", () => {
  assert.equal(scrollInputSchema.safeParse({ deltaY: 5000 }).success, true);
  assert.equal(scrollInputSchema.safeParse({ deltaY: -5000 }).success, true);
  assert.equal(scrollInputSchema.safeParse({ deltaY: 5001 }).success, false);
  assert.equal(scrollInputSchema.safeParse({ deltaY: -5001 }).success, false);
  assert.equal(clickInputSchema.safeParse({ x: 0, y: 0 }).success, true);
  assert.equal(clickInputSchema.safeParse({ x: 1279, y: 799 }).success, true);
  assert.equal(clickInputSchema.safeParse({ x: 1280, y: 10 }).success, false);
  assert.equal(clickInputSchema.safeParse({ x: 10, y: 800 }).success, false);
  assert.equal(clickInputSchema.safeParse({ x: -1, y: 10 }).success, false);
  assert.equal(typeInputSchema.safeParse({ text: "a".repeat(10_000) }).success, true);
  assert.equal(typeInputSchema.safeParse({ text: "a".repeat(10_001) }).success, false);
  assert.equal(typeInputSchema.safeParse({ text: "" }).success, false);
  for (const key of ["Enter", "Tab", "Escape", "Control+a", "Meta+a", "Shift+Tab", "PageDown"])
    assert.equal(keyInputSchema.safeParse({ key }).success, true, key);
  for (const key of ["F5", "Enter\n", "control+a", "Delete ", "Cmd+a", ""])
    assert.equal(keyInputSchema.safeParse({ key }).success, false, key);
});

test("the wire schema cannot smuggle a second action into one payload", () => {
  assert.equal(browserInputSchema.safeParse({ type: "scroll", deltaY: 600 }).success, true);
  assert.equal(browserInputSchema.safeParse({ type: "key", key: "Enter" }).success, true);
  // Unknown keys are stripped rather than rejected, so a scroll can never carry a key
  // press and a click can never carry text.
  assert.deepEqual(
    browserInputSchema.parse({ type: "scroll", deltaY: 600, key: "Enter", text: "x" }),
    { type: "scroll", deltaY: 600 },
  );
  assert.deepEqual(browserInputSchema.parse({ type: "click", x: 5, y: 5, text: "smuggled" }), {
    type: "click",
    x: 5,
    y: 5,
  });
  assert.equal(browserInputSchema.safeParse({ type: "click", x: 5 }).success, false);
  assert.equal(
    browserInputSchema.safeParse({ type: "navigate", url: "https://x.example" }).success,
    false,
  );
});

test("a session becomes operable as soon as it is observed", () => {
  const guard = new BrowserInputGuard({});
  assert.equal(guard.browserId, undefined, "nothing is operable before an observation");
  guard.begin();
  const state = guard.adopt("session-1", "https://shop.example/");
  assert.equal(guard.browserId, "session-1");
  assert.equal(state.browserId, "session-1");
  guard.begin();
});

test("guard updates own only the browser fields, never the whole task state", () => {
  // The guard is built from the task state at the start of a run, but the caller writes
  // the result over the live task state. Echoing the build-time snapshot back would
  // silently revert anything another tool persisted since.
  const guard = new BrowserInputGuard({ carriedFromEarlierRun: "keep me" });
  assert.equal("carriedFromEarlierRun" in guard.adopt("s", "https://a.example/"), false);
  guard.adopt("s", "https://a.example/");
  assert.equal("carriedFromEarlierRun" in guard.complete("https://a.example/x"), false);
  assert.equal("carriedFromEarlierRun" in guard.uncertain("click", "worker gone"), false);
  assert.deepEqual(guard.adopt("s", "https://a.example/"), {
    browserId: "s",
    browserOrigin: "https://a.example",
    browserLastUrl: "https://a.example/",
    browserFrozen: false,
    browserInputUncertain: "",
  });
});

test("the guard spends a bounded budget and refuses to go past it", () => {
  const guard = new BrowserInputGuard({});
  assert.equal(guard.remaining, BROWSER_INPUT_BUDGET);
  // A session is always observed before it is driven, so it has an origin to stay inside.
  guard.adopt("session-1", "https://shop.example/");
  for (let index = 0; index < BROWSER_INPUT_BUDGET; index++) {
    guard.begin();
    guard.complete("https://shop.example/p/1");
  }
  assert.equal(guard.remaining, 0);
  assert.throws(() => guard.begin(), /used all 25 browser input actions/);
});

test("a session with no observed origin cannot be driven", () => {
  const guard = new BrowserInputGuard({ browserId: "session-1" });
  guard.begin();
  guard.complete("about:blank");
  assert.equal(guard.isFrozen, true);
  assert.throws(() => guard.begin(), /left the site it started on/);
});

test("a session that leaves its origin freezes further input until it is re-observed", () => {
  const guard = new BrowserInputGuard({});
  guard.adopt("session-1", "https://shop.example/catalogue");
  assert.equal(guard.isFrozen, false);
  guard.begin();
  const drifted = guard.complete("https://payments.example/checkout");
  assert.equal(guard.isFrozen, true);
  assert.equal(drifted.browserFrozen, true);
  assert.throws(() => guard.begin(), /left the site it started on/);
  // Re-observing is the only way back in, and it re-arms for the new origin.
  guard.adopt("session-1", "https://payments.example/checkout");
  assert.equal(guard.isFrozen, false);
  guard.begin();
});

test("a same-origin navigation keeps the session interactive", () => {
  const guard = new BrowserInputGuard({});
  guard.adopt("session-1", "https://shop.example/catalogue");
  assert.equal(guard.urlBefore, "https://shop.example/catalogue");
  guard.begin();
  const next = guard.complete("https://shop.example/p/65w-charger");
  assert.equal(guard.isFrozen, false);
  assert.equal(next.browserFrozen, false);
  assert.equal(next.browserOrigin, "https://shop.example");
  assert.equal(next.browserInputSpent, 1);
});

test("leaving the web entirely counts as leaving the origin", () => {
  for (const url of ["about:blank", "data:text/html,<b>hi</b>", "file:///etc/hosts"]) {
    const guard = new BrowserInputGuard({});
    guard.adopt("session-1", "https://shop.example/catalogue");
    guard.begin();
    guard.complete(url);
    assert.equal(guard.isFrozen, true, url);
    assert.throws(() => guard.begin(), /left the site it started on/, url);
  }
});

test("guard state survives a restart from the checkpointed task state", () => {
  const first = new BrowserInputGuard({});
  first.adopt("session-1", "https://shop.example/");
  first.complete("https://shop.example/a");
  first.complete("https://other.example/b");
  // A resumed run rebuilds the guard from what was persisted, so neither the spend nor
  // the freeze is lost across a restart.
  const resumed = new BrowserInputGuard(first.complete("https://other.example/b"));
  assert.equal(resumed.isFrozen, true);
  assert.equal(resumed.remaining, BROWSER_INPUT_BUDGET - 3);
});

test("an uncertain input is recorded, never replayed, and pauses further input", () => {
  const guard = new BrowserInputGuard({});
  guard.adopt("session-1", "https://shop.example/");
  guard.begin();
  const state = guard.uncertain("click", "worker unavailable");
  assert.equal(state.browserInputUncertain, "click: worker unavailable");
  assert.equal(
    state.browserInputSpent,
    undefined,
    "an uncertain attempt must not hand the model a fresh action",
  );
  // Retrying an unknown outcome is refused, so a dead worker cannot be hammered.
  assert.equal(guard.isUncertain, true);
  assert.throws(() => guard.begin(), /unknown outcome/);
  assert.throws(() => guard.begin(), /unknown outcome/);

  // Reading the page is how an unknown outcome is resolved.
  guard.adopt("session-1", "https://shop.example/product");
  assert.equal(guard.isUncertain, false);
  guard.begin();
});

test("re-observing clears the stored uncertainty instead of leaving it to block input", () => {
  // A resumed run reads the flag back out of the checkpointed task state.
  const resumed = new BrowserInputGuard({ browserInputUncertain: "click: worker unavailable" });
  assert.throws(() => resumed.begin(), /unknown outcome/);
  // The cleared marker must overwrite the stored value; JSONB merges cannot delete a key,
  // so a stale non-empty value here would freeze input for the rest of the task.
  const merged = { ...resumed, ...resumed.adopt("session-1", "https://shop.example/product") };
  assert.equal(merged.browserInputUncertain, "");
  assert.equal(new BrowserInputGuard(merged).isUncertain, false);
});

test("origins are compared by scheme, host and port", () => {
  assert.equal(originOf("https://shop.example/p/1"), "https://shop.example");
  assert.equal(originOf("http://shop.example/a"), "http://shop.example");
  assert.equal(originOf("http://shop.example:8080/a"), "http://shop.example:8080");
  assert.equal(originOf("about:blank"), undefined);
  assert.equal(originOf("not a url"), undefined);
});

test("checkout and confirmation pages are treated as transactional", () => {
  for (const url of [
    "https://shop.example/checkout",
    "https://shop.example/cart/checkout/",
    "https://shop.example/account/orders/confirm",
    "https://hotel.example/bookings/2026",
  ])
    assert.equal(looksTransactional(url, "Anything"), true, url);
  for (const title of [
    "Checkout",
    "Secure payment",
    "Order summary",
    "Confirm your order",
    "Your booking confirmation",
    "Buy now",
  ])
    assert.equal(looksTransactional("https://shop.example/p/1", title), true, title);
  assert.equal(looksTransactional("https://shop.example/p/65w-charger", "USB-C Charger"), false);
  assert.equal(looksTransactional("https://shop.example/catalogue", "Catalog"), false);
  // A bare confirmation word is not a transaction; these are ordinary pages.
  for (const title of [
    "Confirmation bias in UX research",
    "Confirm your newsletter preferences",
    "Sign in to your account",
  ])
    assert.equal(looksTransactional("https://news.example/story", title), false, title);
  // Deliberately still broad: an article that discusses checkout pauses rather than risks.
  assert.equal(looksTransactional("https://news.example/story", "Checkout design patterns"), true);
});

test("sign-in pages are recognised so typing routes to the user", () => {
  for (const url of [
    "https://shop.example/login",
    "https://shop.example/account/signin",
    "https://shop.example/register",
    "https://shop.example/auth/reset",
  ])
    assert.equal(looksCredentialed(url, "Anything"), true, url);
  assert.equal(looksCredentialed("https://shop.example/p/charger", "USB-C Charger"), false);
  assert.equal(looksCredentialed("https://shop.example/", "Sign in to your account"), true);
});

test("credential-shaped text is refused without flagging ordinary prose", () => {
  assert.equal(containsSecret("hunter2"), false);
  assert.equal(containsSecret("Find the cheapest 65W USB-C charger"), false);
  assert.equal(
    containsSecret("The page asks for a password reset, which I cannot complete for you."),
    false,
  );
  assert.equal(containsSecret("password: hunter2"), true);
  assert.equal(containsSecret("api_key=abc123def456"), true);
  // Ordinary product copy that merely contains a secret-ish word stays typeable.
  assert.equal(containsSecret("auth: none"), false);
  assert.equal(containsSecret("Secret Garden Deluxe"), false);
  assert.equal(containsSecret("4111111111111111"), true, "a Luhn-valid card number");
  assert.equal(containsSecret("4111 1111 1111 1111"), true);
  assert.equal(containsSecret("1234567812345678"), false, "not Luhn-valid, so not read as a card");
  assert.equal(
    containsSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r"),
    true,
  );
  assert.equal(containsSecret("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6"), true);
});
