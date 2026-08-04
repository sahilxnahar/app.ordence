"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { ContactWithCompany } from "@/server/actions/contacts";

export const contactColumns: ColumnDef<ContactWithCompany, unknown>[] = [
  {
    id: "name",
    header: "Name",
    accessorFn: (row) => [row.firstName, row.lastName].filter(Boolean).join(" "),
    cell: ({ getValue }) => <span className="font-medium">{String(getValue() ?? "—")}</span>,
  },
  {
    id: "email",
    header: "Email",
    accessorKey: "email",
    cell: ({ getValue }) => {
      const v = getValue();
      if (!v) return <span className="text-muted-foreground">—</span>;
      return (
        <a href={`mailto:${String(v)}`} className="text-primary hover:underline" rel="noreferrer">
          {String(v)}
        </a>
      );
    },
  },
  {
    id: "jobTitle",
    header: "Job title",
    accessorKey: "jobTitle",
    cell: ({ getValue }) => String(getValue() ?? "—"),
  },
  {
    id: "companyName",
    header: "Company",
    accessorKey: "companyName",
    cell: ({ getValue }) => String(getValue() ?? "—"),
  },
  {
    id: "phone",
    header: "Phone",
    accessorKey: "phone",
    cell: ({ getValue }) => String(getValue() ?? "—"),
  },
  {
    id: "createdAt",
    header: "Added",
    accessorKey: "createdAt",
    cell: ({ getValue }) => {
      const v = getValue();
      return v ? new Date(String(v)).toLocaleDateString() : "—";
    },
  },
];
