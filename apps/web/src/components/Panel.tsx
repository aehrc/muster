import { useId } from "react";

import type { JSX, ReactNode } from "react";

/**
 * A titled section of a screen.
 *
 * Every page in the console is a stack of these, so the surfaces and the spacing
 * are stated once rather than in each page's markup.
 *
 * The heading names the section programmatically, not merely visually: a section
 * with an accessible name is a landmark a screen reader can jump between, and it
 * is what lets a reader of a screen with four panels tell them apart.
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
  const headingId = useId();

  return (
    <section
      className="card border border-base-300 bg-base-200"
      aria-labelledby={headingId}
    >
      <div className="card-body gap-4 p-4 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="card-title text-lg" id={headingId}>
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
