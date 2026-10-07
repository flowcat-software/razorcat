// 16px line icons for the settings sidebar. Stroke uses currentColor.
const props = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function GeneralIcon() {
  return (
    <svg {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="5.5" cy="4.5" r="1.4" fill="var(--bg-nav)" />
      <circle cx="10.5" cy="8" r="1.4" fill="var(--bg-nav)" />
      <circle cx="7" cy="11.5" r="1.4" fill="var(--bg-nav)" />
    </svg>
  );
}

export function AboutIcon() {
  return (
    <svg {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.2v3.6" />
      <circle cx="8" cy="5.1" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...props}>
      <circle cx="7" cy="7" r="4.3" />
      <path d="m10.3 10.3 3.2 3.2" />
    </svg>
  );
}
