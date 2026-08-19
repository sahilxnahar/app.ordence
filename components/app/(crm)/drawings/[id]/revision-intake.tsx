"use client";

/**
 * Ordence — ⭐⭐⭐ ISSUING A REVISION
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SAME THREE-STEP UPLOAD EVERY OTHER FILE IN THE PRODUCT TAKES
 * ══════════════════════════════════════════════════════════════════════
 *   1. POST /api/upload      authorise this specific file, get a ticket
 *   2. PUT  /api/upload/put  stream the bytes
 *   3. saveDocumentRecord    the row
 *   4. ⭐ addRevision        the register entry, and the parse
 *
 * ⚠️ ONE STORAGE PATH IN THE PRODUCT, with one set of magic-byte checks,
 * one rate limit and one retention story. A second uploader for drawings
 * would be a second place for a file to arrive without them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FILE IS IDENTIFIED BEFORE ANY OF IT IS UPLOADED
 * ══════════════════════════════════════════════════════════════════════
 * A DWG is refused HERE — before a 40MB upload on an Indian mobile
 * connection — with the AutoCAD version named and the menu path given.
 * `lib/cad/dxf/lexer.ts` is pure, so the same identification runs again
 * on the server and the two cannot disagree.
 */

import { useState, useTransition } from "react";
import { Upload, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { identifyCadFile, dwgRefusal } from "@/lib/cad/dxf/lexer";
import { saveDocumentRecord } from "@/server/actions/storage";
import { addRevision } from "@/server/actions/drawings";

type Ticket = { uploadUrl: string; ticket: string };
type Stored = { url: string; pathname: string; sizeBytes: number };

/** base64 without `atob`-style per-character arrays. See the export wizard. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function RevisionIntake({ drawingId }: { drawingId: string }) {
  const [revision, setRevision] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function inspect(chosen: File) {
    setRefusal(null);
    setFile(null);
    setBytes(null);
    const read = new Uint8Array(await chosen.arrayBuffer());
    const kind = identifyCadFile(read);

    if (kind.kind === "dwg") {
      setRefusal(dwgRefusal(kind.version));
      return;
    }
    if (kind.kind === "dxf-binary") {
      setRefusal(
        "That is a binary DXF. Re-export it without ticking the binary option and Ordence will " +
          "read it.",
      );
      return;
    }
    if (kind.kind !== "dxf-ascii") {
      setRefusal(
        "Ordence could not tell what that file is. It reads DXF, the interchange format every " +
          "CAD program writes.",
      );
      return;
    }
    setFile(chosen);
    setBytes(read);
  }

  function issue() {
    if (!file || !bytes) {
      toast.error("Choose a DXF first.");
      return;
    }
    if (revision.trim() === "") {
      toast.error("A revision needs a label — A, B, P1, whatever this project uses.");
      return;
    }

    start(async () => {
      try {
        /* 1 — authorise */
        const ticketResponse = await fetch("/api/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            entityType: "drawing",
            entityId: drawingId,
            fileName: file.name,
            sizeBytes: file.size,
            /**
             * ⚠️ BROWSERS DISAGREE ABOUT A DXF'S TYPE — some send
             * `application/dxf`, some `image/vnd.dxf`, some nothing at
             * all. The allowlist carries both; the empty case is named
             * explicitly rather than sent as `""`, which nothing accepts.
             */
            contentType: file.type || "application/dxf",
          }),
          credentials: "same-origin",
        });
        if (!ticketResponse.ok) {
          const body = (await ticketResponse.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? "That upload could not be authorised.");
          return;
        }
        const ticket = (await ticketResponse.json()) as Ticket;

        /* 2 — the bytes */
        const put = await fetch(ticket.uploadUrl, {
          method: "PUT",
          headers: { "x-upload-ticket": ticket.ticket },
          body: file,
          credentials: "same-origin",
        });
        if (!put.ok) {
          const body = (await put.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error ?? "The file could not be stored.");
          return;
        }
        const stored = (await put.json()) as Stored;

        /* 3 — the row */
        const document = await saveDocumentRecord({
          entityType: "drawing",
          entityId: drawingId,
          fileName: file.name,
          fileUrl: stored.url,
          blobPathname: stored.pathname,
          sizeBytes: stored.sizeBytes,
          mimeType: file.type || "application/dxf",
        });
        if (!document.ok) {
          toast.error(document.error);
          return;
        }

        /* 4 — the register entry, and the parse */
        const result = await addRevision({
          drawingId,
          revision: revision.trim(),
          documentId: document.data.id,
          ...(issuedOn ? { issuedOn } : {}),
          fileBase64: toBase64(bytes),
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        toast.success(
          result.data.supersededRevision
            ? `Rev ${revision.trim()} issued. Rev ${result.data.supersededRevision} superseded.`
            : `Rev ${revision.trim()} issued.`,
        );
        /**
         * ⚠️ THE PARSE WARNINGS ARE SHOWN, NOT SWALLOWED. "This drawing
         * does not state its units" is the sentence that explains why the
         * measure tool is not there, and it is useless five minutes later.
         */
        for (const warning of result.data.warnings) toast.warning(warning, { duration: 12_000 });
        if (!result.data.unitKnown) {
          toast.warning(
            "Set what one drawing unit means on this revision before anybody measures off it.",
            { duration: 15_000 },
          );
        }
        setRevision("");
        setFile(null);
        setBytes(null);
      } catch {
        toast.error("The revision could not be issued. Please try again.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="revision-label">Revision</Label>
          <Input
            id="revision-label"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            placeholder="B"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="revision-issued">Issued on</Label>
          <Input
            id="revision-issued"
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="revision-file">The DXF</Label>
        <input
          id="revision-file"
          type="file"
          accept=".dxf,.dwg"
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) void inspect(chosen);
          }}
        />
        {file ? (
          <p className="text-xs text-muted-foreground">
            {file.name} reads as a DXF ({(file.size / 1024 / 1024).toFixed(1)} MB).
          </p>
        ) : null}
        {refusal ? (
          <p className="flex gap-2 whitespace-pre-line rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>{refusal}</span>
          </p>
        ) : null}
      </div>

      <Button type="button" disabled={pending || !file} onClick={issue}>
        <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {pending ? "Issuing…" : "Issue this revision"}
      </Button>

      <p className="text-xs text-muted-foreground">
        {/*
          ⭐ THE PROPERTY SOMEBODY NEEDS TO TRUST BEFORE THEY UPLOAD their
          consultant's drawing into somebody else's software.
        */}
        Issuing a revision supersedes the one before it, which is then frozen. The file you
        upload is stored exactly as it arrived and is never modified: comments and measurements
        live beside it, so the drawing that goes back to your consultant is byte-for-byte the one
        they sent.
      </p>
    </div>
  );
}
