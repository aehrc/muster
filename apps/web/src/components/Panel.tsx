import type { JSX, ReactNode } from "react";

/**
 * A titled section of a screen.
 *
 * Every page in the console is a stack of these, so the surfaces and the spacing
 * are stated once rather than in each page's markup.
 *
 * @author John Grimes
 */

/**
 * Renders a titled panel.
 *
 * @param props - the heading, an optional icon and description, and the contents
 * @returns the panel
 * @example
 * ```tsx
 * <Panel title="Members" icon={<PeopleIcon size={18} />}>{children}</Panel>
 * ```
 */
export function Panel({
  title,
  icon,
  description,
  children,
}: Readonly<{
  /** the heading */
  title: string;
  /** the icon beside the heading */
  icon?: ReactNode;
  /** what the panel is for */
  description?: string;
  /** the contents */
  children: ReactNode;
}>): JSX.Element {
  return (
    <section className="card border border-base-300 bg-base-200">
      <div className="card-body gap-4 p-4 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="card-title text-lg">
            {icon}
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="text-sm text-base-content/70">{description}</p>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}
