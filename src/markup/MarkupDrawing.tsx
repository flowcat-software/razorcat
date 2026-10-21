// Every item of the edit's markup, drawn by the preview's own shapes, out of sight: what the
// export draws from (drawMarks.ts). The preview's layer holds only the playhead's markup.

import { useEffect, useMemo, useRef } from "react";
import type Konva from "konva";
import { Group, Layer, Stage } from "react-konva";
import { useDoc } from "../editor/docStore";
import { outputSize } from "../editor/frame";
import { registerDrawing } from "./drawMarks";
import { AnnotationShape } from "./MarkupLayer";
import { annotationOf, timelineStepLabels } from "./model/store";
import { DOC_VERSION, type Doc } from "./model/types";

/** The stage itself is a pixel: each item is drawn to a canvas of its own when exported. */
export function MarkupDrawing() {
  const marks = useDoc((s) => s.doc.marks);
  const frame = useDoc((s) => s.doc.frame);
  const group = useRef<Konva.Group>(null);
  useEffect(() => {
    registerDrawing(group.current);
    return () => registerDrawing(null);
  }, []);
  const doc = useMemo((): Doc => {
    const size = outputSize(frame);
    return {
      version: DOC_VERSION,
      source: size,
      crop: { x: 0, y: 0, ...size },
      annotations: marks.map((m) => annotationOf(m.id, m.object)),
    };
  }, [marks, frame]);
  // Numbered by where they start, which moving clips changes too.
  const edit = useDoc((s) => s.doc);
  const labels = useMemo(() => timelineStepLabels(edit), [edit]);
  return (
    <div style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} aria-hidden>
      <Stage width={1} height={1} listening={false}>
        <Layer>
          <Group ref={group}>
            {doc.annotations.map((a) => (
              <AnnotationShape key={a.id} a={a} hitSlop={0} label={labels[a.id]} />
            ))}
          </Group>
        </Layer>
      </Stage>
    </div>
  );
}
