// packages/lyricsync/web/src/components/LcdDigits.tsx
// Seven-segment readout for the transport display: every cell draws all of its segments, unlit ones as faint "ghost"
// segments like a real VFD/LCD panel. Handles digits, "-", ":", "." and spaces; other characters render as plain text.
import { For, Index } from "solid-js";

type Seg = "a" | "b" | "c" | "d" | "e" | "f" | "g";

const SEGS: Seg[] = ["a", "b", "c", "d", "e", "f", "g"];

const LIT: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abdeg",
  "3": "abcdg",
  "4": "bcfg",
  "5": "acdfg",
  "6": "acdefg",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
  "—": "g",
  " ": "",
};

/** Hexagonal bar from (x1,y) to (x2,y), 2 units thick. */
const hBar = (x1: number, x2: number, y: number) => `${x1},${y} ${x1 + 1},${y - 1} ${x2 - 1},${y - 1} ${x2},${y} ${x2 - 1},${y + 1} ${x1 + 1},${y + 1}`;
/** Hexagonal bar from (x,y1) to (x,y2), 2 units thick. */
const vBar = (x: number, y1: number, y2: number) => `${x},${y1} ${x + 1},${y1 + 1} ${x + 1},${y2 - 1} ${x},${y2} ${x - 1},${y2 - 1} ${x - 1},${y1 + 1}`;

/** Segment outlines in a 12×20 cell. */
const SHAPE: Record<Seg, string> = {
  a: hBar(1.6, 10.4, 1),
  b: vBar(11, 1.6, 9.4),
  c: vBar(11, 10.6, 18.4),
  d: hBar(1.6, 10.4, 19),
  e: vBar(1, 10.6, 18.4),
  f: vBar(1, 1.6, 9.4),
  g: hBar(1.6, 10.4, 10),
};

function Digit(props: { ch: string }) {
  return (
    <svg class="daw-seg7" viewBox="0 0 12 20" aria-hidden="true">
      <For each={SEGS}>{(s) => <polygon points={SHAPE[s]} classList={{ "daw-seg7-on": (LIT[props.ch] ?? "").includes(s) }} />}</For>
    </svg>
  );
}

function Colon() {
  return (
    <svg class="daw-seg7 daw-seg7-narrow" viewBox="0 0 4 20" aria-hidden="true">
      <rect class="daw-seg7-on" x="1" y="5.5" width="2" height="2" />
      <rect class="daw-seg7-on" x="1" y="12.5" width="2" height="2" />
    </svg>
  );
}

function Dot() {
  return (
    <svg class="daw-seg7 daw-seg7-narrow" viewBox="0 0 4 20" aria-hidden="true">
      <rect class="daw-seg7-on" x="1" y="18" width="2" height="2" />
    </svg>
  );
}

export function LcdDigits(props: { text: string; class?: string }) {
  return (
    <span class={`daw-seg7-row ${props.class ?? ""}`} role="img" aria-label={props.text}>
      <Index each={[...props.text]}>
        {(ch) => <>{ch() === ":" ? <Colon /> : ch() === "." ? <Dot /> : ch() in LIT ? <Digit ch={ch()} /> : <span class="daw-seg7-text">{ch()}</span>}</>}
      </Index>
    </span>
  );
}
