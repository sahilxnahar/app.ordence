/**
 * Ordence — Peek at a stream without swallowing it
 * Version: v0.67.0-alpha
 * Runtime: Edge-safe (Web Streams only).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS ITS OWN FILE
 * ══════════════════════════════════════════════════════════════════════
 * `/api/upload/put` must inspect the first bytes of an upload and then
 * still write the WHOLE upload to storage. The obvious implementations
 * are both wrong:
 *
 *   await request.arrayBuffer()   — buffers 50 MB in a Worker with a
 *                                   128 MB ceiling. Fine in testing,
 *                                   an outage under concurrency.
 *
 *   reader.read() then pipe       — the bytes already read are GONE.
 *                                   The stored file is missing its own
 *                                   header, silently, and the corruption
 *                                   is only visible when somebody opens
 *                                   the document months later.
 *
 * So the read chunks have to be put back. That is fiddly enough, and
 * consequential enough, to be worth isolating and testing on its own
 * rather than inlining into a route handler.
 */

import { MAGIC_BYTES_WINDOW, sniffUpload, type SniffVerdict } from "@/lib/validators/magic-bytes";

export type PeekResult = {
  verdict: SniffVerdict;
  /**
   * The full body, byte-for-byte, including everything consumed to reach
   * a verdict. Safe to pipe straight to storage.
   */
  stream: ReadableStream<Uint8Array>;
};

/**
 * Read just enough of `body` to inspect it, then return it intact.
 *
 * ⚠️ THE RETURNED STREAM IS NOT THE ONE PASSED IN. The original has been
 * partially consumed and must not be used again — writing it would store
 * a file with its header missing.
 */
export async function peekAndSniff(
  body: ReadableStream<Uint8Array>,
  declaredType: string,
): Promise<PeekResult> {
  const reader = body.getReader();

  const consumed: Uint8Array[] = [];
  let collected = 0;
  let exhausted = false;

  // Read whole chunks until there are enough bytes to decide. Chunks are
  // kept as they arrived rather than concatenated, so replaying them costs
  // no copy of the payload.
  while (collected < MAGIC_BYTES_WINDOW) {
    const { done, value } = await reader.read();
    if (done) {
      exhausted = true;
      break;
    }
    if (value && value.length > 0) {
      consumed.push(value);
      collected += value.length;
    }
  }

  const head = new Uint8Array(Math.min(collected, MAGIC_BYTES_WINDOW));
  let offset = 0;
  for (const chunk of consumed) {
    if (offset >= head.length) break;
    const take = Math.min(chunk.length, head.length - offset);
    head.set(chunk.subarray(0, take), offset);
    offset += take;
  }

  const verdict = sniffUpload(declaredType, head);

  /*
   * ⚠️ THE REPLAY STREAM EMITS THE CONSUMED CHUNKS FIRST, IN ORDER, AND
   * ONLY THEN CONTINUES FROM THE READER. Getting this backwards, or
   * dropping a chunk, produces a stored file that is subtly wrong rather
   * than obviously broken — which is far worse, because nothing fails
   * until a customer opens the document.
   *
   * `cancel` propagates to the underlying reader so an aborted upload does
   * not leave a dangling lock on the request body.
   */
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of consumed) controller.enqueue(chunk);
      if (exhausted) controller.close();
    },
    async pull(controller) {
      if (exhausted) return;
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return { verdict, stream };
}
