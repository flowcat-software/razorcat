// The camera's bubble (PLAN 5d.2; camera.rs): the camera, round, over what's being picked, left
// out of the recording. Dragged anywhere. Its pictures are ffmpeg's preview, read one after
// another from the media protocol (the camera opens to one program, and ffmpeg has it); if the
// camera stops, it says why.
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./camera.css";

const CAMERA = "http://media.localhost/camera";

const bubble = document.createElement("div");
bubble.className = "bubble";
const canvas = document.createElement("canvas");
const note = document.createElement("p");
note.className = "note";
bubble.append(canvas, note);
document.body.append(bubble);
const context = canvas.getContext("2d");

bubble.addEventListener("mousedown", (e) => {
  if (e.button === 0) void getCurrentWindow().startDragging();
});

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Says `text` over the bubble, or nothing. */
function say(text: string) {
  note.textContent = text;
  note.hidden = !text;
}

async function show() {
  let after = 0;
  say("Starting the camera…");
  for (;;) {
    try {
      const r = await fetch(`${CAMERA}/${after}`);
      if (r.status === 200) {
        after = Number(r.headers.get("x-frame")) || after + 1;
        const picture = await createImageBitmap(await r.blob());
        if (canvas.width !== picture.width) canvas.width = picture.width;
        if (canvas.height !== picture.height) canvas.height = picture.height;
        context?.drawImage(picture, 0, 0);
        picture.close();
        say("");
      } else if (r.status === 410) {
        say(await r.text());
        await pause(1000);
      }
    } catch (e) {
      console.error("[camera]", e);
      await pause(500);
    }
  }
}

void show();
