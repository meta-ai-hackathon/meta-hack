interface StatusRegionProps {
  /** Current status text; a change to it is announced politely. An empty string renders a silent, empty region. */
  message: string;
  id?: string;
  className?: string;
}

/**
 * Polite live region (BN-07): render it once and change `message`; screen
 * readers announce the update (VAL-A11Y-004). The region stays mounted even
 * when the message is empty, so the first update is still announced.
 * Wave 2 flows use this for every state change (saves, errors, steps).
 */
export function StatusRegion({ message, id, className }: StatusRegionProps) {
  return (
    <p
      id={id}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-status-region="true"
      className={className}
    >
      {message}
    </p>
  );
}
