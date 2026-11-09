/** The ROAI mark: three leaning bars. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      viewBox="20 40 370 300"
      width={size}
      height={Math.round(size * 0.82)}
      role="img"
      aria-label="ROAI logo"
      className="logo"
    >
      <path d="M45 214 149 194 127 298 23 318Z" className="logo-light" />
      <path d="M156 141 259 121 224 302 121 322Z" className="logo-mid" />
      <path d="M270 63 373 43 320 306 217 326Z" className="logo-deep" />
    </svg>
  );
}
