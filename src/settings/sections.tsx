// What the settings window shows (see schema.ts). Razorcat's own settings arrive with the
// features that use them.
import { commands } from "../shared/ipc";
import {
  AboutIcon,
  EditingIcon,
  ExportIcon,
  GeneralIcon,
  MarkupIcon,
  ProxiesIcon,
  RecordIcon,
  TimelineIcon,
} from "./icons";
import type { Section } from "./schema";

export const sections: Section[] = [
  {
    id: "general",
    title: "General",
    icon: GeneralIcon,
    description: "How the app looks.",
    groups: [
      {
        title: "Appearance",
        items: [
          {
            id: "theme",
            kind: "choice",
            path: "appearance.theme",
            label: "Theme",
            options: [
              { value: "system", label: "Follow Windows" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ],
            keywords: ["dark mode", "light mode", "color", "theme", "appearance", "night"],
          },
          {
            id: "accent",
            kind: "accent",
            path: "appearance.accent",
            label: "Accent color",
            description:
              "Used for selected buttons and the Export button. Follows your Windows accent color unless you pick one.",
            keywords: ["accent", "color", "colour", "highlight", "theme", "windows"],
          },
        ],
      },
      {
        title: "Status bar",
        items: [
          {
            id: "scrollHints",
            kind: "toggle",
            path: "appearance.scrollHints",
            label: "Scroll long hints",
            description:
              "When a hint is too long for the status bar, rest the pointer for a moment and it glides along to show the rest.",
            keywords: ["hint", "status bar", "scroll", "marquee", "motion", "animation", "cut off"],
          },
        ],
      },
    ],
  },
  {
    id: "timeline",
    title: "Timeline",
    icon: TimelineIcon,
    description: "What the timeline shows, and how ranges and markup take edits.",
    groups: [
      {
        title: "Clips",
        items: [
          {
            id: "thumbnails",
            kind: "toggle",
            path: "timeline.thumbnails",
            label: "Show thumbnails",
            description: "Pictures from the video along each clip.",
            disabled: (s) => !s.proxies.enabled,
            note: (s) =>
              s.proxies.enabled
                ? undefined
                : "Thumbnails are made from proxies: turn on Proxies › Use proxies to show them.",
            keywords: ["thumbnails", "pictures", "frames", "filmstrip", "clip", "timeline"],
          },
          {
            id: "waveform",
            kind: "toggle",
            path: "timeline.waveform",
            label: "Show waveform",
            description: "How loud the audio is along each clip, all its tracks together.",
            keywords: ["waveform", "audio", "sound", "volume", "loud", "clip", "timeline"],
          },
        ],
      },
      {
        title: "Ranges and markup",
        items: [
          {
            id: "rangesFollowVideo",
            kind: "toggle",
            path: "timeline.rangesFollowVideo",
            label: "Ranges and markup follow their video",
            description:
              "When clips are trimmed, deleted or moved, ranges and markup stay on the frames they're on. Off: they stay at their place on the timeline.",
            keywords: [
              "ranges",
              "markup",
              "text",
              "follow",
              "anchor",
              "stay",
              "move",
              "trim",
              "timeline",
            ],
          },
          {
            id: "deleteRangesWithClip",
            kind: "toggle",
            path: "timeline.deleteRangesWithClip",
            label: "Deleting a clip deletes its ranges and markup",
            description: "Off: they're kept, hidden, and come back if the clip does.",
            keywords: ["ranges", "markup", "text", "delete", "clip", "remove", "timeline"],
          },
          {
            id: "splitMarkup",
            kind: "toggle",
            path: "timeline.splitMarkup",
            label: "Splitting a clip splits the markup over the cut",
            description:
              "Each part then goes with its own clip. Removing or keeping ranges cuts it the same way. Off: it stays whole, on the clip under its start.",
            keywords: ["markup", "text", "split", "cut", "clip", "ranges", "timeline"],
          },
          {
            id: "fadeSplitMarkup",
            kind: "toggle",
            path: "timeline.fadeSplitMarkup",
            label: "Split markup fades at the cut",
            description:
              "When the markup is split, the part before the cut fades out there and the part after fades in, as the whole did at its ends. Off: the cut is clean.",
            keywords: ["markup", "text", "split", "cut", "fade", "clip", "ranges", "timeline"],
          },
          {
            id: "defaultMarkupFade",
            kind: "number",
            path: "timeline.defaultMarkupFade",
            label: "Default fade",
            description:
              "What Apply Default Fades gives markup (right-click a markup bar on the timeline: on its middle, both ends; on an edge, that end). A short item gets as much as fits.",
            min: 1,
            max: 300,
            unit: "frames",
            keywords: ["markup", "fade", "default", "in", "out", "length", "frames", "timeline"],
          },
          {
            id: "copiesKeepFades",
            kind: "toggle",
            path: "timeline.copiesKeepFades",
            label: "Copies keep their fades",
            description:
              "Markup and clips duplicated (Ctrl+D), Alt-dragged or pasted fade as the original does. Off: copies start without fades.",
            keywords: [
              "markup",
              "clip",
              "fade",
              "copy",
              "duplicate",
              "paste",
              "alt",
              "drag",
              "timeline",
            ],
          },
        ],
      },
      {
        title: "Clip fades",
        items: [
          {
            id: "defaultClipFade",
            kind: "number",
            path: "timeline.defaultClipFade",
            label: "Default clip fade",
            description:
              "What Apply Default Fades gives clips, from and to black (right-click a clip on the timeline: on its middle, both ends; on an edge or fade handle, that end). A short clip gets as much as fits.",
            min: 1,
            max: 300,
            unit: "frames",
            keywords: ["clip", "fade", "black", "default", "in", "out", "length", "frames"],
          },
          {
            id: "fadeSplitClips",
            kind: "toggle",
            path: "timeline.fadeSplitClips",
            label: "Split clip fades at the cut",
            description:
              "When a clip is split, the part before the cut fades out there and the part after fades in, as the whole did at its ends. Off: the cut is clean.",
            keywords: ["clip", "fade", "black", "split", "cut", "ranges", "timeline"],
          },
        ],
      },
      {
        title: "Clip speed",
        items: [
          {
            id: "markupStretchesWithSpeed",
            kind: "toggle",
            path: "timeline.markupStretchesWithSpeed",
            label: "Markup stretches with the clip's speed",
            description:
              "Slowing a clip down makes the markup on it last longer, and its fades too; speeding it up, shorter. Off: markup keeps its length and starts on the same frame of the video.",
            disabled: (s) => !s.timeline.rangesFollowVideo,
            note: (s) =>
              s.timeline.rangesFollowVideo
                ? undefined
                : "Markup stays at its place on the timeline: turn on Ranges and markup follow their video to use this.",
            keywords: ["speed", "slow", "fast", "markup", "text", "stretch", "length", "clip"],
          },
          {
            id: "keepPitch",
            kind: "toggle",
            path: "timeline.keepPitch",
            label: "Keep the sound's pitch",
            description:
              "A clip sped up or slowed down sounds at its own pitch, in the preview and the export. Off: faster sounds higher and slower lower, as a tape does.",
            keywords: ["speed", "slow", "fast", "pitch", "audio", "sound", "tape", "chipmunk"],
          },
        ],
      },
    ],
  },
  {
    id: "editing",
    title: "Editing",
    icon: EditingIcon,
    description: "Editing the picture: crop, and the space grown round it.",
    groups: [
      {
        title: "Grow presets",
        items: [
          {
            id: "growPresets",
            kind: "growPresets",
            path: "editing.growPresets",
            label: "Grow presets",
            description:
              "Shown in the grow tool's options bar. Each side in px, or in % of the picture as cropped (its height for top and bottom, its width for left and right), so a preset fits any video. Save new ones from the options bar.",
            keywords: [
              "grow",
              "preset",
              "meme",
              "caption",
              "bars",
              "padding",
              "border",
              "colour",
              "color",
            ],
          },
        ],
      },
      {
        title: "Number fields",
        items: [
          {
            id: "numberDragSpeed",
            kind: "choice",
            path: "editing.numberDragSpeed",
            label: "Number drag speed",
            description:
              "How fast a value changes when you drag a number field left or right. Slower gives finer control; hold Shift for 10× faster.",
            options: [
              { value: "verySlow", label: "Very slow" },
              { value: "slow", label: "Slow" },
              { value: "normal", label: "Normal" },
              { value: "fast", label: "Fast" },
              { value: "veryFast", label: "Very fast" },
            ],
            keywords: ["drag", "speed", "number", "field", "scrub", "sensitivity", "crop", "grow"],
          },
        ],
      },
    ],
  },
  {
    id: "markup",
    title: "Markup",
    icon: MarkupIcon,
    description: "The markup tools (Vandal's): how they behave, and the styles they offer.",
    groups: [
      {
        title: "Behavior",
        items: [
          {
            id: "markup-drawing-tools-select",
            kind: "toggle",
            path: "markup.drawingToolsSelect",
            label: "Drawing tools select objects under the pointer",
            description:
              "Off: drawing tools always draw, even over other markup, and you select with the Select tool. Hold Ctrl to do the opposite for one click.",
            keywords: ["draw over", "click", "select", "move", "ctrl", "overlap", "text"],
          },
          {
            id: "markup-share-color",
            kind: "toggle",
            path: "markup.shareColor",
            label: "All tools use the same color",
            description:
              "Picking a color for one tool picks it for the others too (except tools with their own palette, like the highlighter). Off: each tool keeps its own color.",
            keywords: ["color", "colour", "shared", "same", "sync", "palette"],
          },
          {
            id: "markup-remember-tool-styles",
            kind: "toggle",
            path: "markup.rememberToolStyles",
            label: "Remember tool styles",
            description:
              "The tools start with the colors, widths, fonts and other options you last used, even after a restart. Off: they start from the defaults.",
            keywords: [
              "remember",
              "keep",
              "persist",
              "restore",
              "defaults",
              "color",
              "width",
              "font",
            ],
          },
          {
            id: "markup-shortcut-hints",
            kind: "toggle",
            path: "markup.showShortcutHints",
            label: "Show shortcut hints on the pickers",
            description:
              "Slot numbers on the widths, sizes, colors and fonts while you hold a number key, Ctrl or Alt, and the keys in their tooltips. The shortcuts work either way.",
            keywords: ["shortcut", "hint", "badge", "number", "keyboard", "tooltip", "digit"],
          },
          {
            id: "markup-button-units",
            kind: "toggle",
            path: "markup.showButtonUnits",
            label: "Show units on number buttons",
            description:
              'Buttons for sizes and darkness show their unit after the number, like "50%" or "10px". Off keeps them shorter.',
            keywords: ["unit", "units", "px", "percent", "pt", "button", "number", "label"],
          },
        ],
      },
      {
        title: "Colors",
        items: [
          {
            id: "styles-palette",
            kind: "palette",
            path: "styles.palette",
            label: "Color presets",
            description:
              "The colors the tools offer, in order. Ctrl+1–9 pick the first nine. Click a color to change or remove it; drag it to reorder.",
            keywords: ["color", "colour", "palette", "preset", "swatch", "reorder"],
          },
          {
            id: "styles-color-control",
            kind: "choice",
            path: "styles.colorControl",
            label: "Show colors as",
            description:
              "Swatches show every color in the options bar. A dropdown takes less room: a button per color that opens the palette. The keys work the same either way. A tool can have its own choice under Per-tool styles.",
            options: [
              { value: "swatches", label: "Swatches" },
              { value: "dropdown", label: "Dropdown" },
            ],
            keywords: ["color", "colour", "swatch", "dropdown", "menu", "compact", "toolbar"],
          },
        ],
      },
      {
        title: "Line width",
        items: [
          {
            id: "styles-width",
            kind: "numberPicker",
            path: "styles.width",
            label: "Width choices",
            description:
              "The widths the drawing tools offer, in pixels. Keys 1–9 and 0 pick them while you draw.",
            unit: "px",
            lines: true,
            keywords: [
              "line",
              "width",
              "thickness",
              "stroke",
              "size",
              "picker",
              "slider",
              "buttons",
            ],
          },
        ],
      },
      {
        title: "Text",
        items: [
          {
            id: "styles-fonts",
            kind: "fontPicker",
            path: "styles.font",
            label: "Fonts",
            description:
              "The fonts the text tool offers. With a custom list, Alt+1–9 and Alt+0 pick them while you type.",
            keywords: ["font", "typeface", "family", "text", "list", "installed"],
          },
          {
            id: "styles-font-size",
            kind: "numberPicker",
            path: "styles.fontSize",
            label: "Font sizes",
            description: "The sizes the text tool offers, in points. Keys 1–9 and 0 pick them.",
            unit: "pt",
            keywords: ["font", "size", "text", "points", "pt", "picker"],
          },
        ],
      },
      {
        title: "Redact",
        items: [
          {
            id: "styles-pixelate",
            kind: "numberPicker",
            path: "styles.pixelate",
            label: "Pixelate block sizes",
            description:
              "The block sizes the redact tool offers for Pixelate, in pixels. Bigger blocks hide more. Keys 1–9 and 0 pick them while you draw.",
            unit: "px",
            keywords: ["redact", "pixelate", "mosaic", "block", "strength", "hide", "censor"],
            warnBelow: {
              value: 6,
              message:
                "Blocks under 6 px may not hide text: some tools can read pixelated text back. Cover passwords and other secrets with a filled rectangle.",
            },
          },
          {
            id: "styles-blur",
            kind: "numberPicker",
            path: "styles.blur",
            label: "Blur strengths",
            description:
              "The blur radii the redact tool offers for Blur, in pixels. A bigger radius hides more. Keys 1–9 and 0 pick them while you draw.",
            unit: "px",
            keywords: ["redact", "blur", "radius", "strength", "hide", "censor"],
            warnBelow: {
              value: 3,
              message:
                "A blur under 3 px may not hide text: some tools can read blurred text back. Cover passwords and other secrets with a filled rectangle.",
            },
          },
        ],
      },
      {
        title: "Spotlight",
        items: [
          {
            id: "styles-spotlight",
            kind: "numberPicker",
            path: "styles.spotlight",
            label: "Darkness choices",
            description:
              "How dark the spotlight tool makes everything outside it, in percent. Keys 1–9 and 0 pick them while you draw. Values above 100 are lowered to 100.",
            unit: "%",
            keywords: ["spotlight", "dim", "darken", "darkness", "opacity", "focus", "highlight"],
          },
        ],
      },
      {
        title: "Rounded corners",
        items: [
          {
            id: "styles-corner-radius",
            kind: "numberPicker",
            path: "styles.cornerRadius",
            label: "Corner radius choices",
            description:
              "The corner radii the rectangle and the spotlight's rectangle offer, in pixels. 0 (square corners) is always one of them. Alt+1–9 and Alt+0 pick them while you draw.",
            unit: "px",
            zero: true,
            noButtons: true,
            keywords: ["corner", "round", "rounded", "radius", "rectangle", "spotlight", "square"],
          },
        ],
      },
      {
        title: "Step markers",
        items: [
          {
            id: "styles-step-size",
            kind: "numberPicker",
            path: "styles.stepSize",
            label: "Marker sizes",
            description:
              "The sizes the step tool offers, in pixels across. Keys 1–9 and 0 pick them while you place markers.",
            unit: "px",
            keywords: ["step", "marker", "number", "numbered", "size", "badge", "counter"],
          },
          {
            id: "styles-step-fonts",
            kind: "fontPicker",
            path: "styles.stepFont",
            label: "Marker fonts",
            description:
              "The fonts the step tool offers for its labels. Same as Text tool uses the fonts chosen above. With a custom list, Alt+1–9 and Alt+0 pick them.",
            keywords: ["step", "marker", "font", "typeface", "label", "number", "text"],
          },
        ],
      },
      {
        title: "Per-tool styles",
        description:
          "Give a tool its own colors, widths or way of showing colors instead of the ones above. The highlighter comes with its own colors.",
        items: [
          {
            id: "tool-style-pen",
            kind: "toolStyle",
            tool: "pen",
            label: "Pen",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "width"],
          },
          {
            id: "tool-style-highlighter",
            kind: "toolStyle",
            tool: "highlighter",
            label: "Highlighter",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "width"],
          },
          {
            id: "tool-style-line",
            kind: "toolStyle",
            tool: "line",
            label: "Line",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "width"],
          },
          {
            id: "tool-style-arrow",
            kind: "toolStyle",
            tool: "arrow",
            label: "Arrow",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "width"],
          },
          {
            id: "tool-style-rect",
            kind: "toolStyle",
            tool: "rect",
            label: "Rectangle",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "width"],
          },
          {
            id: "tool-style-ellipse",
            kind: "toolStyle",
            tool: "ellipse",
            label: "Ellipse",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "width"],
          },
          {
            id: "tool-style-text",
            kind: "toolStyle",
            tool: "text",
            label: "Text",
            widths: false,
            keywords: ["own", "custom", "override", "per tool", "palette", "color"],
          },
          {
            id: "tool-style-callout",
            kind: "toolStyle",
            tool: "callout",
            label: "Callout",
            widths: true,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "pointer"],
          },
          {
            id: "tool-style-step",
            kind: "toolStyle",
            tool: "step",
            label: "Step markers",
            widths: false,
            keywords: ["own", "custom", "override", "per tool", "palette", "color", "marker"],
          },
        ],
      },
    ],
  },
  {
    id: "export",
    title: "Export",
    icon: ExportIcon,
    description: "Where exported files go, what they're called, and how GIFs come out.",
    groups: [
      {
        title: "Files",
        items: [
          {
            id: "saveToFolder",
            kind: "toggle",
            path: "export.saveToFolder",
            label: "Save to the default folder",
            description:
              "Export without the Save dialog: files go to the folder below, named as below. Also in the Export button's menu.",
            keywords: ["save", "default", "folder", "dialog", "export", "quick"],
          },
          {
            id: "exportFolder",
            kind: "folder",
            path: "export.folder",
            label: "Default folder",
            description: "Where exports go with Save to the default folder on.",
            defaultFolder: commands.defaultExportFolder,
            showSize: true,
            keywords: ["folder", "export", "save", "location", "path"],
          },
          {
            id: "timelineName",
            kind: "text",
            path: "export.timelineName",
            label: "Timeline file name",
            description:
              "The whole timeline's export; the Save dialog suggests it too. See Tag reference for the tags, such as {name} and {nn}.",
            placeholder: "{name}-edit-{nn}",
            tags: true,
            preview: (template) => commands.previewExportName(template, false),
            keywords: [
              "name",
              "file name",
              "template",
              "timeline",
              "export",
              "date",
              "time",
              "number",
              "counter",
            ],
          },
          {
            id: "clipName",
            kind: "text",
            path: "export.clipName",
            label: "Clip file names",
            description:
              "Each clip's own file, when clips are exported one by one. See Tag reference for the tags, such as {name} and {cc}.",
            placeholder: "{name}-clip-{cc}",
            tags: true,
            preview: (template) => commands.previewExportName(template, true),
            keywords: [
              "name",
              "file name",
              "template",
              "clip",
              "number",
              "export",
              "date",
              "time",
              "counter",
            ],
          },
        ],
      },
      {
        title: "GIF",
        items: [
          {
            id: "gifFps",
            kind: "numberChoice",
            path: "export.gifFps",
            label: "Frame rate",
            description:
              "GIF frames last whole hundredths of a second, so these rates play exactly. Lower is smaller.",
            options: [
              { value: 10, label: "10" },
              { value: 20, label: "20" },
              { value: 25, label: "25" },
              { value: 50, label: "50" },
            ],
            keywords: ["gif", "fps", "frame rate", "speed", "smooth", "export"],
          },
          {
            id: "gifSize",
            kind: "numberChoice",
            path: "export.gifSize",
            label: "Size",
            description:
              "The longer side, in pixels; never larger than the video. GIFs of motion get big fast: smaller is much smaller.",
            options: [
              { value: 320, label: "320" },
              { value: 480, label: "480" },
              { value: 640, label: "640" },
              { value: 800, label: "800" },
              { value: 0, label: "Original" },
            ],
            keywords: ["gif", "size", "width", "height", "resolution", "pixels", "export"],
          },
        ],
      },
    ],
  },
  {
    id: "recording",
    title: "Recording",
    icon: RecordIcon,
    description:
      "Where screen recordings go, the sound they take, and how an area looks while it records.",
    groups: [
      {
        title: "Files",
        items: [
          {
            id: "recordingFolder",
            kind: "folder",
            path: "recording.folder",
            label: "Folder",
            description:
              "Where screen recordings are saved, named by the date and time they were made. They open in Razorcat when you stop.",
            defaultFolder: commands.defaultRecordingFolder,
            showSize: true,
            keywords: ["recording", "record", "screen", "capture", "folder", "location", "path"],
          },
        ],
      },
      {
        title: "Video",
        items: [
          {
            id: "recordingCursor",
            kind: "toggle",
            path: "recording.cursor",
            label: "Show the pointer",
            description: "The mouse pointer is in the recording.",
            keywords: ["pointer", "cursor", "mouse", "arrow", "hide"],
          },
          {
            id: "recordingFps",
            kind: "numberChoice",
            path: "recording.fps",
            label: "Frame rate",
            description: "60 is smoother for scrolling and moving windows; 30 makes smaller files.",
            options: [
              { value: 30, label: "30 fps" },
              { value: 60, label: "60 fps" },
            ],
            keywords: ["fps", "frame rate", "frames", "smooth", "size"],
          },
          {
            id: "recordingCountdown",
            kind: "numberChoice",
            path: "recording.countdown",
            label: "Countdown",
            description:
              "Seconds counted down before recording starts, over what's to be recorded. Stop cancels it.",
            options: [
              { value: 0, label: "Off" },
              { value: 3, label: "3 s" },
              { value: 5, label: "5 s" },
              { value: 10, label: "10 s" },
            ],
            keywords: ["countdown", "delay", "timer", "wait", "start"],
          },
        ],
      },
      {
        title: "Sound",
        items: [
          {
            id: "recordingMicrophone",
            kind: "toggle",
            path: "recording.microphone",
            label: "Record the microphone",
            description:
              "Your voice, for narration. Also turned on or off as you record: the microphone button by Record, or M.",
            keywords: ["microphone", "mic", "voice", "sound", "audio", "narration", "record"],
          },
          {
            id: "recordingMicrophoneDevice",
            kind: "microphone",
            path: "recording.microphoneDevice",
            label: "Microphone",
            description: "The default follows Windows' choice.",
            disabled: (s) => !s.recording.microphone,
            keywords: ["microphone", "mic", "device", "input", "headset", "audio"],
          },
          {
            id: "recordingSystemSound",
            kind: "toggle",
            path: "recording.systemSound",
            label: "Record system sound",
            description:
              "What the computer plays: videos, calls, alerts. Mixed with the microphone into one track. Also turned on or off as you record: the speaker button by Record, or S.",
            keywords: ["system", "sound", "audio", "speaker", "desktop", "loopback", "computer"],
          },
        ],
      },
      {
        title: "Clicks and keys",
        items: [
          {
            id: "recordingClicks",
            kind: "toggle",
            path: "recording.clicks",
            label: "Note clicks",
            description:
              "Where you click, to show on the timeline as markup you can move, restyle or delete. Also turned on or off as you record: the control's button, or Ctrl+Alt+C.",
            keywords: ["clicks", "mouse", "pointer", "show clicks", "highlight", "tutorial"],
          },
          {
            id: "recordingKeys",
            kind: "choice",
            path: "recording.keys",
            label: "Note keys",
            description:
              "The keys you press, to show on the timeline as markup. Shortcuts only: combinations with Ctrl, Alt or Win, and keys like Enter and Esc, never ordinary typing. All keys shows everything typed, passwords included. Also turned on or off as you record: the control's button, or Ctrl+Alt+K.",
            options: [
              { value: "off", label: "Off" },
              { value: "shortcuts", label: "Shortcuts only" },
              { value: "all", label: "All keys" },
            ],
            keywords: [
              "keys",
              "keystrokes",
              "keyboard",
              "shortcuts",
              "typing",
              "show keys",
              "tutorial",
            ],
          },
        ],
      },
      {
        title: "While recording an area",
        items: [
          {
            id: "recordingCorners",
            kind: "toggle",
            path: "recording.corners",
            label: "Mark the corners",
            description:
              "Corner marks just outside the area, so you can see what's being recorded. They're never in the recording.",
            keywords: ["corners", "marks", "outline", "border", "frame", "area", "region"],
          },
          {
            id: "recordingCornerColor",
            kind: "color",
            path: "recording.cornerColor",
            label: "Corner color",
            presets: [
              { color: "#00ff27", name: "Green" },
              { color: "#00d5ff", name: "Cyan" },
              { color: "#ff2bd6", name: "Magenta" },
              { color: "#ff2d2d", name: "Red" },
              { color: "#ff8a00", name: "Orange" },
              { color: "#ffe600", name: "Yellow" },
              { color: "#ffffff", name: "White" },
            ],
            disabled: (s) => !s.recording.corners,
            keywords: ["corners", "marks", "color", "colour"],
          },
          {
            id: "recordingDim",
            kind: "toggle",
            path: "recording.dim",
            label: "Dim the rest of the screen",
            description:
              "Darkens the screen around the area while it records. The recording isn't darkened.",
            keywords: ["dim", "darken", "shade", "overlay", "focus", "area", "region"],
          },
          {
            id: "recordingDimOpacity",
            kind: "slider",
            path: "recording.dimOpacity",
            label: "How dark",
            min: 0.05,
            max: 0.9,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            disabled: (s) => !s.recording.dim,
            keywords: ["dim", "darken", "opacity", "dark"],
          },
        ],
      },
    ],
  },
  {
    id: "proxies",
    title: "Proxies",
    icon: ProxiesIcon,
    description:
      "Small copies of each video, made when you open it, so stepping and scrubbing are instant. They're kept, so a video opens ready next time, along with copies of videos converted to play here; past the size limit, the ones used longest ago are deleted.",
    groups: [
      {
        items: [
          {
            id: "proxiesOn",
            kind: "toggle",
            path: "proxies.enabled",
            label: "Use proxies",
            description:
              "Off: nothing is made or kept, and stepping and scrubbing read the video itself, which is slower on long recordings.",
            keywords: ["proxy", "proxies", "cache", "scrub", "step", "fast", "off"],
          },
          {
            id: "proxyFolder",
            kind: "folder",
            path: "proxies.folder",
            label: "Folder",
            description:
              "Where proxies are kept. Clear it to go back to the default. Changing it moves the proxies already made.",
            defaultFolder: () => commands.defaultProxyFolder(),
            disabled: (s) => !s.proxies.enabled,
            keywords: ["proxy", "cache", "folder", "location", "disk", "drive"],
          },
          {
            id: "proxyLimit",
            kind: "proxyLimit",
            path: "proxies.limitGb",
            label: "Size limit",
            description: "The most space proxies may take up.",
            min: 1,
            max: 50,
            disabled: (s) => !s.proxies.enabled,
            keywords: ["proxy", "cache", "size", "limit", "space", "disk", "storage", "gb"],
          },
        ],
      },
    ],
  },
  {
    id: "about",
    title: "About",
    icon: AboutIcon,
    groups: [
      {
        items: [
          {
            id: "about",
            kind: "about",
            label: "About",
            keywords: ["version", "author", "copyright", "license", "flowcat"],
          },
        ],
      },
      {
        title: "Debugging",
        items: [
          {
            id: "logging",
            kind: "toggle",
            path: "debugging.logging",
            label: "Keep a log",
            description:
              "A log of what Razorcat does, and a report if it crashes, to send when something goes wrong. Never your file names, folders or text. Off, nothing is written.",
            keywords: ["log", "logging", "debug", "crash", "report", "diagnostics"],
          },
          {
            id: "logs",
            kind: "logs",
            label: "Logs and crash reports",
            visible: (s) => s.debugging.logging,
            keywords: ["log", "logs", "folder", "clear", "delete", "crash", "report", "debug"],
          },
        ],
      },
    ],
  },
];
