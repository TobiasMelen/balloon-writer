// examples.html: BalloonArea and BalloonInput used like a textarea and an input,
// several on one page.
import { Suspense, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BalloonArea, BalloonInput } from "balloon-writer";

const box = { border: "2px solid #c9ccd2", borderRadius: 12, padding: 12, background: "#fafbfc", width: 520, fontSize: 40 } as const;

function Examples() {
  const [value, setValue] = useState("CONTROLLED");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, padding: 32, fontFamily: "system-ui" }}>
      <section>
        <h3>Soft wrap, scrolls (rows=4)</h3>
        <BalloonArea rows={4} defaultValue="WRAPS AT THE EDGE AND SCROLLS LIKE A TEXTAREA WHEN IT GETS LONG ENOUGH" style={box} />
      </section>
      <section>
        <h3>Controlled, with a ref</h3>
        <BalloonArea ref={ref} rows={2} value={value} onChange={(e) => setValue(e.target.value)} style={box} />
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
          <button onClick={() => setValue("")}>Clear</button>
          <button onClick={() => ref.current?.focus()}>Focus via ref</button>
          <span id="count">{value.length} characters</span>
        </div>
      </section>
      <section>
        <h3>BalloonInput</h3>
        <BalloonInput defaultValue="ONE LINE" placeholder="Type here" style={{ ...box, height: 120 }} />
      </section>
      <section>
        <h3>BalloonInput, autoZoom</h3>
        <BalloonInput autoZoom defaultValue="SHRINKS TO FIT" style={{ ...box, width: 360, height: 100, fontSize: 60 }} />
      </section>
      <section>
        <h3>Small, autoZoom</h3>
        <BalloonArea autoZoom wrap="off" defaultValue="ZOOM TO FIT ME" style={{ ...box, width: 260, height: 90, fontSize: 60, resize: "both" }} />
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <Suspense fallback={null}>
    <Examples />
  </Suspense>,
);
