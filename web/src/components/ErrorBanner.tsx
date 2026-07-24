import { sanitizeError } from "../utils/sanitize";

interface ErrorBannerProps {
  /** Any error value; it is sanitized before display. */
  error: unknown;
  /** Optional dismiss handler; renders a close button when provided. */
  onDismiss?: () => void;
}

/**
 * Standardized, injection-safe error banner. All error text is passed through
 * `sanitizeError` so backend/exception messages cannot inject markup.
 */
export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  const message = sanitizeError(error);
  if (!message) return null;
  return (
    <div className="error" role="alert">
      <span className="error-msg">{message}</span>
      {onDismiss && (
        <button
          type="button"
          className="error-dismiss"
          aria-label="关闭错误提示"
          onClick={onDismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}
