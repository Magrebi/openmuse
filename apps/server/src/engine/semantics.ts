/**
 * Local semantic matching for proactive suggestions.
 *
 * The previous scanner was regexes: `/form|permission|complete/`. That can only
 * ever match a literal the author thought of in advance, it cannot notice that
 * an email about a delayed flight and a dinner reservation two hours later are
 * about the same evening, and it matches the word "form" in "information" just
 * as happily as in "permission form".
 *
 * This replaces it with three things that compose:
 *
 * - A **hashed bag-of-words embedding** (feature hashing into a fixed-width
 *   vector). No model, no download, no network — which matters because
 *   OpenMuse is a self-hosted, private system and a suggestion engine must not
 *   become a reason to send someone's mail to a third party.
 * - **Cosine similarity**, so "near" means "about the same subject" rather than
 *   "shares a keyword".
 * - **Entity overlap** between mail and calendar, which is what actually
 *   produces the useful suggestions: a reschedule that conflicts with something
 *   already booked, a document someone is waiting on before a deadline.
 *
 * Pure, so all of it is testable without a database, a model or a clock.
 */

/** Width of the hashed embedding. */
export const EMBEDDING_WIDTH = 256;

/** Words that carry no signal about what a message is about. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "about",
  "after",
  "all",
  "also",
  "any",
  "because",
  "just",
  "more",
  "most",
  "other",
  "own",
  "same",
  "some",
  "such",
  "only",
]);

/**
 * URL and email schemes that appear as bare words.
 *
 * A scheme is not a word about anything; it is punctuation spelled with
 * letters. Left in, every message containing a link shares a token with every
 * other message containing a link, which drags their similarity towards each
 * other and quietly raises the score of unrelated pairs above the floor.
 */
const SCHEMES = new Set(["https", "http", "ftp", "ftps", "mailto", "tel", "www", "com", "org"]);

/**
 * Split text into words.
 *
 * Deliberately splits on anything that is not a letter or digit, so an address,
 * a URL and a timestamp all decompose into their words without needing their own
 * patterns. Words shorter than three characters carry too little signal to
 * survive the hash without colliding constantly, and URL schemes are dropped
 * for the reason above.
 */
export const tokenize = (text: string): string[] => {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !SCHEMES.has(word))
    .slice(0, 2000);
};

/**
 * A stable 32-bit hash.
 *
 * FNV-1a: chosen because it is short, has no allocation, and — the property
 * that actually matters here — gives the same answer for the same word on every
 * process and every run. A hash seeded per-process would make the embedding
 * different on every restart, so the same suggestion would score differently
 * each time the server came back up.
 */
const fnv1a = (value: string, seed = 0x811c9dc5): number => {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // FNV prime: multiply by 16777619 with 32-bit overflow, done in parts so the
    // intermediate product stays exact rather than losing the top bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/** An embedding: a fixed-width unit vector, sparse in practice. */
export type Embedding = Float64Array;

/**
 * Embed text by hashing each word into one of `width` buckets.
 *
 * Two refinements make this behave like an embedding rather than like a
 * checksum. Words are **prefixed by length** before hashing, so "form" and
 * "forms" land in different buckets instead of colliding into one. And each
 * weight is `1 + log(count)`, so a word repeated thirty times does not
 * out-vote twenty distinct words — the thing that made naive counting rank any
 * long email above any short precise one.
 */
export const embed = (text: string, width = EMBEDDING_WIDTH): Embedding => {
  const vector = new Float64Array(width);
  const counts = new Map<string, number>();
  for (const word of tokenize(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const [word, count] of counts) {
    const bucket = fnv1a(`${word.length}:${word}`) % width;
    vector[bucket] += 1 + Math.log(count);
  }
  return normalize(vector);
};

/** Scale a vector to unit length. A zero vector is returned unchanged. */
export const normalize = (vector: Float64Array): Float64Array => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length > 0) for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
};

/**
 * Cosine similarity, in [-1, 1].
 *
 * Both inputs are unit vectors from `embed`, so this is a plain dot product —
 * but the magnitudes are divided out anyway so a hand-built vector cannot
 * produce a score above 1, which would silently distort every threshold above
 * it.
 */
/** The smallest message that could carry a suggestion. */
const MINIMUM_SUBJECT_CHARS = 3;

/** Words that mean something has been changed or held up. */
const DISRUPTION = [
  "delay",
  "delayed",
  "postponed",
  "cancelled",
  "canceled",
  "rescheduled",
  "changed",
  "moved",
  "disrupted",
  "held",
  "extended",
  "revised",
  "late",
  "earlier",
];

/** Words that mean something is expected and someone is waiting. */
const AWAITING = [
  "due",
  "deadline",
  "signature",
  "signed",
  "sign",
  "complete",
  "completed",
  "return",
  "form",
  "permission",
  "remit",
  "payment",
  "submit",
  "required",
  "before",
  "expires",
];

/** Words that mean an invitation to arrange something. */
const SCHEDULING = [
  "coffee",
  "lunch",
  "dinner",
  "drinks",
  "meet",
  "meeting",
  "available",
  "schedule",
  "reschedule",
  "move",
  "catch",
  "call",
  "chat",
  "book",
  "booking",
  "reservation",
  "table",
];

const hasAny = (text: string, words: readonly string[]): boolean => {
  const present = new Set(tokenize(text));
  return words.some((word) => present.has(word));
};

/**
 * Does a message describe something that has gone wrong with a plan?
 *
 * This is the only keyword rule left, and it is here rather than in a regex over
 * the whole body because it is a *category*, not a pattern: "is this about a
 * disruption" is a question about intent that words answer better than a general
 * similarity does. The surrounding scanning is semantic; recognising the
 * category of a disruption is a lookup.
 */
export const isDisruption = (text: string): boolean => hasAny(text, DISRUPTION);

/** Does a message describe something someone is expected to return? */
export const isAwaitingReply = (text: string): boolean => hasAny(text, AWAITING);

/** Does a message propose arranging time with someone? */
export const isScheduling = (text: string): boolean => hasAny(text, SCHEDULING);

/** The local parts of everyone named in a set of addresses. */
export const peopleIn = (values: readonly string[]): Set<string> => {
  const people = new Set<string>();
  for (const value of values) {
    const address = typeof value === "string" ? value.trim().toLowerCase() : "";
    const at = address.lastIndexOf("@");
    // Only the local part is compared: two addresses at different providers are
    // the same person far more often than not, and a provider change should not
    // make a conflict disappear.
    if (at > 0 && address.slice(at).length > 3) people.add(address.slice(0, at));
  }
  return people;
};

/** True when two records involve anyone in common. */
export const sharesPeople = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const person of a) if (b.has(person)) return true;
  return false;
};

/**
 * A candidate pairing of a message with a calendar event.
 *
 * Both a similarity and a reason are carried, because the reason is what the
 * person actually reads. A suggestion that cannot say *why* it was made is just
 * an interruption.
 */
export interface IdeaCandidate {
  /** Stable identity of this pairing, so the same idea is not offered twice. */
  readonly key: string;
  readonly title: string;
  readonly reason: string;
  readonly prompt: string;
  /** Cosine similarity between the message and the event. */
  readonly similarity: number;
  /** True when a shared person plus a shared date makes this more than a guess. */
  readonly grounded: boolean;
}

/** The minimum similarity before two records are considered the same subject. */
export const SIMILARITY_FLOOR = 0.18;

/** How far ahead an event may be and still be affected by something today. */
const LOOKAHEAD_MS = 36 * 60 * 60 * 1000;

export const cosine = (a: Float64Array, b: Float64Array): number => {
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  const width = Math.min(a.length, b.length);
  for (let i = 0; i < width; i++) {
    dot += a[i] * b[i];
    lengthA += a[i] * a[i];
    lengthB += b[i] * b[i];
  }
  if (lengthA === 0 || lengthB === 0) return 0;
  const value = dot / (Math.sqrt(lengthA) * Math.sqrt(lengthB));
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
};

/**
 * Find message/event pairings worth suggesting.
 *
 * Three kinds are produced, in descending order of how far they can be trusted:
 *
 * 1. A **disruption** about a plan that appears on the calendar soon. This is
 *    the case the old scanner could not reach at all: a flight delay that
 *    quietly invalidates a dinner reservation. A shared person is enough to
 *    propose it; without one the subjects have to actually match.
 * 2. A **conflict**: a message asking to arrange something, from someone who is
 *    on an event soon. Two things competing for the same person is a conflict
 *    on its own, with no semantic link needed.
 * 3. A **weak topical link**, the lowest confidence, and framed as such.
 */
export const correlate = (
  messages: readonly {
    id: string;
    subject: string;
    body: string;
    date: string;
    from?: string;
    sender?: string;
    to?: string[];
    label?: string;
  }[],
  events: readonly {
    id: string;
    title: string;
    start: string;
    end: string;
    description?: string;
    attendees?: string[];
  }[],
  now: number,
): IdeaCandidate[] => {
  const candidates = new Map<string, IdeaCandidate>();
  const put = (candidate: IdeaCandidate) => {
    const existing = candidates.get(candidate.key);
    // The strongest candidate for a key wins, so re-running the scan cannot
    // downgrade an idea that has already been offered.
    if (!existing || candidate.similarity > existing.similarity)
      candidates.set(candidate.key, candidate);
  };

  const eventEmbeddings = new Map(
    events.map((event) => [event.id, embed(`${event.title} ${event.description ?? ""}`)]),
  );

  for (const message of messages) {
    // Sent mail is the person's own output; nothing in it needs suggesting back.
    if (message.label && /^sent\b/i.test(message.label)) continue;
    if (!message.subject || message.subject.trim().length < MINIMUM_SUBJECT_CHARS) continue;
    const messageText = `${message.subject} ${message.body}`;
    const messageVector = embed(messageText);
    const messagePeople = peopleIn([
      message.from ?? "",
      message.sender ?? "",
      ...(message.to ?? []),
    ]);
    const disrupted = isDisruption(messageText);
    const scheduling = isScheduling(messageText);

    for (const event of events) {
      const start = Date.parse(event.start);
      // Only the near future is actionable: a dinner three weeks out cannot be
      // moved by a message that arrived this morning.
      if (!Number.isFinite(start) || start < now || start > now + LOOKAHEAD_MS) continue;
      const similarity = cosine(messageVector, eventEmbeddings.get(event.id) as Float64Array);
      const knownPeople = sharesPeople(messagePeople, peopleIn(event.attendees ?? []));
      const hoursAway = Math.round((start - now) / 3_600_000);
      if (!knownPeople && similarity < SIMILARITY_FLOOR) continue;

      if (disrupted) {
        put({
          key: `disruption:${message.id}:${event.id}`,
          title: `Something may have moved ${event.title}`,
          reason:
            `${message.sender ?? "Someone"} wrote about a change` +
            (knownPeople
              ? `, and ${event.title} is on your calendar with them`
              : ` about ${event.title}`) +
            `, in ${hoursAway} hours. I can check whether the plan still works.`,
          prompt:
            `The email “${message.subject}” mentions a change. Check whether my ` +
            `“${event.title}” on ${event.start} still works, and propose what to do. ` +
            `Ask me before contacting anyone.`,
          similarity: Math.max(similarity, 0.5),
          grounded: knownPeople,
        });
        continue;
      }

      if (scheduling) {
        put({
          key: `conflict:${message.id}:${event.id}`,
          title: `Your ${event.title} may need moving`,
          reason:
            `${message.sender ?? "Someone"} asked to arrange something with you` +
            (similarity >= SIMILARITY_FLOOR ? ` about ${event.title}` : "") +
            `. I can look at what else is booked.`,
          prompt:
            `The email “${message.subject}” asks to arrange something. Compare it ` +
            `with my “${event.title}” on ${event.start} and suggest a time that works.`,
          similarity: Math.max(similarity, 0.3),
          grounded: knownPeople,
        });
        continue;
      }

      put({
        key: `related:${message.id}:${event.id}`,
        title: `Related to ${event.title}`,
        reason:
          `“${message.subject}” looks related to ${event.title} on ${event.start}. ` +
          `I can read it against that and tell you if anything needs changing.`,
        prompt:
          `Read the email “${message.subject}” and check it against my ` +
          `“${event.title}” on ${event.start}. Tell me what needs my attention.`,
        similarity,
        grounded: knownPeople,
      });
    }

    // A message that is simply waiting on the person, with nothing to correlate.
    // The old scanner only looked for a regex, and only in the body; this reads
    // the subject as well, which is where most real requests actually live.
    if (isAwaitingReply(messageText) && events.length === 0) {
      put({
        key: `awaiting:${message.id}`,
        title: `A reply to ${message.sender ?? "someone"} is waiting`,
        reason: `“${message.subject}” looks like it needs something back from you. I can draft one for your review.`,
        prompt: `Read the email “${message.subject}” and prepare a reply for my review. Do not send it.`,
        similarity: 0.2,
        grounded: false,
      });
    }
  }

  return [...candidates.values()].sort(
    (a, b) =>
      // Grounded pairings first, then by strength. A tie is broken by the key so
      // the order is stable between runs and a person sees the same list twice.
      Number(b.grounded) - Number(a.grounded) ||
      b.similarity - a.similarity ||
      a.key.localeCompare(b.key),
  );
};
