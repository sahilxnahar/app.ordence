/**
 * Ordence — upload content inspection
 * Version: v0.67.0-alpha
 *
 * The attack these defend against is one sentence long: upload an HTML
 * file, declare it `application/pdf`, and every check in the pipeline
 * passes because every check reads a string the attacker wrote.
 *
 * Two properties have to hold together, and a test suite that only
 * asserted one of them would be worse than none — it would look like
 * coverage.
 *
 *   1. Markup and scripts are refused WHATEVER they claim to be.
 *   2. The stream survives inspection byte-for-byte, because a stored
 *      file missing its own header is corruption nobody notices until a
 *      customer opens the document months later.
 */

import { describe, it, expect } from "vitest";
import { sniffUpload, MAGIC_BYTES_WINDOW } from "@/lib/validators/magic-bytes";
import { peekAndSniff } from "@/lib/validators/peek-stream";

const bytes = (text: string) => new TextEncoder().encode(text);

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out.push(...value);
  }
  // Returned as a plain number[] on purpose: the jsdom environment and
  // node:util supply Uint8Array from DIFFERENT realms, so two arrays with
  // identical bytes fail toEqual with "no visual difference" — a false
  // failure that costs an hour to read.
  return out;
}

describe("the attack: markup wearing another content type", () => {
  it("⚠️ refuses an HTML document declared as application/pdf — this is the whole point of the file", () => {
    const verdict = sniffUpload("application/pdf", bytes("<!DOCTYPE html><html><script>fetch('/api')</script>"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("executable-content");
  });

  it("⚠️ refuses SVG declared as image/png — SVG carries script and is deliberately absent from the allowlist", () => {
    expect(sniffUpload("image/png", bytes("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")).ok).toBe(false);
  });

  it("⚠️ refuses markup declared as text/csv — the formats with NO signature are the ones an attacker picks", () => {
    // text/csv has no magic number, so the format check cannot help here.
    // Only the dangerous-openings check stands between this and storage.
    expect(sniffUpload("text/csv", bytes("<html><body onload=alert(1)>")).ok).toBe(false);
  });

  it("is not fooled by leading whitespace or a BOM", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("   \n\t<ScRiPt>alert(1)</ScRiPt>")]);
    expect(sniffUpload("text/plain", bom).ok).toBe(false);
  });

  it("refuses a PHP opening tag and a shebang", () => {
    expect(sniffUpload("text/plain", bytes("<?php system($_GET['c']); ?>")).ok).toBe(false);
    expect(sniffUpload("text/plain", bytes("#!/bin/sh\nrm -rf /")).ok).toBe(false);
  });
});

describe("the format check", () => {
  it("accepts a real PDF", () => {
    expect(sniffUpload("application/pdf", bytes("%PDF-1.7\n%âãÏÓ")).ok).toBe(true);
  });

  it("accepts a real PNG", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(sniffUpload("image/png", png).ok).toBe(true);
  });

  it("accepts docx, xlsx and pptx — all three are ZIP containers", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    for (const type of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
    ]) {
      expect(sniffUpload(type, zip).ok, type).toBe(true);
    }
  });

  it("refuses a PNG that is really a JPEG — same allowlist, wrong bytes", () => {
    // A full window of bytes, because a six-byte body is not a JPEG either
    // and is correctly treated as truncated rather than as an attack.
    const jpeg = new Uint8Array(MAGIC_BYTES_WINDOW);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);

    const verdict = sniffUpload("image/png", jpeg);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("signature-mismatch");
  });

  it("⚠️ a body too short to CARRY the signature it claims is truncated, not forged — refusing it would break empty uploads", () => {
    // Six bytes cannot hold PNG's eight-byte signature. There is nothing
    // to compare against, and asserting "wrong format" would send an
    // operator hunting for an attack that is really a failed transfer.
    const tooShort = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const verdict = sniffUpload("image/png", tooShort);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.reason).toBe("no-signature-known");
  });

  it("allows formats with no dependable signature rather than guessing", () => {
    // A CSV legitimately starts with any byte at all. Refusing on "no
    // signature" would break every genuine CSV upload in the product.
    expect(sniffUpload("text/csv", bytes("sku,qty\nCEM-53,400\n")).ok).toBe(true);
    expect(sniffUpload("text/plain", bytes("Site notes, 14 March.")).ok).toBe(true);
  });

  it("⚠️ treats a truncated body as unknown, not as a mismatch — an empty upload is not an attack", () => {
    expect(sniffUpload("application/pdf", new Uint8Array([0x25])).ok).toBe(true);
    expect(sniffUpload("application/pdf", new Uint8Array(0)).ok).toBe(true);
  });
});

describe("the stream survives inspection", () => {
  it("⚠️ replays every consumed byte in order — a stored file missing its header is silent corruption", async () => {
    const body = bytes("%PDF-1.7\n" + "x".repeat(500));
    const { verdict, stream } = await peekAndSniff(streamOf(body), "application/pdf");

    expect(verdict.ok).toBe(true);
    expect(await drain(stream)).toEqual([...body]);
  });

  it("reassembles a body that arrived in many small chunks", async () => {
    const whole = bytes("%PDF-1.7\n" + "abcdefghij".repeat(40));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < whole.length; i += 7) chunks.push(whole.subarray(i, i + 7));

    // More than one chunk is needed just to fill the inspection window,
    // which is the case most likely to drop bytes.
    expect(chunks[0]!.length).toBeLessThan(MAGIC_BYTES_WINDOW);

    const { stream } = await peekAndSniff(streamOf(...chunks), "application/pdf");
    expect(await drain(stream)).toEqual([...whole]);
  });

  it("handles a body shorter than the inspection window without truncating or hanging", async () => {
    const tiny = bytes("%PDF-1.4");
    const { verdict, stream } = await peekAndSniff(streamOf(tiny), "application/pdf");
    expect(verdict.ok).toBe(true);
    expect(await drain(stream)).toEqual([...tiny]);
  });

  it("handles a completely empty body", async () => {
    const { stream } = await peekAndSniff(streamOf(), "text/plain");
    expect((await drain(stream)).length).toBe(0);
  });

  it("reaches a refusing verdict without having read the whole body", async () => {
    // A 5 MB HTML file must be refused from its opening bytes, not after
    // the Worker has pulled all of it into memory.
    const head = bytes("<!DOCTYPE html>");
    const tail = new Uint8Array(5 * 1024 * 1024);
    const { verdict } = await peekAndSniff(streamOf(head, tail), "application/pdf");
    expect(verdict.ok).toBe(false);
  });
});

describe("the route actually calls it", () => {
  it("⚠️ pipes the REPLAY stream to storage, never the original — the original is partially consumed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "..", "app/api/upload/put/route.ts"), "utf8");

    expect(source).toMatch(/peekAndSniff\(\s*request\.body/);
    // Writing `request.body` after peeking would store a headerless file.
    expect(source).toMatch(/putStoredObject\(\s*ticket\.p,\s*stream,/);
    expect(source).not.toMatch(/putStoredObject\(\s*ticket\.p,\s*request\.body/);
  });

  it("refuses BEFORE the write, so a bad file never exists at a path already returned", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "..", "..", "app/api/upload/put/route.ts"), "utf8");

    expect(source.indexOf("if (!verdict.ok)")).toBeLessThan(source.indexOf("await putStoredObject"));
  });
});
