// packages/lyricsync/web/src/components/Button.tsx
// WinForms-style flat button component conforming to SoulWindow design tokens.
import { type JSX, splitProps } from "solid-js";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger";
  size?: "compact" | "sm" | "xs" | "icon" | "icon-sm";
  loading?: boolean;
}

export function Button(props: ButtonProps) {
  const [, rest] = splitProps(props, ["variant", "size", "loading", "class", "children"]);

  const classes = () => {
    const list = ["win-button"];
    const v = props.variant ?? "default";
    if (v === "primary") list.push("primary");
    else if (v === "danger") list.push("ds-danger");

    const s = props.size ?? "compact";
    if (s === "compact") list.push("ds-btn-compact");
    else if (s === "sm") list.push("ds-btn-sm");
    else if (s === "xs") list.push("ds-btn-xs");
    else if (s === "icon") list.push("ds-btn-icon");
    else if (s === "icon-sm") list.push("ds-btn-icon-sm");

    if (props.loading) list.push("ds-btn-loading");
    if (props.class) list.push(props.class);
    return list.join(" ");
  };

  return (
    <button
      type="button"
      class={classes()}
      disabled={props.disabled || props.loading}
      aria-busy={props.loading ? "true" : undefined}
      {...rest}
    >
      {props.children}
    </button>
  );
}
