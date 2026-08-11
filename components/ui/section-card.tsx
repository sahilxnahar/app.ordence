import { ReactNode } from 'react';

interface SectionCardProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionCard({ title, description, actions, children, className }: SectionCardProps) {
  return (
    <section className={`rounded-lg border bg-card p-6 ${className || ''}`}>
      {(title || description || actions) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="space-y-1">
            {title && <h2 className="text-xl font-semibold">{title}</h2>}
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
