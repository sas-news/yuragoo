// Seat face icon (Task 40): a tiny friendly face inside the slot-colored
// disc replaces the "○A" text glyph — the player icon LOOKS like a face
// the creature could have. Slot identity moved onto the name pill, so the
// icon only needs to read as a person, not a letter.
export function IconFace() {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" focusable="false">
      {/* soft muzzle area */}
      <ellipse cx="12" cy="13" rx="8" ry="6.4" fill="rgba(255,255,255,0.35)" />
      {/* eyes */}
      <circle cx="8.6" cy="11.2" r="1.55" fill="#2f2a33" />
      <circle cx="15.4" cy="11.2" r="1.55" fill="#2f2a33" />
      <circle cx="9.1" cy="10.7" r="0.45" fill="#ffffff" />
      <circle cx="15.9" cy="10.7" r="0.45" fill="#ffffff" />
      {/* smile */}
      <path
        d="M 8.8 15.4 Q 12 18.2 15.2 15.4"
        stroke="#2f2a33"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
