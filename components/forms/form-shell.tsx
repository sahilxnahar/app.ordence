"use client";

/**
 * Ordence — Form Shell & Submission Plumbing
 * Version: v0.7.0-alpha
 *
 * One place that handles the things every form needs and everyone forgets:
 *   - a pending state, so the user cannot double-submit
 *   - server-side field errors mapped back onto the right inputs
 *   - a toast on success and on failure
 *   - a router refresh so the server components behind the form re-fetch
 *
 * WHY SERVER ERRORS ARE MAPPED BACK ONTO FIELDS:
 * Our server actions return `{ ok: false, fieldErrors: { email: [...] } }`.
 * Showing that as a generic toast ("Validation failed") leaves the user hunting
 * for which input is wrong. `setError` puts the message under the actual field.
 *
 * WHY THE CLIENT SCHEMA IS NOT THE SECURITY BOUNDARY:
 * Client validation exists for speed of feedback. The server re-validates with
 * the same Zod schema and is the only thing that decides what gets written.
 * A user with dev-tools can bypass everything here; they cannot bypass the action.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormProps, type FieldValues, type Path, type DefaultValues } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The envelope every server action in this codebase returns. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type UseActionFormOptions<TSchema extends z.ZodType, TResult> = {
  schema: TSchema;
  defaultValues?: DefaultValues<z.infer<TSchema>>;
  action: (values: z.infer<TSchema>) => Promise<ActionResult<TResult>>;
  onSuccess?: (data: TResult) => void;
  successMessage?: string | ((data: TResult) => string);
  /** Reset the form after a successful submit. Useful for "create another". */
  resetOnSuccess?: boolean;
  /** Refresh server components so lists update. Default true. */
  refreshOnSuccess?: boolean;
  formOptions?: Omit<UseFormProps<z.infer<TSchema>>, "resolver" | "defaultValues">;
};

/**
 * Wire a Zod schema and a server action into a react-hook-form instance.
 *
 * @example
 *   const { form, submit, isPending } = useActionForm({
 *     schema: createContactSchema,
 *     action: createContact,
 *     successMessage: "Contact created.",
 *   });
 */
export function useActionForm<TSchema extends z.ZodType, TResult>({
  schema,
  defaultValues,
  action,
  onSuccess,
  successMessage = "Saved.",
  resetOnSuccess = false,
  refreshOnSuccess = true,
  formOptions,
}: UseActionFormOptions<TSchema, TResult>) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [serverError, setServerError] = React.useState<string | null>(null);

  type Values = z.infer<TSchema>;

  const form = useForm<Values>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema as any),
    defaultValues,
    mode: "onBlur",
    ...formOptions,
  });

  const submit = form.handleSubmit((values) => {
    setServerError(null);

    startTransition(async () => {
      try {
        const result = await action(values as Values);

        if (result.ok) {
          toast.success(
            typeof successMessage === "function" ? successMessage(result.data) : successMessage,
          );
          if (resetOnSuccess) form.reset(defaultValues);
          if (refreshOnSuccess) router.refresh();
          onSuccess?.(result.data);
          return;
        }

        // Map server field errors back onto the inputs they belong to.
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            const message = messages[0];
            if (message) {
              form.setError(field as Path<Values>, { type: "server", message });
            }
          }
        }

        setServerError(result.error);
        toast.error(result.error);
      } catch (err) {
        // A thrown error means the action itself blew up — network, timeout,
        // or an unhandled exception. Never leak the raw message to the user.
        console.error("[form submit]", err);
        const message = "Could not reach the server. Please try again.";
        setServerError(message);
        toast.error(message);
      }
    });
  });

  return {
    form,
    submit,
    isPending,
    serverError,
    clearServerError: () => setServerError(null),
  };
}

/* ------------------------------------------------------------------ */
/* PRESENTATION                                                        */
/* ------------------------------------------------------------------ */

export function FormShell({
  onSubmit,
  children,
  className,
}: {
  onSubmit: (e: React.FormEvent) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <form onSubmit={onSubmit} noValidate className={cn("space-y-5", className)}>
      {children}
    </form>
  );
}

/** Banner for an error that is not attached to any single field. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function FormActions({
  isPending,
  submitLabel = "Save",
  pendingLabel = "Saving…",
  onCancel,
  cancelLabel = "Cancel",
  /** Set false to hold the submit button disabled for a business reason. */
  canSubmit = true,
  /** Shown next to the buttons when submission is blocked. */
  blockedReason,
}: {
  isPending: boolean;
  submitLabel?: string;
  pendingLabel?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  canSubmit?: boolean;
  blockedReason?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
      {blockedReason && !canSubmit && (
        <p className="mr-auto text-xs text-destructive" role="status">
          {blockedReason}
        </p>
      )}

      {onCancel && (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {cancelLabel}
        </Button>
      )}

      <Button type="submit" disabled={isPending || !canSubmit}>
        {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </div>
  );
}
