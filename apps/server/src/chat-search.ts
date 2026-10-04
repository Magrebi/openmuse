/**
 * Full-text search across the owner's side chats.
 *
 * Thread *metadata* (name, archived, timestamps) comes from the platform's thread
 * list, but a thread's transcript does not: it has to be fetched per thread. So
 * search walks the owner's own threads, reads each transcript, and matches
 * locally.
 *
 * Two properties this module is responsible for:
 *
 * - **No cross-chat leakage.** Every thread listed is scoped to the owner, and a
 *   hit carries only the matching thread's id and excerpt — never another chat's
 *   content.
 * - **Bounded work.** A transcript fetch per thread would be unbounded on a large
 *   account, so the walk is capped and one failing thread never fails the search.
 */
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { backgroundFailure } from "./log.ts";

/** One matching message, with enough context to recognise it. */
export interface SearchHit {
  threadId: string;
  /** The chat's name, or null when it has never been renamed. */
  threadName: string | null;
  /** The matching message, trimmed for display. Untrusted text: render as data. */
  excerpt: string;
  /** Who said it. */
  role: string;
  /** ISO timestamp of the thread's last run, used to order results. */
  at?: string;
}

/** How many threads one search will read transcripts from. */
export const SEARCH_THREAD_LIMIT = 50;
/** Longest excerpt returned per hit, so one message cannot flood the list. */
const EXCERPT_LIMIT = 200;

/**
 * Pull displayable text out of an AG-UI message's structured content.
 *
 * Content is `unknown` because the platform owns the shape, so every field is
 * probed defensively and anything unrecognised contributes nothing.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  const text: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; content?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    text.push(record.text);
  }
  return text.join("\n");
}

/** The window of text around the first match, for display under a hit. */
export function excerptAround(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text.slice(0, EXCERPT_LIMIT);
  const start = Math.max(0, at - Math.floor(EXCERPT_LIMIT / 3));
  const slice = text
    .slice(start, start + EXCERPT_LIMIT)
    .replace(/\s+/g, " ")
    .trim();
  return start > 0 ? `…${slice}` : slice;
}

/**
 * Search every one of the owner's chats, newest first.
 *
 * Archived chats are included deliberately: a chat the owner archived is still
 * theirs, and "find that thing I said last month" has to reach it.
 */
export async function searchConversations(
  intelligence: CopilotKitIntelligence,
  owner: string,
  rawQuery: string,
): Promise<SearchHit[]> {
  const query = rawQuery.trim();
  // Below two characters almost everything matches, so the result would be the
  // whole account rather than a search.
  if (query.length < 2) return [];
  const { threads } = await intelligence.listThreads({
    userId: owner,
    agentId: "default",
    includeArchived: true,
    limit: SEARCH_THREAD_LIMIT,
  });
  const hits: SearchHit[] = [];
  for (const thread of threads) {
    // A name match is a hit on its own, even for a chat with no readable text.
    const named = thread.name?.toLowerCase().includes(query.toLowerCase());
    let messages: Awaited<ReturnType<CopilotKitIntelligence["getThreadMessages"]>>["messages"] = [];
    try {
      messages = (await intelligence.getThreadMessages({ threadId: thread.id, userId: owner }))
        .messages;
    } catch (error) {
      // One unreadable transcript must not fail the whole search.
      backgroundFailure("side chat search", error);
      if (!named) continue;
    }
    for (const message of messages) {
      const text = messageText(message.content);
      if (!text || !text.toLowerCase().includes(query.toLowerCase())) continue;
      hits.push({
        threadId: thread.id,
        threadName: thread.name ?? null,
        excerpt: excerptAround(text, query),
        role: message.role,
        at: thread.lastRunAt ?? thread.updatedAt,
      });
      break; // One hit per chat: this is a chat finder, not a message grepper.
    }
    if (named && !hits.some((hit) => hit.threadId === thread.id))
      hits.push({
        threadId: thread.id,
        threadName: thread.name ?? null,
        excerpt: `Chat named “${thread.name}”`,
        role: "name",
        at: thread.lastRunAt ?? thread.updatedAt,
      });
  }
  // Newest chat first; the platform's own order is not guaranteed to survive the
  // per-thread fetches above.
  return hits.sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
}
