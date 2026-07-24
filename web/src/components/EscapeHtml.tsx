import type { ReactNode } from "react";

type EscapeTag = "span" | "div" | "p" | "code" | "pre" | "li";

interface EscapeHtmlProps {
  /** Untrusted text (user input or backend value). Rendered as text only. */
  text: string;
  className?: string;
  as?: EscapeTag;
}

/**
 * Renders untrusted text as a plain text node. React escapes text children, so
 * backend-provided values (status, message, error, log lines, task ids) can
 * never be interpreted as HTML. Centralizing this in one component makes the
 * "no HTML injection" guarantee auditable (spec: harden-web-frontend).
 */
export function EscapeHtml({ text, className, as = "span" }: EscapeHtmlProps): ReactNode {
  const Tag = as;
  return <Tag className={className}>{text}</Tag>;
}
