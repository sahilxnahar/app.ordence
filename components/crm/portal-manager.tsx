"use client";

/**
 * Ordence — Portal Link Manager
 * Version: v0.9.0-alpha
 *
 * Internal UI for issuing, inspecting and revoking external client links.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE THING THIS COMPONENT MUST COMMUNICATE
 * ══════════════════════════════════════════════════════════════════════
 * A generated link is shown ONCE and cannot be retrieved afterwards.
 *
 * That is not a limitation of the UI — the server stores only a SHA-256
 * hash, so the raw token genuinely does not exist anywhere after this
 * response. A leaked database backup therefore contains no working
 * credentials.
 *
 * A user who does not understand that will close the panel, come back
 * tomorrow, and be confused about where their link went. So the reveal
 * panel is deliberately loud, stays open until dismissed, and says plainly
 * what happens if they lose it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY SIGNING IS AN EXPLICIT, SEPARATE CHOICE
 * ══════════════════════════════════════════════════════════════════════
 * "Let them read it" and "let them legally bind their company" are
 * different acts. The permission selector defaults to view-only, and
 * choosing to allow signing surfaces a warning — the server independently
 * requires `contracts:approve` for it, so a user without that permission
 * gets a clear refusal rather than a broken link.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Link2,
  Copy,
  Check,
  Ban,
  Loader2,
  Clock,
  Eye,
  PenLine,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createPortalLink,
  revokePortalLink,
  revokeAllPortalLinks,
  type PortalLinkListItem,
} from "@/server/actions/portal";
import {
  describeTimeRemaining,
  portalLinkStatus,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  type PortalEntityTypeInput,
} from "@/lib/validators/portal";

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  signed: "secondary",
  expired: "outline",
  revoked: "destructive",
};

/* ------------------------------------------------------------------ */
/* THE ONE-TIME REVEAL                                                 */
/* ------------------------------------------------------------------ */

function LinkReveal({
  url,
  expiresAt,
  canSign,
  emailSent,
  emailError,
  onDismiss,
}: {
  url: string;
  expiresAt: string;
  canSign: boolean;
  emailSent: boolean;
  emailError: string | null;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied.");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // `navigator.clipboard` needs a secure context and can be blocked by
      // permissions policy. The input below is readable and selectable, so
      // manual copying always works as a fallback.
      toast.error("Could not copy automatically — select the link and copy it manually.");
    }
  }

  return (
    <div className="space-y-3 rounded-md border-2 border-primary/40 bg-primary/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Your client link is ready</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Copy it now — <strong>it cannot be shown again.</strong> We store only a
              one-way hash, so this link genuinely does not exist on our servers.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex gap-2">
        <Input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
          aria-label="Portal link"
        />
        <Button type="button" onClick={copy} variant="outline" className="shrink-0">
          {copied ? (
            <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Expires {formatDate(expiresAt)}
        </span>
        <span className="flex items-center gap-1.5">
          {canSign ? (
            <>
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
              Can view and sign
            </>
          ) : (
            <>
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              View only
            </>
          )}
        </span>
      </div>

      {emailSent && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          Also emailed to the recipient.
        </p>
      )}
      {emailError && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          The link was created, but the email was not sent: {emailError}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

export function PortalManager({
  entityType,
  entityId,
  initialLinks,
  defaultRecipientEmail,
  defaultRecipientName,
  canCreate,
  canCreateSigning,
  disabledReason,
}: {
  entityType: PortalEntityTypeInput;
  entityId: string;
  initialLinks: PortalLinkListItem[];
  defaultRecipientEmail?: string | null;
  defaultRecipientName?: string | null;
  canCreate: boolean;
  /** Requires `contracts:approve`. The server checks this again. */
  canCreateSigning: boolean;
  /** Shown when creation is blocked, e.g. a legal hold. */
  disabledReason?: string | null;
}) {
  const router = useRouter();

  const [links, setLinks] = React.useState(initialLinks);
  const [showForm, setShowForm] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);

  const [revealed, setRevealed] = React.useState<{
    url: string;
    expiresAt: string;
    canSign: boolean;
    emailSent: boolean;
    emailError: string | null;
  } | null>(null);

  // Form state
  const [permission, setPermission] = React.useState<"view" | "view_and_sign">("view");
  const [expiresInDays, setExpiresInDays] = React.useState(String(DEFAULT_EXPIRY_DAYS));
  const [recipientEmail, setRecipientEmail] = React.useState(defaultRecipientEmail ?? "");
  const [recipientName, setRecipientName] = React.useState(defaultRecipientName ?? "");
  const [sendEmail, setSendEmail] = React.useState(Boolean(defaultRecipientEmail));
  const [message, setMessage] = React.useState("");

  React.useEffect(() => {
    setLinks(initialLinks);
  }, [initialLinks]);

  const activeCount = links.filter((l) => portalLinkStatus(l) === "active").length;

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();

    startTransition(async () => {
      try {
        const result = await createPortalLink({
          entityType,
          entityId,
          permission,
          expiresInDays: Number(expiresInDays),
          recipientEmail: recipientEmail.trim() || undefined,
          recipientName: recipientName.trim() || undefined,
          sendEmail,
          message: message.trim() || undefined,
        });

        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        setRevealed({
          url: result.data.url,
          expiresAt: result.data.expiresAt,
          canSign: result.data.permission === "view_and_sign",
          emailSent: result.data.emailSent,
          emailError: result.data.emailError,
        });

        setShowForm(false);
        setMessage("");
        toast.success("Client link created.");
        router.refresh();
      } catch (err) {
        console.error("[portal create]", err);
        toast.error("Could not reach the server. Please try again.");
      }
    });
  }

  function handleRevoke(link: PortalLinkListItem) {
    setBusyId(link.id);

    void (async () => {
      try {
        const result = await revokePortalLink({ linkId: link.id });

        if (result.ok) {
          setLinks((current) =>
            current.map((l) =>
              l.id === link.id
                ? { ...l, isActive: false, revokedAt: new Date().toISOString() }
                : l,
            ),
          );
          toast.success("Link revoked. It stops working immediately.");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch (err) {
        console.error("[portal revoke]", err);
        toast.error("Could not reach the server. Please try again.");
      } finally {
        setBusyId(null);
      }
    })();
  }

  function handleRevokeAll() {
    startTransition(async () => {
      try {
        const result = await revokeAllPortalLinks({
          entityType,
          entityId,
          reason: "Bulk revocation from the contract page",
        });

        if (result.ok) {
          toast.success(
            `${result.data.revokedCount} link${result.data.revokedCount === 1 ? "" : "s"} revoked.`,
          );
          setConfirmRevokeAll(false);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch (err) {
        console.error("[portal revoke all]", err);
        toast.error("Could not reach the server. Please try again.");
      }
    });
  }

  return (
    <section className="space-y-4" aria-labelledby="portal-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="portal-heading" className="text-lg font-semibold">
            Client access
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Share this document with someone outside your workspace. They will not
            need an account.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRevokeAll(true)}
              disabled={isPending}
            >
              <Ban className="h-4 w-4" aria-hidden="true" />
              Revoke all
            </Button>
          )}

          {canCreate && !showForm && (
            <Button size="sm" onClick={() => setShowForm(true)} disabled={isPending}>
              <Link2 className="h-4 w-4" aria-hidden="true" />
              Generate client link
            </Button>
          )}
        </div>
      </div>

      {!canCreate && disabledReason && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {disabledReason}
        </p>
      )}

      {/* ── THE ONE-TIME REVEAL ───────────────────────────────────── */}
      {revealed && (
        <LinkReveal
          url={revealed.url}
          expiresAt={revealed.expiresAt}
          canSign={revealed.canSign}
          emailSent={revealed.emailSent}
          emailError={revealed.emailError}
          onDismiss={() => setRevealed(null)}
        />
      )}

      {/* ── CREATE FORM ───────────────────────────────────────────── */}
      {showForm && canCreate && (
        <form
          onSubmit={handleCreate}
          className="space-y-4 rounded-md border border-border p-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="portal-permission">What can they do?</Label>
              <Select
                id="portal-permission"
                value={permission}
                onChange={(e) =>
                  setPermission(e.target.value as "view" | "view_and_sign")
                }
                disabled={isPending}
              >
                <option value="view">View only</option>
                {canCreateSigning && <option value="view_and_sign">View and sign</option>}
              </Select>
              {!canCreateSigning && (
                <p className="text-xs text-muted-foreground">
                  Creating a signing link requires contract approval permission.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="portal-expiry">Expires after</Label>
              <Select
                id="portal-expiry"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                disabled={isPending}
              >
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days (recommended)</option>
                <option value="30">30 days</option>
                <option value={String(MAX_EXPIRY_DAYS)}>{MAX_EXPIRY_DAYS} days (maximum)</option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="portal-name">Recipient name</Label>
              <Input
                id="portal-name"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                disabled={isPending}
                maxLength={300}
                placeholder="Priya Nair"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="portal-email">Recipient email</Label>
              <Input
                id="portal-email"
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                disabled={isPending}
                maxLength={320}
                placeholder="priya@example.com"
              />
            </div>
          </div>

          {permission === "view_and_sign" && (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
              role="alert"
            >
              <TriangleAlert
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <span className="text-muted-foreground">
                Anyone holding this link will be able to <strong>legally sign</strong>{" "}
                this contract without an account. It can be used to sign once, and you
                can revoke it at any time before that.
              </span>
            </div>
          )}

          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                disabled={isPending || !recipientEmail.trim()}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              Email this link to the recipient
            </label>

            {sendEmail && (
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={2000}
                disabled={isPending}
                placeholder="Optional covering note for the email."
                aria-label="Covering note"
              />
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowForm(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? "Creating…" : "Create link"}
            </Button>
          </div>
        </form>
      )}

      {/* ── EXISTING LINKS ────────────────────────────────────────── */}
      {links.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No client links yet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {links.map((link) => {
            const status = portalLinkStatus(link);
            const timeLeft = describeTimeRemaining(link.expiresAt);
            const isBusy = busyId === link.id;

            return (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {/* The prefix, never the token. Enough to tell two links
                        apart in a support conversation; useless as a
                        credential. */}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {link.tokenPrefix}…
                    </code>

                    <Badge variant={STATUS_TONE[status] ?? "secondary"}>{status}</Badge>

                    {link.permission === "view_and_sign" && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <PenLine className="h-3 w-3" aria-hidden="true" />
                        can sign
                      </span>
                    )}
                  </p>

                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {link.recipientName || link.recipientEmail || "No recipient recorded"}
                    {" · "}
                    {status === "active" && timeLeft
                      ? `expires in ${timeLeft}`
                      : status === "signed"
                        ? `signed ${formatDate(link.signedAt)}`
                        : status === "revoked"
                          ? `revoked ${formatDate(link.revokedAt)}`
                          : `expired ${formatDate(link.expiresAt)}`}
                    {" · "}
                    {link.viewCount} view{link.viewCount === 1 ? "" : "s"}
                  </p>
                </div>

                {status === "active" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isBusy}
                    onClick={() => handleRevoke(link)}
                  >
                    {isBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Ban className="h-4 w-4 text-destructive" aria-hidden="true" />
                    )}
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Links are shown once at creation and stored only as a one-way hash — they
        cannot be recovered later. Revoking takes effect immediately.
      </p>

      {/* ── REVOKE ALL ────────────────────────────────────────────── */}
      <Dialog open={confirmRevokeAll} onOpenChange={setConfirmRevokeAll}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke every active link?</DialogTitle>
            <DialogDescription>
              {activeCount} active link{activeCount === 1 ? "" : "s"} for this record.
            </DialogDescription>
          </DialogHeader>

          <p className="text-sm text-muted-foreground">
            Every one stops working immediately, including any already sitting in a
            client&rsquo;s inbox. Anyone who still needs access will need a new link.
          </p>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRevokeAll(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevokeAll} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Revoke all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
