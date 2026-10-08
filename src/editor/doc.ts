// The edit document (PLAN §3): what the user makes of the source. One magnetic track of clips,
// each a stretch of the source's grid frames, butted together: the timeline is the clips in
// order, with no gaps. The preview and (Phase 2.5) the export both read it. Pure and immutable:
// every edit returns a new document (unchanged parts shared), which is what undo keeps
// (docStore.ts). The mockup's model (mockup/main.html), ported.

export type ClipId = number;

export interface Clip {
  /** Its number, for good: the timeline names it "Clip {id}". A split's left part keeps it. */
  id: ClipId;
  /** The first source grid frame shown. */
  in: number;
  /** The source grid frame after the last one shown (exclusive). */
  out: number;
}

export interface Doc {
  clips: readonly Clip[];
  /** The next clip's id. */
  nextId: ClipId;
}

/** A source `frames` long, whole: one clip. */
export function wholeSource(frames: number): Doc {
  return { clips: [{ id: 1, in: 0, out: frames }], nextId: 2 };
}

export const clipLength = (c: Clip) => c.out - c.in;

/** The timeline's length in frames. */
export const total = (doc: Doc) => doc.clips.reduce((n, c) => n + clipLength(c), 0);

/** Where each clip starts on the timeline. */
export function clipStarts(doc: Doc): number[] {
  let t = 0;
  return doc.clips.map((c) => {
    const s = t;
    t += clipLength(c);
    return s;
  });
}

/** The clip under timeline frame `f`: its index, and where it starts. */
export function clipAt(doc: Doc, f: number): { index: number; clip: Clip; start: number } | null {
  let start = 0;
  for (let index = 0; index < doc.clips.length; index++) {
    const clip = doc.clips[index];
    if (f >= start && f < start + clipLength(clip)) return { index, clip, start };
    start += clipLength(clip);
  }
  return null;
}

/** The frames where something starts or ends (cuts, and the timeline's ends), in order. */
export function editPoints(doc: Doc): number[] {
  return [...clipStarts(doc), total(doc)];
}

/**
 * Splits the clip under timeline frame `f` there: the second part is a new clip. Nothing to
 * split at a clip's first frame (it's already a cut) or past the end: the same document.
 */
export function split(doc: Doc, f: number): Doc {
  const at = clipAt(doc, f);
  if (!at || f === at.start) return doc;
  const cut = at.clip.in + (f - at.start);
  const clips = [...doc.clips];
  clips.splice(
    at.index,
    1,
    { ...at.clip, out: cut },
    { id: doc.nextId, in: cut, out: at.clip.out },
  );
  return { clips, nextId: doc.nextId + 1 };
}

/**
 * Deletes clip `id`; the clips after it close up (ripple). The last clip can't go: the same
 * document.
 */
export function deleteClip(doc: Doc, id: ClipId): Doc {
  if (doc.clips.length < 2 || !doc.clips.some((c) => c.id === id)) return doc;
  return { ...doc, clips: doc.clips.filter((c) => c.id !== id) };
}

/** Moves clip `id` to position `to` (clamped); the others close up around it. */
export function moveClip(doc: Doc, id: ClipId, to: number): Doc {
  const from = doc.clips.findIndex((c) => c.id === id);
  const at = Math.max(0, Math.min(doc.clips.length - 1, to));
  if (from < 0 || at === from) return doc;
  const clips = [...doc.clips];
  const [clip] = clips.splice(from, 1);
  clips.splice(at, 0, clip);
  return { ...doc, clips };
}
