// What the settings window shows (see schema.ts). Driveby's own settings arrive with the
// features that use them.
import { commands } from "../shared/ipc";
import { AboutIcon, GeneralIcon, ProxiesIcon, TimelineIcon } from "./icons";
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
