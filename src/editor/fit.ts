// Fitting the picture into the preview.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/**
 * The largest rect of `picture`'s shape that fits `area` less `margin` on every side, centred,
 * in whole pixels. Upscales small videos too: the preview fills the space.
 */
export function fitRect(area: Size, picture: Size, margin: number): Rect {
  const w = Math.max(0, area.width - 2 * margin);
  const h = Math.max(0, area.height - 2 * margin);
  if (picture.width <= 0 || picture.height <= 0 || w === 0 || h === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(w / picture.width, h / picture.height);
  const width = Math.round(picture.width * scale);
  const height = Math.round(picture.height * scale);
  return {
    x: Math.round((area.width - width) / 2),
    y: Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * How to place the `<video>` in the stage so the picture shows upright. If the video's own size
 * already has the shown shape (WebView2 honoured the rotation flag, or there is none), it fills
 * the stage. Otherwise it's sized as stored and turned by the rotation, about the stage's centre.
 */
export function videoTransform(
  natural: Size,
  source: Size & { rotation: number },
  stage: Size,
): { width: number; height: number; css: string } {
  const quarter = source.rotation % 180 === 90;
  const naturalPortrait = natural.height > natural.width;
  const shownPortrait = source.height > source.width;
  const honoured = !quarter || naturalPortrait === shownPortrait;
  if (honoured || natural.width === natural.height) {
    return { width: stage.width, height: stage.height, css: "none" };
  }
  // Stored sideways: lay it out at the stage's size swapped, then turn it into place.
  const dx = (stage.width - stage.height) / 2;
  return {
    width: stage.height,
    height: stage.width,
    css: `translate(${dx}px, ${-dx}px) rotate(${source.rotation}deg)`,
  };
}
