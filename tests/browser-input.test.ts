import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_INPUT_BUDGET,
  BrowserInputGuard,
  browserWireInputSchema,
  clickAnyInputSchema,
  clickInputSchema,
  containsSecret,
  keyInputSchema,
  looksCredentialed,
  looksTransactional,
  MAX_DELAY,
  MAX_TABS,
  originOf,
  refSchema,
  refusesFill,
  scrollInputSchema,
  searchQuerySchema,
  tabsInputSchema,
  typeInputSchema,
  uploadFileNameSchema,
  waitInputSchema,
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
  // Everything the API accepts goes through the wire schema, which is what a takeover
  // console and the agent both send.
  assert.equal(browserWireInputSchema.safeParse({ type: "scroll", deltaY: 600 }).success, true);
  assert.equal(browserWireInputSchema.safeParse({ type: "key", key: "Enter" }).success, true);
  // A flat action strips unknown keys, so a scroll can never carry a key press.
  assert.deepEqual(
    browserWireInputSchema.parse({ type: "scroll", deltaY: 600, key: "Enter", text: "x" }),
    { type: "scroll", deltaY: 600 },
  );
  // The union branches are strict, so a click that also carries text is refused outright
  // rather than resolved to whichever branch happens to fit.
  assert.equal(
    browserWireInputSchema.safeParse({ type: "click", x: 5, y: 5, text: "smuggled" }).success,
    false,
  );
  assert.equal(browserWireInputSchema.safeParse({ type: "click", x: 5 }).success, false);
  assert.equal(
    browserWireInputSchema.safeParse({ type: "navigate", url: "https://x.example" }).success,
    false,
  );
  // A fill carries a ref and text, and nothing else that could act.
  assert.deepEqual(
    browserWireInputSchema.parse({ type: "fill", ref: "e4", text: "hi", x: 5, y: 5 }),
    { type: "fill", ref: "e4", text: "hi" },
  );
  assert.equal(browserWireInputSchema.safeParse({ type: "fill", text: "hi" }).success, false);
  assert.equal(browserWireInputSchema.safeParse({ type: "nav", to: "back" }).success, true);
  assert.equal(
    browserWireInputSchema.safeParse({ type: "nav", to: "https://x.example" }).success,
    false,
  );
  // An upload names a file; it cannot smuggle a path or an action alongside.
  assert.deepEqual(
    browserWireInputSchema.parse({ type: "upload", ref: "e1", file: "invoice.pdf" }),
    { type: "upload", ref: "e1", file: "invoice.pdf" },
  );
  assert.equal(
    browserWireInputSchema.safeParse({ type: "upload", ref: "e1", file: "../secret.pdf" }).success,
    false,
  );
});

test("an element ref is accepted only in the shape a snapshot issues", () => {
  for (const ref of ["e1", "e12", "e200", "e999"])
    assert.equal(refSchema.safeParse(ref).success, true, ref);
  for (const ref of [
    "",
    "e",
    "e0",
    "e01",
    "e1000",
    "E1",
    " e1",
    "e1 ",
    "a1",
    "#e1",
    '"; drop"',
    "[data-openmuse-ref=e1]",
    1,
    null,
    undefined,
  ])
    assert.equal(refSchema.safeParse(ref).success, false, JSON.stringify(ref));
  // A click takes one addressing mode or the other, never an ambiguous mixture.
  assert.equal(clickAnyInputSchema.safeParse({ ref: "e1" }).success, true);
  assert.equal(clickAnyInputSchema.safeParse({ x: 5, y: 5 }).success, true);
  assert.equal(clickAnyInputSchema.safeParse({ ref: "e1", x: 5, y: 5 }).success, false);
  assert.equal(clickAnyInputSchema.safeParse({ x: 5 }).success, false);
  assert.equal(clickAnyInputSchema.safeParse({}).success, false);
  // The tool-facing shape carries no `type`; the wire schema below adds it, so a model
  // cannot name the action itself.
  assert.equal(clickAnyInputSchema.safeParse({ type: "click", x: 5, y: 5 }).success, false);
});

test("a search query is bounded and cannot be empty", () => {
  assert.equal(searchQuerySchema.safeParse("usb c charger").success, true);
  assert.equal(searchQuerySchema.safeParse("  spaced  ").success, true);
  assert.equal(searchQuerySchema.safeParse("a".repeat(300)).success, true);
  assert.equal(searchQuerySchema.safeParse("a".repeat(301)).success, false);
  assert.equal(searchQuerySchema.safeParse("").success, false);
  assert.equal(searchQuerySchema.safeParse("   ").success, false);
});

test("a password field is refused a fill by the same rule the worker applies", () => {
  assert.equal(refusesFill("textbox", "Password", true), true);
  assert.equal(refusesFill("textbox", "PIN", false), true);
  assert.equal(refusesFill("textbox", "One-time code", false), true);
  assert.equal(refusesFill("textbox", "CVV", false), true);
  assert.equal(refusesFill("textbox", "Email address", false), false);
  // A word like "pin" buried inside a longer word is not a credential field.
  assert.equal(refusesFill("textbox", "Shipping address", false), false);
  assert.equal(refusesFill("textbox", "Coupon code", false), false);
  // A text box whose label mentions a password is refused even when the page did not
  // mark it as one: over-refusing costs the user one retry, under-refusing would type a
  // secret into the page.
  assert.equal(refusesFill("textbox", "Password reset help", false), true);
  // Only a textbox can hold a secret; a button labelled "Forgot password" is not one.
  assert.equal(refusesFill("button", "Forgot password", false), false);
  assert.equal(refusesFill("link", "Reset your password", false), false);
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

test("a wait is an observation and an upload names a plain file", () => {
  for (const value of [
    { until: "idle" },
    { until: "text" },
    { until: "element", ref: "e2" },
    { until: "delay", ms: 0 },
    { until: "delay", ms: MAX_DELAY },
  ])
    assert.equal(waitInputSchema.safeParse(value).success, true, JSON.stringify(value));
  // Each verb carries only its own parameter, so a wait cannot smuggle a selector or a
  // ref into the form that does not use one.
  assert.equal(waitInputSchema.safeParse({ until: "idle", ref: "e1" }).success, false);
  assert.equal(waitInputSchema.safeParse({ until: "element" }).success, false);
  assert.equal(waitInputSchema.safeParse({ until: "delay", ms: MAX_DELAY + 1 }).success, false);
  assert.equal(waitInputSchema.safeParse({ until: "idle", selector: "div" }).success, false);
  // The tool-facing shape carries no `type`; the wire schema adds it.
  assert.equal(waitInputSchema.safeParse({ type: "wait", until: "idle" }).success, false);
  for (const file of ["invoice.pdf", "Tax Return 2026.pdf"])
    assert.equal(uploadFileNameSchema.safeParse(file).success, true, file);
  for (const file of [
    "",
    "../secret.pdf",
    "../../etc/passwd",
    "/etc/passwd",
    "dir/file.pdf",
    "~/notes.pdf",
    "noextension",
  ])
    assert.equal(uploadFileNameSchema.safeParse(file).success, false, JSON.stringify(file));
});

test("tab actions carry exactly what their verb needs", () => {
  assert.equal(tabsInputSchema.safeParse({ action: "list" }).success, true);
  assert.equal(
    tabsInputSchema.safeParse({ action: "open", url: "https://example.com/" }).success,
    true,
  );
  assert.equal(tabsInputSchema.safeParse({ action: "switch", index: 0 }).success, true);
  assert.equal(tabsInputSchema.safeParse({ action: "close", index: 7 }).success, true);
  // `open` needs a public web address; a script or local path is not one.
  assert.equal(tabsInputSchema.safeParse({ action: "open" }).success, false);
  assert.equal(
    tabsInputSchema.safeParse({ action: "open", url: "javascript:alert(1)" }).success,
    false,
  );
  assert.equal(
    tabsInputSchema.safeParse({ action: "open", url: "file:///etc/passwd" }).success,
    false,
  );
  assert.equal(tabsInputSchema.safeParse({ action: "switch" }).success, false);
  assert.equal(tabsInputSchema.safeParse({ action: "switch", index: -1 }).success, false);
  assert.equal(tabsInputSchema.safeParse({ action: "switch", index: MAX_TABS }).success, false);
  assert.equal(tabsInputSchema.safeParse({ action: "list", index: 0 }).success, false);
  assert.equal(tabsInputSchema.safeParse({ action: "wipe", index: 0 }).success, false);
});

test("the wire schema admits wait and click-by-ref without loosening anything else", () => {
  assert.deepEqual(browserWireInputSchema.parse({ type: "wait", until: "idle" }), {
    type: "wait",
    until: "idle",
  });
  assert.deepEqual(browserWireInputSchema.parse({ type: "wait", until: "element", ref: "e3" }), {
    type: "wait",
    until: "element",
    ref: "e3",
  });
  assert.deepEqual(browserWireInputSchema.parse({ type: "wait", until: "delay", ms: 10 }), {
    type: "wait",
    until: "delay",
    ms: 10,
  });
  assert.deepEqual(browserWireInputSchema.parse({ type: "click", ref: "e1" }), {
    type: "click",
    ref: "e1",
  });
  assert.deepEqual(browserWireInputSchema.parse({ type: "click", x: 5, y: 6 }), {
    type: "click",
    x: 5,
    y: 6,
  });
  // The strict wait branch must not become a way to carry a second action.
  assert.equal(
    browserWireInputSchema.safeParse({ type: "wait", until: "idle", ref: "e1", selector: "div" })
      .success,
    false,
  );
  assert.equal(browserWireInputSchema.safeParse({ type: "wait", until: "element" }).success, false);
  assert.equal(
    browserWireInputSchema.safeParse({ type: "upload", ref: "e1", file: "../x.pdf" }).success,
    false,
  );
  assert.equal(
    browserWireInputSchema.safeParse({ type: "click", ref: "e1", x: 5, y: 6 }).success,
    false,
  );
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
