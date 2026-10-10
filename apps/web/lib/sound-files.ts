/**
 * Recordings a deploy ships as ready sounds for the media board, beside the
 * ones computed in the page.
 *
 * To add one, put the audio file in `apps/web/public/sounds/` and list it
 * below. Every file in that folder is handed to whoever opens the site, so
 * each entry says under which license that is allowed and where the recording
 * came from. A file is fetched when someone adds its sound to their board and
 * never before.
 */

export interface SoundFile {
  /** On its button, on the pad, and in the chapter marker a fired pad drops. */
  name: string;
  /** The file's name inside `apps/web/public/sounds/`. */
  file: string;
  /** What allows shipping it, for example `CC0-1.0` or `own recording`. */
  license: string;
  /** Where it came from: a URL, or who recorded it. */
  source: string;
  /** Runs under speech: its pad starts out set to loop and to fade. */
  bed?: true;
}

export const SOUND_FILES: readonly SoundFile[] = [];

/** The recording as a file the board can load. */
export async function fetchSoundFile(sound: SoundFile): Promise<File> {
  const res = await fetch(`/sounds/${encodeURIComponent(sound.file)}`);
  if (!res.ok) throw new Error(`${sound.file}: ${res.status}`);
  return new File([await res.blob()], sound.name);
}
