import { useState, type ReactNode } from "react";
import { commands, type Settings } from "../shared/ipc";
import { canRedo, canUndo, useDoc } from "./docStore";
import { muteSound } from "./edits";
import { exportClip, exportClipsJoined, exportEach, exportEachOf, exportTimeline } from "./exports";
import { hint } from "../markup/HintLine";
import type { ControlHint } from "../markup/hints";
import { Menu, type MenuItems } from "./Menu";
import { useSqueeze } from "./squeeze";
import { useTool, type Tool } from "./toolStore";
import styles from "./EditorApp.module.css";

interface Props {
  /** No video yet: only Open works. */
  empty: boolean;
  /** An export is under way: another waits for it. */
  exporting: boolean;
  /** The video has sound: the menu's Sound toggle shows. */
  audio: boolean;
  /** For the menu's Save to default folder. */
  settings: Settings | null;
  onOpen: () => void;
  /** Add Video: a file on the end of the timeline (PLAN 4.5e). */
  onAdd: () => void;
  /** A screen recording is under way (PLAN 5b): Record stops it. */
  recording: boolean;
  /** Record the screen, or stop recording. */
  onRecord: () => void;
}

/**
 * The tools that work on the picture, by the mockup: crop and grow, then the markup tools in
 * Vandal's order, with its icons.
 */
const TOOLS: { id: Tool; label: string; icon: ReactNode }[] = [
  // Centred on 12 like the rest (it spans 4 to 20).
  { id: "select", label: "Select (V)", icon: <path d="M5 4l14 8-6 2-3 6z" /> },
  {
    id: "crop",
    label: "Crop (C)",
    icon: (
      <>
        <path d="M6 2v16h16" />
        <path d="M2 6h16v16" />
      </>
    ),
  },
  {
    id: "grow",
    label: "Grow the frame (G)",
    icon: (
      <>
        <rect x="7" y="7" width="10" height="10" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </>
    ),
  },
  {
    id: "pen",
    label: "Pen (P)",
    // Vandal's: a pen's nib.
    icon: (
      <>
        <path d="M4 20l1-4L16 5l3 3L8 19z" />
        <path d="M14 7l3 3" />
      </>
    ),
  },
  {
    id: "highlighter",
    label: "Highlighter (H)",
    // Vandal's: a marker's chisel tip.
    icon: (
      <>
        <path d="M9 15l-2 5h5l1-2" />
        <path d="M9 15l8-11 4 3-8 11z" />
      </>
    ),
  },
  { id: "line", label: "Line (/)", icon: <path d="M5 19L19 5" /> },
  { id: "arrow", label: "Arrow (A)", icon: <path d="M5 19L19 5M10 5h9v9" /> },
  {
    id: "rect",
    label: "Rectangle (B)",
    icon: <rect x="4" y="6" width="16" height="12" rx="1" />,
  },
  { id: "ellipse", label: "Ellipse (E)", icon: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" /> },
  { id: "text", label: "Text (T)", icon: <path d="M5 6V4h14v2M12 4v16M9 20h6" /> },
  {
    id: "callout",
    label: "Callout (Q)",
    // A box of text with a pointer down to the left.
    icon: (
      <>
        <rect x="9" y="3.5" width="12" height="9" rx="2" />
        <path d="M12 8h6M12.5 12.5L4 20.5" />
        <circle cx="4" cy="20.5" r="0.6" />
      </>
    ),
  },
  {
    id: "redact",
    label: "Redact (U)",
    // Vandal's: a box, half of it pixelated.
    icon: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M4 12h16M12 4v16" />
        <path d="M4.8 4.8h7.2v7.2H4.8zM12 12h7.2v7.2H12z" fill="currentColor" opacity="0.45" />
      </>
    ),
  },
  {
    id: "spotlight",
    label: "Spotlight (F)",
    // Vandal's: a bright circle in a darkened frame.
    icon: (
      <>
        <path
          d="M3 5h18v14H3zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"
          fill="currentColor"
          fillRule="evenodd"
          stroke="none"
          opacity="0.45"
        />
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="12" cy="12" r="4" />
      </>
    ),
  },
  {
    id: "step",
    label: "Step (N)",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M10.3 9.4L12.6 7.8v8.4" />
      </>
    ),
  },
  {
    id: "click",
    label: "Click (D)",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      </>
    ),
  },
];

/** The editor's top row: the picture's tools on the left, file actions on the right. */
export function CommandBar({
  empty,
  exporting,
  audio,
  settings,
  onOpen,
  onAdd,
  recording,
  onRecord,
}: Props) {
  const tool = useTool((s) => s.tool);
  /** Narrow windows: the buttons drop their labels one at a time, Record first, then Open, Add
   *  Video and Export (labels stay while they fit: Richard), then the tools close up (two steps). */
  const bar = useSqueeze(6);
  const undoable = useDoc(canUndo);
  const redoable = useDoc(canRedo);
  const selected = useDoc((s) => s.selected);
  const picked = useDoc((s) => s.selectedClips);
  const clips = useDoc((s) => s.doc.clips.length);
  const muted = useDoc((s) => s.doc.muted);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const noExport = empty || exporting;
  const saveToFolder = settings?.export.saveToFolder ?? false;
  // The Export button's menu (the mockup's).
  const items: MenuItems = [
    { label: "Timeline as MP4 (default)", hint: "Ctrl+E", run: () => exportTimeline("mp4") },
    { label: "Timeline as GIF", run: () => exportTimeline("gif") },
    ...(["mp4", "gif"] as const).flatMap((format): MenuItems => {
      const as = format.toUpperCase();
      return [
        "-",
        {
          label: `All clips as separate ${as}s`,
          disabled: clips < 2,
          run: () => exportEach(format),
        },
        // Several selected (PLAN 4.5f3): joined into one file, or a file each.
        ...(picked.length > 1
          ? [
              {
                label: `Selected clips as one ${as}`,
                run: () => exportClipsJoined(picked, format),
              },
              {
                label: `Selected clips as separate ${as}s`,
                run: () => exportEachOf(picked, format),
              },
            ]
          : [
              {
                label: `Selected clip as ${as}`,
                disabled: selected === null,
                run: () => selected !== null && exportClip(selected, format),
              },
            ]),
      ];
    }),
    "-",
    // The track's mute, here too, so a silent export isn't a surprise.
    ...(audio
      ? [
          {
            label: "Sound",
            hint: "Shift+M",
            checked: !muted,
            title: "Off, the export has no sound (and the preview is muted)",
            run: muteSound,
          },
        ]
      : []),
    {
      label: "Save to default folder",
      checked: saveToFolder,
      title:
        "No Save dialog: files go to the folder in Settings › Export, named from its templates",
      run: () => {
        if (!settings) return;
        void commands.updateSettings({
          ...settings,
          export: { ...settings.export, saveToFolder: !saveToFolder },
        });
      },
    },
    { label: "Export settings…", run: () => void commands.openSettings("export") },
  ];
  return (
    <div ref={bar} className={styles.commandBar}>
      <div className={styles.tools}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={styles.tool}
            aria-label={t.label}
            aria-pressed={!empty && t.id === tool}
            title={t.label}
            {...hint(`tool.${t.id}` as ControlHint)}
            disabled={empty}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => useTool.getState().setTool(t.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              {t.icon}
            </svg>
          </button>
        ))}
        <span className={styles.toolbarDivider} />
        <button
          type="button"
          className={styles.tool}
          aria-label="Undo (Ctrl+Z)"
          title="Undo (Ctrl+Z)"
          {...hint("undo")}
          disabled={empty || !undoable}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useDoc.getState().undo()}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Redo (Ctrl+Y)"
          title="Redo (Ctrl+Y)"
          {...hint("redo")}
          disabled={empty || !redoable}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useDoc.getState().redo()}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M15 14l5-5-5-5" />
            <path d="M20 9H9a5 5 0 0 0 0 10h3" />
          </svg>
        </button>
      </div>
      <span className={styles.spacer} />
      <button
        type="button"
        className={`${styles.button} ${styles.squeeze1}`}
        aria-label={recording ? "Stop recording" : "Record the screen"}
        title={recording ? "Stop recording and open it" : "Record the screen this window is on"}
        {...hint(recording ? "recordStop" : "record")}
        onClick={onRecord}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          {recording ? (
            <rect x="7" y="7" width="10" height="10" rx="2" fill="#e5484d" stroke="none" />
          ) : (
            <>
              <circle cx="12" cy="12" r="8" />
              <circle cx="12" cy="12" r="3.5" fill="#e5484d" stroke="none" />
            </>
          )}
        </svg>
        <span className={styles.label}>{recording ? "Stop" : "Record"}</span>
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.squeeze2}`}
        aria-label="Open (Ctrl+O)"
        title="Open (Ctrl+O)"
        {...hint("open")}
        onClick={onOpen}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className={styles.label}>Open</span>
      </button>
      {!empty && (
        <button
          type="button"
          className={`${styles.button} ${styles.squeeze3}`}
          aria-label="Add Video (Ctrl+Shift+O)"
          title="Add a video to the end of the timeline (Ctrl+Shift+O)"
          {...hint("addVideo")}
          onClick={onAdd}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M12 9v6M9 12h6" />
          </svg>
          <span className={styles.label}>Add Video</span>
        </button>
      )}
      <div className={styles.split}>
        <button
          type="button"
          className={`${styles.splitMain} ${styles.squeeze4}`}
          aria-label="Export the timeline as MP4 (Ctrl+E)"
          title={exporting ? "An export is under way" : "Export the timeline as MP4 (Ctrl+E)"}
          {...hint("export")}
          disabled={noExport}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exportTimeline("mp4")}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
          <span className={styles.label}>Export</span>
        </button>
        <button
          type="button"
          className={styles.splitMore}
          aria-label="Export options"
          title="Export options"
          {...hint("exportMenu")}
          aria-expanded={menu !== null}
          disabled={noExport}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            if (menu) return setMenu(null);
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 260, y: r.bottom + 4 });
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {menu && <Menu items={items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
