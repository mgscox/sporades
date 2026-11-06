export type ExceptionFrame = { filename: string; function: string; lineno?: number; colno?: number };

/** Serialized into the first-party loader too; keep this function self-contained. */
export function exceptionFrames(input: unknown, embeddedSource = "sporades://embedded/module"): ExceptionFrame[] {
  if (typeof input !== "string") return [];
  // Bound scanning independently of the transport budget. Never export inline source.
  const stack = input.slice(0, 1024 * 1024);
  const frames: ExceptionFrame[] = [];
  let offset = 0;
  for (let count = 0; count < 100 && offset < stack.length && frames.length < 20; count++) {
    let end = stack.indexOf("\n", offset);
    if (end < 0) {
      if (input.length > stack.length) break; // An incomplete line cannot establish coordinates.
      end = stack.length;
    }
    let line = stack.slice(offset, end).trim();
    offset = end + 1;
    const v8 = line.startsWith("at ");
    if (v8) line = line.slice(3);
    if (v8 && line.endsWith(")")) line = line.slice(0, -1);
    // Coordinates are at the right edge: schemes, ports and filenames may contain colons.
    const coordinates = /:(\d{1,10}):(\d{1,10})$/.exec(line);
    if (!coordinates) continue;
    let location = line.slice(0, coordinates.index), fn = "<anonymous>";
    if (v8) {
      const opening = location.indexOf(" (");
      if (opening >= 0) { fn = location.slice(0, opening); location = location.slice(opening + 2); }
    } else {
      const at = location.indexOf("@");
      if (at < 0) continue;
      fn = location.slice(0, at) || fn; location = location.slice(at + 1);
    }
    if (/^(?:data|blob):/i.test(location)) location = embeddedSource;
    // Remove private URL suffixes before bounding filenames, preserving coordinates above.
    location = location.split(/[?#]/, 1)[0];
    if (!location || location.length > 4096 || fn.length > 1024 || /data:|base64,/i.test(fn)) continue;
    const lineno = Number(coordinates[1]), colno = Number(coordinates[2]);
    if (lineno < 1 || colno < 1) continue;
    frames.push({ filename: location, function: fn, lineno, colno });
  }
  return frames.reverse();
}
