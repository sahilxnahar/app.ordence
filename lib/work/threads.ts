/**
 * Ordence — ⭐⭐ CONVERSATIONS, AND WHAT IS UNREAD
 * Version: v1.10.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CHEAPEST LOYALTY FEATURE ON THE WHOLE PLAN
 * ══════════════════════════════════════════════════════════════════════
 * Ledgers do not create habit. Conversations do. A firm that talks to
 * itself inside the product opens the product every day, and a product
 * opened every day is a product whose data stays true.
 *
 * 🔴 AND THE CONVERSATION BELONGS ON THE RECORD IT IS ABOUT. A
 * discussion about an invoice that lives in somebody's email is a
 * discussion the next person to pick up the file cannot find, which is
 * how the same question gets asked three times and answered differently
 * twice.
 */

export class ThreadError extends Error {}

/* ------------------------------------------------------------------ */
/* MENTIONS                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Pull `@name` handles out of a message body.
 *
 * ⚠️ Returns the raw handles, not user ids. Resolving a handle to a
 * person needs the directory, which is a database question, and this
 * file does not ask database questions.
 */
export function extractHandles(body: string): string[] {
  const out = new Set<string>();
  /** ⚠️ Requires a boundary before the @, so an email address is not a mention. */
  const re = /(^|[\s(])@([a-z0-9][a-z0-9._-]{1,39})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const handle = m[2];
    if (handle !== undefined) out.add(handle.toLowerCase());
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* UNREAD                                                              */
/* ------------------------------------------------------------------ */

export type ThreadRow = {
  id: string;
  title: string | null;
  subjectLabel: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  isClosed: boolean;
  /** For the reader. Null means they have never opened it. */
  lastReadAt: string | null;
  isMuted: boolean;
  /** Whether the reader was named in anything since they last looked. */
  mentionedSinceRead: boolean;
};

export type ThreadState = ThreadRow & {
  /** 🔴 True where there is something the reader has not seen. */
  unread: boolean;
  /** ⭐ Louder than unread: they were named in it. */
  needsAttention: boolean;
  tone: "quiet" | "unread" | "attention";
};

/**
 * ⭐⭐ WHAT IS UNREAD, COMPUTED AND NEVER STORED.
 *
 * 🔴 A STORED UNREAD COUNT IS A COUNT THAT GOES WRONG. Two devices, one
 *    missed decrement, and a person carries a permanent red "1" they can
 *    never clear. Comparing the last message against the last read is
 *    two timestamps and cannot drift.
 *
 * ⚠️ A THREAD NOBODY HAS EVER OPENED IS UNREAD, not neutral. `null` last
 * read with any message in it means they have not seen it.
 *
 * ⭐ AND A MUTED THREAD IS STILL UNREAD IF YOU WERE NAMED IN IT. Muting
 * is "stop shouting about this", not "hide it from me even when it is
 * addressed to me", and treating the two the same is how people miss the
 * one message that mattered.
 */
export function threadState(row: ThreadRow): ThreadState {
  const hasMessages = row.messageCount > 0 && row.lastMessageAt !== null;

  const unseen =
    hasMessages &&
    (row.lastReadAt === null ||
      (row.lastMessageAt !== null && row.lastMessageAt > row.lastReadAt));

  const needsAttention = unseen && row.mentionedSinceRead;

  /** ⚠️ Muting suppresses plain unread, never a mention. */
  const unread = needsAttention ? true : unseen && !row.isMuted;

  return {
    ...row,
    unread,
    needsAttention,
    tone: needsAttention ? "attention" : unread ? "unread" : "quiet",
  };
}

export type InboxSummary = {
  total: number;
  unread: number;
  /** 🔴 Threads where the reader was named and has not looked. */
  needsAttention: number;
  /** ⚠️ Open conversations nobody has said anything in for a long time. */
  stale: number;
};

/**
 * ⭐ THE INBOX, IN FOUR NUMBERS.
 *
 * ⚠️ `stale` is the one nobody builds and everybody needs: an open
 * thread on an invoice that nobody has touched in three weeks is a
 * question that was never answered, and it looks exactly like a
 * finished conversation.
 */
export function summariseInbox(args: {
  rows: readonly ThreadRow[];
  /** ISO timestamp. Supplied, never read from a clock. */
  now: string;
  staleAfterDays?: number;
}): InboxSummary {
  const staleDays = args.staleAfterDays ?? 14;
  if (!Number.isInteger(staleDays) || staleDays <= 0) {
    throw new ThreadError("A staleness window must be a whole number of days above zero.");
  }
  const nowMs = Date.parse(args.now);
  if (Number.isNaN(nowMs)) throw new ThreadError("That is not a valid timestamp.");
  const cutoff = nowMs - staleDays * 86_400_000;

  let unread = 0;
  let attention = 0;
  let stale = 0;

  for (const r of args.rows) {
    const s = threadState(r);
    if (s.unread) unread += 1;
    if (s.needsAttention) attention += 1;
    if (!r.isClosed && r.lastMessageAt !== null) {
      const at = Date.parse(r.lastMessageAt);
      if (!Number.isNaN(at) && at < cutoff) stale += 1;
    }
  }

  return { total: args.rows.length, unread, needsAttention: attention, stale };
}

/**
 * ⭐ ORDER FOR AN INBOX.
 *
 * 🔴 Attention first, then unread, then by recency. Not by recency
 * alone: the message that named you three days ago matters more than
 * the one nobody needs you for that arrived at lunchtime.
 */
export function compareThreads(a: ThreadState, b: ThreadState): number {
  const rank = (t: ThreadState) => (t.needsAttention ? 0 : t.unread ? 1 : 2);
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  const at = a.lastMessageAt ?? "";
  const bt = b.lastMessageAt ?? "";
  if (at !== bt) return at > bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
