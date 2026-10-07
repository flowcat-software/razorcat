import { useEffect, useState } from "react";
import { commands, events } from "../shared/ipc";

// The main window. An empty shell until the layout lands (scaffold 0.1c); for now it shows the
// file it was asked to open, which Phase 1 will actually open.
export function EditorApp() {
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    // Listen first, then report ready: a file sent in between isn't lost.
    events.openFile
      .listen((e) => setFile(e.payload.path))
      .then((stop) => {
        // Unmounted meanwhile (StrictMode mounts twice): the next mount reports ready instead,
        // so the pending file isn't taken by a page that's gone.
        if (gone) {
          stop();
          return null;
        }
        unlisten = stop;
        return commands.editorReady();
      })
      .then((pending) => {
        if (pending && !gone) setFile(pending);
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  return (
    <main style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <p>Driveby</p>
      {file && <p>To open: {file}</p>}
    </main>
  );
}
