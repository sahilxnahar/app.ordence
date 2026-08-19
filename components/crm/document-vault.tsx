"use client";

/**
 * Ordence — Document Vault
 * Version: v0.8.0-alpha
 *
 * Drag-and-drop upload plus a virtualized file list, for any record that
 * can carry attachments.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE UPLOAD LIFECYCLE, AND WHY IT HAS THREE STEPS RATHER THAN ONE
 * ══════════════════════════════════════════════════════════════════════
 *
 *   pending → uploading (0–100%) → saving → complete
 *                    ↓                 ↓
 *                  error             error
 *
 *   1. POST `/api/upload` — asks OUR route to authorise this file. Comes
 *      back with a short-lived SIGNED TICKET that pins the storage path,
 *      the content type and a byte ceiling.
 *
 *   2. PUT `/api/upload/put` — streams the bytes, presenting the ticket.
 *      The Worker pipes them into Cloudflare R2 and reports the size that
 *      actually landed.
 *
 *   3. `saveDocumentRecord()` writes the database row afterwards.
 *
 * ⚠️ v0.21.0 — THE BYTES NOW PASS THROUGH OUR OWN WORKER.
 * On Vercel they went straight to Vercel Blob, because a Vercel function
 * caps its request body at 4.5 MB. A Cloudflare Worker's cap is 100 MB, so
 * proxying a 50 MB agreement is fine — and it means every constraint is
 * enforced by code we own rather than by a third party's token.
 *
 * Step 3 stays separate from step 2 on purpose: `/api/upload/put` is the
 * widest input surface in the application and is deliberately given no
 * database authority. See the header of that route.
 *
 * The honest cost is unchanged: if the tab closes between step 2 and step 3,
 * the object exists in storage with no row. It is private and unreachable,
 * so this is a storage-cost leak rather than an exposure, tracked as
 * SEC-018.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THE CLIENT-SIDE CHECKS ARE AND ARE NOT
 * ══════════════════════════════════════════════════════════════════════
 * Size and type are checked here so a user learns about a rejected file
 * instantly instead of after a two-minute upload. That is a courtesy.
 *
 * The enforcement is in `/api/upload`, which re-applies the allowlist and
 * signs the type and the ceiling into the ticket, and `/api/upload/put`,
 * which refuses a body that does not match it. Bypassing this component
 * entirely changes nothing.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  UploadCloud,
  FileText,
  FileSpreadsheet,
  FileImage,
  FileArchive,
  Download,
  Trash2,
  Loader2,
  CircleAlert,
  CircleCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_BYTES,
  formatBytes,
  isAllowedMimeType,
} from "@/lib/validators/storage";
import type { DocumentEntityTypeInput } from "@/lib/validators/storage";
import { saveDocumentRecord, deleteDocument } from "@/server/actions/storage";
import type { DocumentListItem } from "@/server/actions/storage";

/* ------------------------------------------------------------------ */
/* UPLOAD STATE                                                        */
/* ------------------------------------------------------------------ */

type UploadStatus = "pending" | "uploading" | "saving" | "complete" | "error";

type UploadItem = {
  /** Stable local id. Not the database id — that only exists after saving. */
  key: string;
  fileName: string;
  sizeBytes: number;
  status: UploadStatus;
  /** 0–100. Only meaningful while `status === "uploading"`. */
  progress: number;
  error?: string;
};

/* ------------------------------------------------------------------ */
/* PRESENTATION HELPERS                                                */
/* ------------------------------------------------------------------ */

function iconForMime(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType === "application/zip") return FileArchive;
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv"
  ) {
    return FileSpreadsheet;
  }
  return FileText;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** A local id that does not need `crypto.randomUUID` (absent in older Safari). */
let uploadCounter = 0;
function nextUploadKey(): string {
  uploadCounter += 1;
  return `upload-${uploadCounter}-${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/* UPLOAD TRANSPORT                                                    */
/* ------------------------------------------------------------------ */

type UploadTicketResponse = {
  uploadUrl: string;
  ticket: string;
  pathname: string;
  expiresAt: number;
  maxBytes: number;
};

type StoredFileResponse = {
  pathname: string;
  sizeBytes: number;
  contentType: string;
  url: string;
};

/**
 * Read the server's error message out of a failed response.
 *
 * Our routes answer `{ error: "..." }` with sentences written to be shown to
 * a human — "That file type is not permitted", "File storage is not
 * configured for this deployment". Replacing those with a generic string
 * throws away the only useful information in the response.
 */
async function errorMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) return body.error;
  } catch {
    /* not JSON — fall through */
  }
  return fallback;
}

/** Step 1: authorise this specific file and get back a signed ticket. */
async function requestUploadTicket(payload: {
  entityType: string;
  entityId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
}): Promise<UploadTicketResponse> {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // The Clerk session cookie is the first of the two credentials
    // `/api/upload/put` requires. Same-origin sends it by default; stated
    // explicitly so a future refactor cannot drop it by accident.
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(await errorMessageFrom(response, "Could not authorise this upload."));
  }

  return (await response.json()) as UploadTicketResponse;
}

/**
 * Step 2: stream the bytes, reporting progress.
 *
 * ⚠️ XMLHttpRequest ON PURPOSE. `fetch()` has no upload-progress event in any
 * shipping browser — the streaming-request-body proposal that would provide
 * one is still not universally available. Without a progress bar a 50 MB file
 * on a slow connection is indistinguishable from a frozen tab, which is the
 * single most common reason a user kills an upload that was going to succeed.
 */
function putFileWithProgress(args: {
  url: string;
  ticket: string;
  file: File;
  onProgress: (percentage: number) => void;
}): Promise<StoredFileResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", args.url, true);

    // Sends the Clerk cookie. `/api/upload/put` requires BOTH a live session
    // and a matching ticket — see that route's check 3.
    xhr.withCredentials = true;

    xhr.setRequestHeader("x-ordence-upload-ticket", args.ticket);
    // Must match the type pinned in the ticket exactly, or the route refuses
    // with 415. `file.type` is what was declared when the ticket was issued.
    xhr.setRequestHeader("content-type", args.file.type);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      args.onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(xhr.responseText) as unknown;
      } catch {
        parsed = null;
      }

      if (xhr.status >= 200 && xhr.status < 300 && parsed) {
        resolve(parsed as StoredFileResponse);
        return;
      }

      const message =
        parsed && typeof (parsed as { error?: unknown }).error === "string"
          ? ((parsed as { error: string }).error)
          : "The upload failed. Please try again.";
      reject(new Error(message));
    };

    // A network failure and an abort are different events but the same
    // outcome for the user, and neither leaves a row behind.
    xhr.onerror = () => reject(new Error("The connection dropped during upload."));
    xhr.onabort = () => reject(new Error("The upload was cancelled."));
    xhr.ontimeout = () => reject(new Error("The upload timed out."));

    xhr.send(args.file);
  });
}

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

export function DocumentVault({
  entityType,
  entityId,
  initialDocuments,
  canUpload = true,
  canDelete = true,
  /** Rendered above the list. Defaults to a generic label. */
  title = "Documents",
  description,
  /** Height of the scrolling list, in pixels. */
  listHeight = 320,
}: {
  entityType: DocumentEntityTypeInput;
  entityId: string;
  initialDocuments: DocumentListItem[];
  canUpload?: boolean;
  canDelete?: boolean;
  title?: string;
  description?: string;
  listHeight?: number;
}) {
  const router = useRouter();

  const [documents, setDocuments] = React.useState<DocumentListItem[]>(initialDocuments);
  const [uploads, setUploads] = React.useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // A drag over a child element fires dragleave on the parent. Counting
  // enter/leave pairs is the standard fix — without it the drop zone
  // flickers as the cursor crosses the icon and the text inside it.
  const dragDepth = React.useRef(0);

  // Keep the list in sync when the server sends new props (e.g. after
  // `router.refresh()` following a delete elsewhere on the page).
  React.useEffect(() => {
    setDocuments(initialDocuments);
  }, [initialDocuments]);

  /* ---- Validation before anything leaves the browser ------------- */

  const rejectionReason = React.useCallback((file: File): string | null => {
    if (file.size === 0) {
      return "The file is empty.";
    }
    if (file.size > MAX_FILE_BYTES) {
      return `Too large — ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`;
    }
    // Browsers occasionally report an empty type for unusual extensions.
    // Treat that as unknown-and-therefore-refused rather than waving it
    // through: the allowlist only means something if it is applied.
    if (!file.type || !isAllowedMimeType(file.type)) {
      return `That file type is not accepted${file.type ? ` (${file.type})` : ""}.`;
    }
    return null;
  }, []);

  /* ---- The upload pipeline --------------------------------------- */

  const uploadOne = React.useCallback(
    async (file: File, key: string) => {
      const setItem = (patch: Partial<UploadItem>) => {
        setUploads((current) =>
          current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
        );
      };

      try {
        setItem({ status: "uploading", progress: 0 });

        // STEP 1 — ask our route to authorise this specific file.
        //
        // This payload is NOT trusted server-side: the route re-validates it
        // with Zod, re-applies the content-type allowlist, and rebuilds the
        // storage path from the SESSION's tenant id — so nothing sent from
        // here can steer the file into another tenant's namespace.
        const ticket = await requestUploadTicket({
          entityType,
          entityId,
          fileName: file.name,
          sizeBytes: file.size,
          contentType: file.type,
        });

        // STEP 2 — send the bytes.
        //
        // XMLHttpRequest, not fetch. `fetch()` still cannot report upload
        // progress in any shipping browser, and a 50 MB agreement on an
        // Indian mobile connection with no progress bar is indistinguishable
        // from a hung page. The rest of this component is modern; this one
        // API is not, for a reason.
        const stored = await putFileWithProgress({
          url: ticket.uploadUrl,
          ticket: ticket.ticket,
          file,
          onProgress: (percentage) => setItem({ progress: percentage }),
        });

        // STEP 3 — the database row.
        setItem({ status: "saving", progress: 100 });

        const result = await saveDocumentRecord({
          entityType,
          entityId,
          fileName: file.name,
          // An `r2://` locator, produced by the server. No public URL exists
          // for a private R2 object, and storing something HTTPS-shaped
          // would imply one does.
          fileUrl: stored.url,
          blobPathname: stored.pathname,
          // ⚠️ R2's number, not `file.size`. The row must record what was
          // actually stored, because the storage meter bills against it.
          sizeBytes: stored.sizeBytes,
          mimeType: file.type,
        });

        if (!result.ok) {
          setItem({ status: "error", error: result.error });
          toast.error(`${file.name}: ${result.error}`);
          return;
        }

        setItem({ status: "complete", progress: 100 });

        // Optimistically prepend so the file appears immediately, then
        // refresh so the server remains the source of truth.
        setDocuments((current) => [
          {
            id: result.data.id,
            fileName: result.data.fileName,
            sizeBytes: Number(result.data.sizeBytes),
            mimeType: result.data.mimeType,
            description: result.data.description,
            createdAt: new Date(result.data.createdAt).toISOString(),
            uploadedBy: result.data.uploadedBy,
          },
          ...current,
        ]);

        toast.success(`${file.name} uploaded.`);
        router.refresh();

        // Clear the finished row after a moment so the progress list does
        // not grow without bound during a long session.
        setTimeout(() => {
          setUploads((current) => current.filter((item) => item.key !== key));
        }, 2500);
      } catch (err) {
        console.error("[vault upload]", err);

        // The helpers below re-throw our route's own refusal message —
        // including "File storage is not configured" — which is worth
        // showing rather than replacing with something generic.
        const message =
          err instanceof Error && err.message
            ? err.message
            : "The upload failed. Please try again.";

        setItem({ status: "error", error: message });
        toast.error(`${file.name}: ${message}`);
      }
    },
    [entityType, entityId, router],
  );

  const handleFiles = React.useCallback(
    (fileList: FileList | File[]) => {
      if (!canUpload) return;

      const files = Array.from(fileList);
      if (files.length === 0) return;

      const accepted: Array<{ file: File; key: string }> = [];
      const newItems: UploadItem[] = [];

      for (const file of files) {
        const reason = rejectionReason(file);
        const key = nextUploadKey();

        if (reason) {
          // Rejected files still appear in the list, with the reason. A
          // file that silently vanishes reads as a bug.
          newItems.push({
            key,
            fileName: file.name,
            sizeBytes: file.size,
            status: "error",
            progress: 0,
            error: reason,
          });
          toast.error(`${file.name}: ${reason}`);
          continue;
        }

        newItems.push({
          key,
          fileName: file.name,
          sizeBytes: file.size,
          status: "pending",
          progress: 0,
        });
        accepted.push({ file, key });
      }

      setUploads((current) => [...newItems, ...current]);

      // Sequential, not parallel. Several large concurrent uploads on a
      // home or mobile connection starve each other and every progress
      // bar crawls; one at a time finishes sooner and reads honestly.
      void (async () => {
        for (const { file, key } of accepted) {
          await uploadOne(file, key);
        }
      })();
    },
    [canUpload, rejectionReason, uploadOne],
  );

  /* ---- Drag and drop --------------------------------------------- */

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canUpload) return;
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    // Without preventDefault here the browser navigates away to the file —
    // the default behaviour for a dropped file, and a confusing one.
    e.preventDefault();
    e.stopPropagation();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    if (!canUpload) return;
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  };

  /* ---- Delete ----------------------------------------------------- */

  const handleDelete = (doc: DocumentListItem) => {
    setDeletingId(doc.id);

    void (async () => {
      try {
        const result = await deleteDocument(doc.id);

        if (result.ok) {
          setDocuments((current) => current.filter((d) => d.id !== doc.id));
          toast.success(`${doc.fileName} deleted.`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch (err) {
        console.error("[vault delete]", err);
        toast.error("Could not reach the server. Please try again.");
      } finally {
        setDeletingId(null);
      }
    })();
  };

  /* ---- Virtualized list ------------------------------------------- */

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 56;

  const virtualizer = useVirtualizer({
    count: documents.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    // Render a few rows beyond the viewport so fast scrolling does not
    // reveal blank space before React catches up.
    overscan: 6,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const activeUploads = uploads.filter((u) => u.status !== "complete");

  return (
    <section className="space-y-3" aria-labelledby="vault-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="vault-heading" className="text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {documents.length} {documents.length === 1 ? "file" : "files"}
        </span>
      </div>

      {/* ── DROP ZONE ─────────────────────────────────────────────── */}
      {canUpload && (
        <div
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          className={cn(
            "rounded-lg border-2 border-dashed p-6 text-center transition-colors",
            isDragging
              ? "border-primary bg-primary/5"
              : "border-border bg-muted/20 hover:border-muted-foreground/40",
          )}
        >
          <UploadCloud
            className={cn(
              "mx-auto h-8 w-8",
              isDragging ? "text-primary" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />

          <p className="mt-2 text-sm font-medium">
            {isDragging ? "Drop to upload" : "Drag files here"}
          </p>

          <p className="mt-1 text-xs text-muted-foreground">
            or{" "}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="font-medium text-primary underline underline-offset-2"
            >
              choose from your computer
            </button>
          </p>

          <p className="mt-2 text-xs text-muted-foreground">
            PDF, Word, Excel, PowerPoint, images and ZIP · up to{" "}
            {formatBytes(MAX_FILE_BYTES)} each
          </p>

          {/*
            The file input is visually hidden but remains in the accessibility
            tree and focusable, so keyboard and screen-reader users reach it
            normally. `display: none` would remove it from both.
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(",")}
            className="sr-only"
            aria-label="Choose files to upload"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files);
              // Reset so selecting the SAME file twice in a row still fires
              // a change event.
              e.target.value = "";
            }}
          />
        </div>
      )}

      {/* ── IN-FLIGHT UPLOADS ─────────────────────────────────────── */}
      {activeUploads.length > 0 && (
        <ul className="space-y-2" aria-label="Uploads in progress">
          {activeUploads.map((item) => (
            <li
              key={item.key}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{item.fileName}</span>

                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {item.status === "uploading" && (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {item.progress}%
                    </>
                  )}
                  {item.status === "saving" && (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Saving…
                    </>
                  )}
                  {item.status === "pending" && "Queued"}
                  {item.status === "complete" && (
                    <CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                  )}
                  {item.status === "error" && (
                    <button
                      type="button"
                      onClick={() =>
                        setUploads((c) => c.filter((u) => u.key !== item.key))
                      }
                      aria-label={`Dismiss ${item.fileName}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </span>
              </div>

              {(item.status === "uploading" || item.status === "saving") && (
                <div
                  role="progressbar"
                  aria-valuenow={item.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Uploading ${item.fileName}`}
                  className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-200"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}

              {item.status === "error" && item.error && (
                <p
                  role="alert"
                  className="mt-1 flex items-start gap-1.5 text-xs text-destructive"
                >
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {item.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ── FILE LIST ─────────────────────────────────────────────── */}
      {documents.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No files attached yet.
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="overflow-auto rounded-md border border-border"
          style={{ height: Math.min(listHeight, documents.length * ROW_HEIGHT + 2) }}
        >
          {/*
            Virtualized: only the rows in view are in the DOM, so a record
            with 5,000 attachments costs the same as one with 20. The outer
            div is sized to the full list so the scrollbar is honest.
          */}
          <div
            style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
          >
            <ul aria-label="Attached files">
              {virtualRows.map((virtualRow) => {
                const doc = documents[virtualRow.index];
                if (!doc) return null;

                const Icon = iconForMime(doc.mimeType);
                const isDeleting = deletingId === doc.id;

                return (
                  <li
                    key={doc.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 flex w-full items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <Icon
                      className="h-5 w-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />

                    <div className="min-w-0 flex-1">
                      {/* The filename is rendered as TEXT, never as markup.
                          React escapes it automatically — which is exactly
                          why the original name is safe to keep in the
                          database unaltered. */}
                      <p className="truncate text-sm font-medium">{doc.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(doc.sizeBytes)} · {formatDate(doc.createdAt)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {/*
                        A normal link to OUR route, not to the blob.
                        Files are stored privately; this endpoint re-checks
                        the session and the tenant on every request and then
                        streams the bytes. There is no token in this URL and
                        nothing here keeps working once someone leaves the
                        organisation.
                      */}
                      <Button asChild variant="ghost" size="sm">
                        <a
                          href={`/api/documents/${doc.id}/download`}
                          aria-label={`Download ${doc.fileName}`}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                          <span className="sr-only sm:not-sr-only">Download</span>
                        </a>
                      </Button>

                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isDeleting}
                          onClick={() => handleDelete(doc)}
                          aria-label={`Delete ${doc.fileName}`}
                        >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                          )}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {canDelete && documents.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Deleting a file removes it from storage permanently. The record that it
          existed, and who removed it, is kept in the audit log.
        </p>
      )}
    </section>
  );
}
