/**
 * A page's title row: heading and supporting line on the left, the primary
 * action on the right.
 *
 * `subtitle` is for a one-line summary or count. `children` is for anything else
 * that belongs under the heading — detail pages put a status badge and an
 * identifier there instead of prose.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Usually a single primary Button. Rendered flush right. */
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-[22px] font-bold leading-tight tracking-tight">
          {title}
        </h1>
        {subtitle !== undefined && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
        {children}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}
