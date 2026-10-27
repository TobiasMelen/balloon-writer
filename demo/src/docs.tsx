// docs.html: how to use the package, each part with a live example.
import { Suspense, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BalloonArea, BalloonInput } from "balloon-writer/react";
import "./docs.css";

const box = { boxSizing: "border-box", border: "2px solid #c9ccd2", borderRadius: 12, padding: 12, background: "#fafbfc", width: "100%", fontSize: 40 } as const;
/** The field's wrapper is inline-block like a textarea; full width here. */
const wide = { display: "block" } as const;

/** A doc block: what it is, the code, and the thing itself. */
function Section({ title, children, code, demo }: { title: string; children: ReactNode; code: string; demo?: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
      <pre>
        <code>{code.trim()}</code>
      </pre>
      {demo && <div className="demo">{demo}</div>}
    </section>
  );
}

function Controlled() {
  const [value, setValue] = useState("CONTROLLED");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <BalloonArea ref={ref} rows={2} value={value} onChange={(e) => setValue(e.target.value)} containerStyle={wide} style={box} />
      <div className="row">
        <button onClick={() => setValue("")}>Clear</button>
        <button onClick={() => ref.current?.focus()}>Focus via ref</button>
        <span>{value.length} characters</span>
      </div>
    </>
  );
}

function Docs() {
  return (
    <main>
      <header>
        <h1>balloon-writer</h1>
        <a href="./">← Back to the demo</a>
      </header>
      <p className="lead">
        A drop-in React <code>&lt;textarea&gt;</code> and <code>&lt;input&gt;</code> whose text floats as physics-simulated foil
        balloons. Typing, selection, copy/paste and the keyboard work like a normal field.
      </p>

      <Section title="Install" code="npm install balloon-writer three">
        <p>three is a peer dependency. The React components need React 19.</p>
      </Section>

      <Section
        title="BalloonArea"
        code={`
import { Suspense } from "react";
import { BalloonArea } from "balloon-writer/react";

<Suspense fallback={null}>
  <BalloonArea rows={3} defaultValue="HELLO" style={{ fontSize: 40, padding: 12 }} />
</Suspense>`}
        demo={<BalloonArea rows={3} defaultValue="HELLO" containerStyle={wide} style={box} />}
      >
        <p>
          A <code>&lt;textarea&gt;</code>: it takes the same props, wraps and scrolls the same way, and is styled with{" "}
          <code>className</code> and <code>style</code> like one. It suspends while the balloons load, so render it inside{" "}
          <code>&lt;Suspense&gt;</code>.
        </p>
      </Section>

      <Section
        title="BalloonInput"
        code={`<BalloonInput defaultValue="ONE LINE" placeholder="Type here" />`}
        demo={<BalloonInput defaultValue="ONE LINE" placeholder="Type here" containerStyle={wide} style={{ ...box, height: 110 }} />}
      >
        <p>
          A single-line text <code>&lt;input&gt;</code>, otherwise the same.
        </p>
      </Section>

      <Section
        title="Controlled, with a ref"
        code={`
const [value, setValue] = useState("CONTROLLED");
const ref = useRef<HTMLTextAreaElement>(null);

<BalloonArea ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
<button onClick={() => setValue("")}>Clear</button>
<button onClick={() => ref.current?.focus()}>Focus via ref</button>`}
        demo={<Controlled />}
      >
        <p>
          <code>value</code>/<code>onChange</code> work as usual, and <code>ref</code> is the real element.
        </p>
      </Section>

      <Section
        title="autoZoom"
        code={`<BalloonInput autoZoom defaultValue="SHRINKS TO FIT" style={{ width: 360 }} />`}
        demo={<BalloonInput autoZoom defaultValue="SHRINKS TO FIT" style={{ ...box, width: 360, height: 100, fontSize: 60 }} />}
      >
        <p>Shrinks the text until it all fits, instead of scrolling. Type more to watch it zoom out.</p>
      </Section>

      <Section
        title="sound"
        code={`<BalloonArea sound="😢" />`}
        demo={<BalloonArea sound="😢" rows={2} defaultValue="QUIET" containerStyle={wide} style={box} />}
      >
        <p>
          The balloons squeak as they inflate and bang as they pop. The only way to turn that off is a sad emoji:{" "}
          <code>😢 😭 😞 😔 🙁 ☹️</code>. A singing one (<code>🧑‍🎤 🎤 🎶 🎵</code>, the default 🧑‍🎤) turns it back on.
        </p>
      </Section>

      <section>
        <h2>Props</h2>
        <p>All of a textarea's (or input's) props, plus:</p>
        <table>
          <tbody>
            <tr>
              <td>
                <code>autoZoom</code>
              </td>
              <td>
                <code>boolean</code>
              </td>
              <td>Shrink the text to fit instead of scrolling.</td>
            </tr>
            <tr>
              <td>
                <code>sound</code>
              </td>
              <td>
                <code>SingingEmoji | SadEmoji</code>
              </td>
              <td>Sounds on (default 🧑‍🎤) or off (a sad emoji).</td>
            </tr>
            <tr>
              <td>
                <code>containerClassName</code>, <code>containerStyle</code>
              </td>
              <td />
              <td>For the wrapper around the field and its canvas, e.g. to size it.</td>
            </tr>
          </tbody>
        </table>
        <p>Letters A–Z only for now (lowercase is drawn as uppercase); other characters leave a gap.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <Suspense fallback={null}>
    <Docs />
  </Suspense>,
);
