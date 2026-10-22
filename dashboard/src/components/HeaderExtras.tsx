import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Coffee, ExternalLink, Heart, Languages, Sparkles, Star, X } from "lucide-react";

/**
 * The language switch and the donation button, in the console topbar.
 *
 * The language control is a placeholder on purpose: wiring it to a real
 * translation catalogue is a larger change than the button, and shipping the
 * catalogue half-done would leave the UI in two languages at once. It shows the
 * current locale and is inert until the catalogue lands.
 */

const DONATION_URL = "https://saweria.co/risuncode";
const REPOSITORY_URL = "https://github.com/risunCode/cartethyia";

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
        <Languages size={14} aria-hidden="true" />
        <span className="text-[11px] font-bold tracking-wide">{current.label}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="app-topbar-popover popout-enter glass absolute right-0 top-full z-popover mt-2 min-w-44 rounded-sidebar border border-inner-border bg-popover-bg p-2 shadow-popout"
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

/**
 * The donation dialog.
 *
 * A bottom sheet on a phone and a centred card from `sm` up: a fixed-height
 * dialog does not fit a short viewport, and the panel scrolls rather than
 * clipping the image and the buttons off the bottom.
 */
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
      className="fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4"
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
      <div className="popout-enter glass relative flex max-h-[92vh] w-full flex-col overflow-y-auto rounded-t-dialog border border-inner-border bg-popover-bg shadow-popout sm:max-w-md sm:rounded-dialog">
        <button
          type="button"
          aria-label="Close"
          className="absolute right-3 top-3 rounded-inset p-1.5 text-text-tertiary hover:bg-hover-bg hover:text-text-primary"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        <div className="px-5 pb-6 pt-6 sm:px-6">
          <div className="flex items-center gap-2">
            <Coffee size={18} className="text-accent-text" aria-hidden="true" />
            <h2 className="text-base font-bold text-text-primary">Buy me a coffee</h2>
          </div>

          <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
            Cartethyia is built in the spare hours between everything else — late
            nights, weekends, and a suspicious number of energy drinks. If it saved
            you an afternoon of fighting with rate limits, or made your proxy pool
            behave, a coffee genuinely helps keep the lights on and the commits
            coming.
          </p>

          <img
            src="/donation/photo_2026-10-13_13-13-10.jpg"
            alt="A coffee for the maintainer"
            className="mt-4 w-full rounded-inset border border-inner-border object-cover"
          />

          <ul className="mt-4 flex flex-col gap-2 text-[12px] text-text-secondary">
            <li className="flex items-start gap-2">
              <Sparkles size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
              <span>Keeps late-night debugging sessions fuelled.</span>
            </li>
            <li className="flex items-start gap-2">
              <Heart size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
              <span>Funds the coffee that funds the next release.</span>
            </li>
          </ul>

          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <a
              href={DONATION_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center justify-center gap-2 rounded-inset bg-accent-bg px-4 py-2.5 text-[13px] font-semibold text-accent-text hover:opacity-90"
            >
              <Coffee size={14} aria-hidden="true" />
              Donate via Saweria
              <ExternalLink size={12} aria-hidden="true" />
            </a>
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center justify-center gap-2 rounded-inset border border-inner-border px-4 py-2.5 text-[13px] text-text-secondary hover:bg-hover-bg hover:text-text-primary"
            >
              <Star size={14} aria-hidden="true" />
              Star the repo
            </a>
          </div>

          <p className="mt-3 text-center text-[11px] leading-relaxed text-text-tertiary">
            No obligation, no paywall, no nagging — the project stays free either way.
            Thank you for using it. 💙
          </p>
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
        <Coffee size={14} aria-hidden="true" />
      </button>
      {donateOpen ? <DonationModal onClose={() => setDonateOpen(false)} /> : null}
    </>
  );
}
