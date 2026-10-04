import assert from "node:assert/strict";
import { test } from "node:test";
import {
  correlate,
  cosine,
  embed,
  isAwaitingReply,
  isDisruption,
  isScheduling,
  peopleIn,
  SIMILARITY_FLOOR,
  sharesPeople,
  tokenize,
} from "../apps/server/src/engine/semantics.ts";

const NOW = Date.parse("2026-03-08T09:00:00.000Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function mail(over: Record<string, unknown> = {}) {
  return { id: "m1", subject: "A subject", body: "", date: inHours(-2), ...over };
}
function event(over: Record<string, unknown> = {}) {
  return { id: "e1", title: "An event", start: inHours(4), end: inHours(5), ...over };
}

test("words are lowercased, stripped of punctuation, and stop words removed", () => {
  assert.deepEqual(tokenize("The flight to Lisbon was DELAYED, unfortunately!").sort(), [
    "delayed",
    "flight",
    "lisbon",
    "unfortunately",
  ]);
});

test("a URL and a timestamp decompose into words without their own patterns", () => {
  const words = tokenize("See https://example.com/flights?ref=abc on 2026-03-08T09:00:00Z");
  assert.ok(words.includes("example"), JSON.stringify(words));
  assert.ok(words.includes("flights"), JSON.stringify(words));
  // The scheme is not a word about anything; it is punctuation that happens to
  // be spelled with letters. Left in, every message containing a link shares a
  // token with every other message containing a link.
  assert.ok(!words.includes("https"), `the scheme leaked into a token: ${JSON.stringify(words)}`);
});

test("a delay that affects a booking with the same person is surfaced", () => {
  // This is the case the regex scanner could not reach: nothing in either
  // record says "conflict", and the two texts share almost no words. The link
  // that makes it actionable is that Maya is on both.
  const ideas = correlate(
    [
      mail({
        subject: "Flight update",
        body: "Your flight to Lisbon is delayed until late evening.",
        from: "airline@example.com",
        to: ["maya@example.com"],
      }),
    ],
    [event({ title: "Dinner with Maya", attendees: ["maya@example.com"], start: inHours(6) })],
    NOW,
  );
  assert.equal(ideas.length, 1);
  assert.ok(ideas[0].key.startsWith("disruption:"));
  assert.ok(ideas[0].grounded, "a shared person must ground the suggestion");
  assert.match(ideas[0].reason, /Dinner with Maya/);
  assert.match(ideas[0].title, /moved/);
});

test("the suggestion says why it was made, and grounds the prompt in both records", () => {
  const ideas = correlate(
    [
      mail({
        subject: "Flight update",
        body: "delayed",
        from: "airline@example.com",
        to: ["maya@example.com"],
      }),
    ],
    [event({ title: "Dinner with Maya", attendees: ["maya@example.com"] })],
    NOW,
  );
  assert.match(ideas[0].reason, /hours/, "the reason must say how soon");
  assert.match(ideas[0].prompt, /Dinner with Maya/);
  assert.match(ideas[0].prompt, /Ask me before contacting anyone/);
});

test("stop words cannot dominate a long message", () => {
  // Without this, "the" repeated 200 times outweighs every content word and
  // every message ends up equally similar to every other.
  const content = embed("flight delayed Lisbon airline gate departure cancelled rebooked");
  const target = embed("flight delayed Lisbon");
  const stopHeavy = embed("the and for with that this it is was ".repeat(60));
  assert.ok(cosine(content, target) > cosine(stopHeavy, target));
});

test("a repeated word does not out-vote several distinct ones", () => {
  // Naive counting makes any long message outrank a precise short one.
  const short = embed("flight delayed");
  const long = embed("flight flight flight flight flight flight");
  assert.ok(cosine(long, short) < 0.99, "one word repeated is not the same as agreeing");
});

test("an identical text is maximally similar and a different one is not", () => {
  const a = embed("your flight to Lisbon has been delayed by three hours");
  assert.ok(cosine(a, embed("your flight to Lisbon has been delayed by three hours")) > 0.999);
  assert.ok(
    cosine(a, embed("the quarterly garden fence needs repainting before autumn")) <
      SIMILARITY_FLOOR,
  );
});

test("similarity is symmetric and always in range", () => {
  const a = embed("flight delayed to Lisbon");
  const b = embed("dinner reservation at the restaurant tonight");
  assert.ok(Math.abs(cosine(a, b) - cosine(b, a)) < 1e-12, "cosine must be symmetric");
  for (const [x, y] of [
    [a, a],
    [a, b],
    [a, new Float64Array(256)],
  ]) {
    const value = cosine(x, y);
    assert.ok(value >= -1 && value <= 1, `${value} out of range`);
  }
});

test("an empty message produces no score rather than a division by zero", () => {
  assert.ok(Number.isFinite(cosine(embed(""), embed("something"))));
  assert.equal(cosine(embed(""), embed("")), 0, "no words means no opinion, not agreement");
});

test("a keyword is matched as a word, not as a fragment", () => {
  // The old regex matched "form" inside "information", which is how a mail
  // newsletter ended up producing a "complete the form" suggestion.
  assert.equal(isAwaitingReply("Here is some general information about our services"), false);
  assert.equal(isAwaitingReply("Please complete the permission form and return it"), true);
  assert.equal(isAwaitingReply("platform"), false);
  assert.equal(isAwaitingReply("reformat the table"), false);
});

test("disruption and scheduling are recognised as categories", () => {
  assert.equal(isDisruption("Your flight has been delayed by three hours"), true);
  assert.equal(isDisruption("The meeting was moved to Thursday"), true);
  assert.equal(isDisruption("Here is the agenda for Monday"), false);
  assert.equal(isScheduling("Are you free for coffee on Thursday?"), true);
  assert.equal(isScheduling("Attaching the quarterly report"), false);
});

test("people are compared by local part, so a provider change is not a new person", () => {
  assert.ok(sharesPeople(peopleIn(["maya@example.com"]), peopleIn(["maya@work.example"])));
  assert.equal(sharesPeople(peopleIn(["maya@example.com"]), peopleIn(["sam@example.com"])), false);
});

test("an address with no real domain is not treated as a person", () => {
  // Otherwise every record mentioning "a@b" appears to involve everyone.
  const people = peopleIn(["nobody@", "", "not-an-address", "x@.c"]);
  assert.equal(people.size, 0, JSON.stringify([...people]));
});

test("a scheduling request from someone you are meeting is a conflict", () => {
  const ideas = correlate(
    [
      mail({
        subject: "Coffee next week?",
        body: "Are you free for coffee on Thursday afternoon?",
        from: "jamie@example.com",
      }),
    ],
    [event({ title: "Lunch with Maya", attendees: ["jamie@example.com"] })],
    NOW,
  );
  assert.ok(ideas.some((idea) => idea.key.startsWith("conflict:")));
});

test("an event far in the future is never suggested", () => {
  // A dinner three weeks out cannot be moved by a message from this morning.
  const ideas = correlate(
    [mail({ subject: "Flight update", body: "delayed", to: ["maya@example.com"] })],
    [
      event({
        start: inHours(24 * 20),
        end: inHours(24 * 20 + 1),
        attendees: ["maya@example.com"],
      }),
    ],
    NOW,
  );
  assert.deepEqual(ideas, []);
});

test("an event already in the past is never suggested", () => {
  const ideas = correlate(
    [mail({ subject: "Flight update", body: "delayed", to: ["maya@example.com"] })],
    [event({ start: inHours(-5), end: inHours(-4), attendees: ["maya@example.com"] })],
    NOW,
  );
  assert.deepEqual(ideas, []);
});

test("sent mail never produces a suggestion", () => {
  const ideas = correlate(
    [
      mail({
        subject: "Re: lunch",
        body: "Sounds good, see you then.",
        label: "Sent",
        from: "maya@example.com",
      }),
    ],
    [event({ title: "Lunch with Maya", attendees: ["maya@example.com"] })],
    NOW,
  );
  assert.deepEqual(ideas, [], "the person's own replies need no suggestion");
});

test("grounded suggestions are offered before ungrounded ones", () => {
  const ideas = correlate(
    [
      // Topically about the same thing, but from someone not on the invite.
      mail({
        id: "far",
        subject: "Dinner reservation moved",
        body: "The dinner reservation may have changed tonight.",
        from: "stranger@example.com",
      }),
      // Same disruption, but from someone who is actually on the invitation.
      mail({
        id: "near",
        subject: "Delay",
        body: "delayed",
        from: "maya@example.com",
      }),
    ],
    [event({ title: "Dinner with Maya", attendees: ["maya@example.com"] })],
    NOW,
  );
  assert.ok(ideas.length >= 2, `expected both, got ${ideas.map((i) => i.key).join(", ")}`);
  assert.equal(ideas[0].grounded, true, "the grounded one must come first");
  assert.ok(
    ideas.some((idea) => !idea.grounded),
    "the ungrounded one must still be offered, just later",
  );
});

test("a pairing with neither a shared person nor a shared subject is dropped", () => {
  // Without this every disruption mail would be offered against every event on
  // the calendar, and the ideas list would become noise.
  const ideas = correlate(
    [mail({ subject: "Flight to Lisbon delayed", body: "delayed", from: "stranger@example.com" })],
    [event({ title: "Dinner with Maya", attendees: ["maya@example.com"] })],
    NOW,
  );
  assert.deepEqual(ideas, []);
});

test("the order is stable between runs, so the list does not shuffle", () => {
  const messages = [
    mail({ id: "b", subject: "Delay b", body: "delayed", from: "maya@example.com" }),
    mail({ id: "a", subject: "Delay a", body: "delayed", from: "sam@example.com" }),
  ];
  const events = [event({ id: "x", attendees: ["maya@example.com"] })];
  const first = correlate(messages, events, NOW).map((i) => i.key);
  const second = correlate([...messages].reverse(), events, NOW).map((i) => i.key);
  assert.deepEqual(first, second, "the same inputs must give the same order");
});

test("two unrelated records with nobody in common produce nothing", () => {
  const ideas = correlate(
    [mail({ subject: "Delay", body: "delayed", from: "stranger@example.com" })],
    [
      event({
        title: "Garden planting",
        start: inHours(3),
        attendees: ["someone-else@example.com"],
      }),
    ],
    NOW,
  );
  assert.deepEqual(ideas, []);
});

test("a message needing a reply is still suggested with an empty calendar", () => {
  const ideas = correlate(
    [mail({ subject: "Permission slip due Friday", body: "Please sign and return." })],
    [],
    NOW,
  );
  assert.equal(ideas.length, 1);
  assert.ok(ideas[0].key.startsWith("awaiting:"));
  assert.match(ideas[0].prompt, /Do not send it/);
});

test("a message with no usable subject produces nothing", () => {
  for (const subject of ["", "   ", "ab"]) {
    const ideas = correlate(
      [mail({ subject, body: "delayed flight", from: "maya@example.com" })],
      [event({ attendees: ["maya@example.com"] })],
      NOW,
    );
    assert.deepEqual(ideas, [], `subject ${JSON.stringify(subject)}`);
  }
});

test("nothing in, nothing out", () => {
  assert.deepEqual(correlate([], [], NOW), []);
  assert.deepEqual(correlate([mail()], [], NOW), []);
});

test("an unparseable event date is skipped rather than crashing the scan", () => {
  const ideas = correlate(
    [mail({ subject: "Delay", body: "delayed", from: "maya@example.com" })],
    [event({ start: "not a date", end: "also not", attendees: ["maya@example.com"] })],
    NOW,
  );
  assert.deepEqual(ideas, []);
});

test("every candidate carries a key, a reason and a prompt, and keys are unique", () => {
  const ideas = correlate(
    [
      mail({ subject: "Flight update", body: "delayed", from: "maya@example.com" }),
      mail({ id: "m2", subject: "Coffee?", body: "free for coffee", from: "sam@example.com" }),
    ],
    [
      event({ attendees: ["maya@example.com"] }),
      event({ id: "e2", attendees: ["sam@example.com"] }),
    ],
    NOW,
  );
  for (const idea of ideas) {
    assert.ok(idea.key.length > 0);
    assert.ok(idea.reason.length > 10, "a suggestion must be able to explain itself");
    assert.ok(idea.prompt.length > 10);
    assert.ok(idea.similarity > 0 && idea.similarity <= 1);
  }
  assert.equal(new Set(ideas.map((i) => i.key)).size, ideas.length, "keys must be unique");
});
