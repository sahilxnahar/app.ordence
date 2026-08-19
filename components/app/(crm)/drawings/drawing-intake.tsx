"use client";

/**
 * Ordence — ⭐⭐ ADDING A DRAWING, AND ITS FIRST REVISION
 * Version: v1.75.0-alpha · Wave 7
 *
 * ⚠️ THE FILE IS CHECKED IN THE BROWSER BEFORE IT IS SENT. A DWG is
 * refused here, with the AutoCAD version named and the menu path given,
 * rather than after a 40MB upload. `lib/cad/dxf/lexer.ts` is pure, so the
 * same identification runs on both sides and they cannot disagree.
 */

import { useState, useTransition } from "react";
import { Upload, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { identifyCadFile, dwgRefusal } from "@/lib/cad/dxf/lexer";
import { addDrawing } from "@/server/actions/drawings";

const DISCIPLINES = [
  "architectural",
  "structural",
  "mep",
  "civil",
  "survey",
  "landscape",
  "interior",
  "other",
] as const;

export function DrawingIntake() {
  const [drawingNumber, setDrawingNumber] = useState("");
  const [title, setTitle] = useState("");
  const [discipline, setDiscipline] = useState<string>("architectural");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function inspect(file: File) {
    setRefusal(null);
    setFileNote(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = identifyCadFile(bytes);

    if (kind.kind === "dwg") {
      /**
       * 🔴 NAMED, WITH THE MENU PATH. "Unsupported file type" sends the
       * customer to support; this sends them back to their own software,
       * which is where the fix is.
       */
      setRefusal(dwgRefusal(kind.version));
      return;
    }
    if (kind.kind === "dxf-binary") {
      setRefusal(
        "That is a binary DXF — a real format and a rare one. Re-export it without ticking the " +
          "binary option and Ordence will read it.",
      );
      return;
    }
    if (kind.kind !== "dxf-ascii") {
      setRefusal(
        "Ordence could not tell what that file is. It reads DXF, the interchange format every " +
          "CAD program writes. If this is a PDF or an image of a drawing, attach it as a " +
          "document instead.",
      );
      return;
    }
    setFileNote(
      `${file.name} reads as a DXF (${(bytes.length / 1024 / 1024).toFixed(1)} MB). Create the ` +
        `drawing below, then open it to add this as revision A.`,
    );
  }

  function submit() {
    if (drawingNumber.trim() === "" || title.trim() === "") {
      toast.error("A drawing needs a number and a title.");
      return;
    }
    start(async () => {
      const result = await addDrawing({
        drawingNumber: drawingNumber.trim(),
        title: title.trim(),
        discipline,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${drawingNumber.trim()} added to the register.`);
      setDrawingNumber("");
      setTitle("");
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="drawing-number">Drawing number</Label>
          <Input
            id="drawing-number"
            value={drawingNumber}
            onChange={(e) => setDrawingNumber(e.target.value)}
            placeholder="DRG-102"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="drawing-title">Title</Label>
          <Input
            id="drawing-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ground floor plan"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="drawing-discipline">Discipline</Label>
          <Select
            id="drawing-discipline"
            value={discipline}
            onChange={(e) => setDiscipline(e.target.value)}
          >
            {DISCIPLINES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="drawing-file">Check a file (optional)</Label>
        <input
          id="drawing-file"
          type="file"
          accept=".dxf,.dwg"
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void inspect(file);
          }}
        />
        {fileNote ? <p className="text-xs text-muted-foreground">{fileNote}</p> : null}
        {refusal ? (
          <p className="flex gap-2 whitespace-pre-line rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>{refusal}</span>
          </p>
        ) : null}
      </div>

      <Button type="button" disabled={pending} onClick={submit}>
        <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {pending ? "Adding…" : "Add to the register"}
      </Button>
    </div>
  );
}
