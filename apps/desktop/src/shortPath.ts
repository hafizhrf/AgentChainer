/**
 * A folder's path where space is short (UX-20): the home folder as `~`, and a long path with its middle left out,
 * keeping its first part and its last two folders. The full path goes in the title.
 */
export function shortPath(dir: string, homeDir: string | null, max = 48): string {
  let p = dir.replace(/[\\/]+$/, "");
  if (homeDir) {
    const home = homeDir.replace(/[\\/]+$/, "");
    if (p.toLowerCase() === home.toLowerCase()) return "~";
    if (
      p.toLowerCase().startsWith(`${home.toLowerCase()}${p.charAt(home.length)}`) &&
      /[\\/]/.test(p.charAt(home.length))
    )
      p = `~${p.slice(home.length)}`;
  }
  if (p.length <= max) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(/[\\/]/);
  if (parts.length <= 3) return `…${p.slice(-(max - 1))}`;
  const tail = parts.slice(-2).join(sep);
  return `${parts[0]}${sep}…${sep}${tail}`.length <= max + 8 ? `${parts[0]}${sep}…${sep}${tail}` : `…${sep}${tail}`;
}
