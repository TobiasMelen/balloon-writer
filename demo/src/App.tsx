// The demo page: one full-screen <BalloonArea> that zooms to fit its text,
// starting with a word in it, focused so you can carry on typing.
import { Suspense, lazy, useState } from "react";
import { BalloonArea } from "balloon-writer";
import "./index.css";

/** ?sound shows the sound tuning panel, loaded only then (it brings leva). */
const SHOW_SOUND_PANEL = new URLSearchParams(location.search).has("sound");
const SoundPanel = lazy(() => import("./SoundPanel").then((m) => ({ default: m.SoundPanel })));

const INITIAL = "\nBalloons";

/** The caret at the end of the text, ready to type on. */
function caretAtEnd(field: HTMLTextAreaElement | null) {
  field?.setSelectionRange(field.value.length, field.value.length);
}

export function App() {
  const [soundOn, setSoundOn] = useState(true);
  return (
    <>
      <nav className="demo-corner">
        <button
          type="button"
          className="demo-sound"
          aria-label={soundOn ? "Turn sound off" : "Turn sound on"}
          aria-pressed={!soundOn}
          // Keep the text field focused, typing on.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSoundOn((on) => !on)}
        >
          {soundOn ? "🧑‍🎤" : "😢"}
        </button>
        <a className="demo-docs" href="docs.html">
          Docs &amp; examples
        </a>
      </nav>
      {SHOW_SOUND_PANEL && (
        <Suspense fallback={null}>
          <SoundPanel />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <BalloonArea
          ref={caretAtEnd}
          className="demo-area"
          containerClassName="demo-field"
          autoZoom
          wrap="off"
          autoFocus
          defaultValue={INITIAL}
          sound={soundOn ? "🧑‍🎤" : "😢"}
          aria-label="Balloon text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
        />
      </Suspense>
    </>
  );
}

export default App;
