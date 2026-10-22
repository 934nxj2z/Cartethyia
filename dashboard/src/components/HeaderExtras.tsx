import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The language switch and the donation button, in the console topbar.
 *
 * The language control is a placeholder on purpose: wiring it to a real
 * translation catalogue is a larger change than the button, and shipping the
 * catalogue half-done would leave the UI in two languages at once. It shows the
 * current locale and is inert until the catalogue lands.
 */

const DONATION_URL = "https://saweria.co/risuncode";

/** Locales the placeholder offers; only the first is actually applied. */
const LOCALES = [
  { id: "en", label: "EN", name: "English" },
  { id: "id", label: "ID", name: "Bahasa Indonesia" },
  { id: "zh", label: "中文", name: "简体中文" },
  { id: "ja", label: "日本語", name: "日本語" },
] as const;

function LanguageMenu() {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<string>("en");
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (container.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = LOCALES.find((entry) => entry.id === locale) ?? LOCALES[0];

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        className="topbar-icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change language"
        title="Change language (coming soon)"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-[11px] font-bold tracking-wide">{current.label}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="app-topbar-popover popout-enter glass rounded-sidebar border border-inner-border bg-popover-bg p-2 shadow-popout z-popover absolute right-0 top-full mt-2 min-w-44"
        >
          {LOCALES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              className="flex w-full items-center justify-between gap-3 rounded-inset px-3 py-2 text-left text-[13px] text-text-secondary hover:bg-hover-bg hover:text-text-primary"
              onClick={() => {
                setLocale(entry.id);
                setOpen(false);
              }}
            >
              <span>{entry.name}</span>
              {entry.id === locale ? <span className="text-accent-text">✓</span> : null}
            </button>
          ))}
          <p className="px-3 pb-1 pt-2 text-[11px] leading-snug text-text-tertiary">
            Translations are not wired up yet — the console stays in English for now.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DonationModal({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Support the project"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-overlay-bg"
        onClick={onClose}
      />
      <div className="popout-enter glass relative w-full max-w-md rounded-dialog border border-inner-border bg-popover-bg p-6 shadow-popout">
        <h2 className="text-base font-bold text-text-primary">Buy me a coffee ☕</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
          Cartethyia is built in the spare hours between everything else — late nights,
          weekends, and a suspicious number of energy drinks. If it saved you an
          afternoon of fighting with rate limits, or made your proxy pool behave, a
          coffee genuinely helps keep the lights on and the commits coming.
        </p>
        <img
          src="/donation/photo_2026-10-13_13-13-10.jpg"
          alt="A coffee for the maintainer"
          className="mt-4 w-full rounded-inset border border-inner-border object-cover"
        />
        <p className="mt-3 text-[12px] leading-relaxed text-text-tertiary">
          No obligation, no paywall, no nagging — the project stays free either way.
          Thank you for using it. 💙
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-inset px-3 py-2 text-[13px] text-text-secondary hover:bg-hover-bg hover:text-text-primary"
            onClick={onClose}
          >
            Maybe later
          </button>
          <a
            href={DONATION_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-inset bg-accent-bg px-4 py-2 text-[13px] font-semibold text-accent-text hover:opacity-90"
          >
            Donate via Saweria →
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The language switch and the donation button, for the console topbar. */
export function HeaderExtras() {
  const [donateOpen, setDonateOpen] = useState(false);

  return (
    <>
      <LanguageMenu />
      <button
        type="button"
        className="topbar-icon-button"
        aria-label="Support the project"
        title="Buy me a coffee"
        onClick={() => setDonateOpen(true)}
      >
        <span aria-hidden="true">☕</span>
      </button>
      {donateOpen ? <DonationModal onClose={() => setDonateOpen(false)} /> : null}
    </>
  );
}
