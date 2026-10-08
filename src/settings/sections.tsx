// What the settings window shows (see schema.ts). Driveby's own settings arrive with the
// features that use them.
import { commands } from "../shared/ipc";
import {
  AboutIcon,
  EditingIcon,
  ExportIcon,
  GeneralIcon,
  ProxiesIcon,
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
    ],
  },
  {
    id: "timeline",
    title: "Timeline",
    icon: TimelineIcon,
    description: "What the timeline shows, and how ranges take edits.",
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
        title: "Ranges",
        items: [
          {
            id: "rangesFollowVideo",
            kind: "toggle",
            path: "timeline.rangesFollowVideo",
            label: "Ranges follow their video",
            description:
              "When clips are trimmed, deleted or moved, ranges stay on the frames they mark. Off: they stay at their place on the timeline.",
            keywords: ["ranges", "follow", "anchor", "stay", "move", "trim", "timeline"],
          },
          {
            id: "deleteRangesWithClip",
            kind: "toggle",
            path: "timeline.deleteRangesWithClip",
            label: "Deleting a clip deletes its ranges",
            description: "Off: they're kept, hidden, and come back if the clip does.",
            keywords: ["ranges", "delete", "clip", "remove", "timeline"],
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
            keywords: ["folder", "export", "save", "location", "path"],
          },
          {
            id: "timelineName",
            kind: "text",
            path: "export.timelineName",
            label: "Timeline file name",
            description: "{name} is the video's name. The Save dialog suggests it too.",
            placeholder: "{name}-edit",
            keywords: ["name", "file name", "template", "timeline", "export"],
          },
          {
            id: "clipName",
            kind: "text",
            path: "export.clipName",
            label: "Clip file names",
            description:
              "{name} is the video's name, {n} the clip's number: {nn} gives 01, 02..., {nnn} 001, 002...",
            placeholder: "{name}-clip{nn}",
            keywords: ["name", "file name", "template", "clip", "number", "export"],
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
            keywords: ["version", "author", "copyright", "license"],
          },
        ],
      },
    ],
  },
];
