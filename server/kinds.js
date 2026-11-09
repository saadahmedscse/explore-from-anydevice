/**
 * File kinds by extension. Shared by the server (search filters, preview types)
 * and the browser (icons, labels), so it must stay free of Node imports.
 */
const GROUPS = {
  image: 'jpg jpeg png gif webp avif bmp tif tiff heic heif svg ico raw cr2 cr3 nef arw dng psd exr hdr',
  video: 'mp4 m4v mov mkv avi wmv webm flv mpg mpeg 3gp ts mts m2ts',
  audio: 'mp3 m4a aac wav flac ogg oga opus wma aiff aif mid midi',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst iso dmg cab',
  doc: 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub pages numbers key',
  code: 'js mjs cjs ts tsx jsx json html htm css scss py rb go rs java kt c h cpp hpp cs php sh bat ps1 yml yaml toml xml sql ini cfg log',
  app: 'exe msi apk appx msix deb rpm',
};

const BY_EXT = new Map();
for (const [kind, list] of Object.entries(GROUPS)) for (const ext of list.split(' ')) BY_EXT.set(ext, kind);

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 'folder' | 'image' | 'video' | 'audio' | 'archive' | 'doc' | 'code' | 'app' | 'file' */
export function kindOf(name, isDir) {
  if (isDir) return 'folder';
  return BY_EXT.get(extOf(name)) || 'file';
}

const LABELS = {
  pdf: 'PDF document', doc: 'Word document', docx: 'Word document', xls: 'Excel sheet', xlsx: 'Excel sheet',
  ppt: 'PowerPoint', pptx: 'PowerPoint', txt: 'Text', md: 'Markdown', csv: 'CSV', zip: 'ZIP archive',
  rar: 'RAR archive', '7z': '7-Zip archive', mp4: 'MPEG-4 video', mov: 'QuickTime video', mkv: 'Matroska video',
  mp3: 'MP3 audio', wav: 'WAV audio', flac: 'FLAC audio', m4a: 'AAC audio', png: 'PNG image', jpg: 'JPEG image',
  jpeg: 'JPEG image', heic: 'HEIC image', gif: 'GIF image', webp: 'WebP image', svg: 'SVG image', exe: 'Application',
  msi: 'Installer', apk: 'Android app', iso: 'Disc image', json: 'JSON', html: 'HTML', js: 'JavaScript', py: 'Python',
};

export function kindLabel(name, isDir) {
  if (isDir) return 'Folder';
  const ext = extOf(name);
  if (LABELS[ext]) return LABELS[ext];
  return ext ? `${ext.toUpperCase()} file` : 'File';
}

/** Content type for an inline preview, or null when the browser should download instead. */
export function previewType(name) {
  const ext = extOf(name);
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogg: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', oga: 'audio/ogg', opus: 'audio/ogg',
    pdf: 'application/pdf',
  };
  if (map[ext]) return map[ext];
  if (GROUPS.code.split(' ').includes(ext) || ['txt', 'md', 'csv', 'log', 'ini'].includes(ext)) return 'text/plain; charset=utf-8';
  return null;
}
