// partytype/react: <BalloonArea> and <BalloonInput>, a drop-in
// <textarea> and text <input> whose text floats as foil balloons. They render
// the real field (className, style, ref and every other prop go to it) and
// attach the balloons to it (see balloons.ts), which load on demand.
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps, type Ref } from "react";
import { createBalloons, type BalloonOptions, type Balloons } from "./balloons";
import type { TextField } from "./measure";

export type { SadEmoji, SingingEmoji } from "./balloons";

type Options = BalloonOptions & {
  /** For the wrapper around the field and its canvas (sizing it, e.g.
   *  width: 100%, when the field fills it). */
  containerClassName?: string;
  containerStyle?: CSSProperties;
};
export type BalloonAreaProps = ComponentProps<"textarea"> & Options;
/** Text only: other input types have no text to draw. */
export type BalloonInputProps = Omit<ComponentProps<"input">, "type"> & Options;

/** A drop-in <textarea> whose text floats as foil balloons. */
export const BalloonArea = (props: BalloonAreaProps) => <Field {...(props as FieldProps)} tag="textarea" />;

/** A drop-in text <input> whose text floats as foil balloons. */
export const BalloonInput = (props: BalloonInputProps) => <Field {...(props as FieldProps)} tag="input" type="text" />;

type FieldProps = Omit<BalloonAreaProps, "ref"> & { ref?: Ref<TextField>; tag: "textarea" | "input"; type?: string };

function Field({ tag, autoZoom, sound, containerClassName, containerStyle, ref, spellCheck = false, ...props }: FieldProps) {
  const [field, setField] = useState<TextField | null>(null);
  const balloons = useRef<Balloons | null>(null);
  // A stable ref callback that also hands the field to the caller's ref.
  const forwarded = useRef(ref);
  forwarded.current = ref;
  const setRef = useMemo(
    () => (el: TextField | null) => {
      setField(el);
      const r = forwarded.current;
      if (typeof r === "function") r(el);
      else if (r) r.current = el;
    },
    [],
  );
  useLayoutEffect(() => {
    if (!field) return;
    const b = (balloons.current = createBalloons(field, { autoZoom, sound }));
    return () => b.destroy();
  }, [field]);
  useEffect(() => balloons.current?.setOptions({ autoZoom, sound }), [autoZoom, sound]);
  return (
    <div className={containerClassName} style={{ position: "relative", display: "inline-block", ...containerStyle }}>
      {createElement(tag, { ref: setRef, spellCheck, ...props, className: props.className ? `partytype ${props.className}` : "partytype" })}
    </div>
  );
}
