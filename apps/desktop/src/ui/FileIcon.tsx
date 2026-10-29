import { Bun, Dart, Gear, GoMod, NPM, PNPM, Yarn } from "@react-symbols/icons/files";
import { FileIcon as SymbolsFile, FolderIcon as SymbolsFolder } from "@react-symbols/icons/utils";

/** Project files the icon set doesn't recognize by name. Keys are lowercase. */
const BY_NAME = {
  "package.json": NPM,
  "package-lock.json": NPM,
  "pnpm-lock.yaml": PNPM,
  "pnpm-workspace.yaml": PNPM,
  "yarn.lock": Yarn,
  "bun.lock": Bun,
  "bun.lockb": Bun,
  "go.mod": GoMod,
  "go.sum": GoMod,
  "pubspec.yaml": Dart,
  "pubspec.lock": Dart,
};

/** A file-type or folder icon from the Symbols icon theme (VS Code style), by file or folder name. */
export function FileIcon({ path, folder = false, size = 16 }: { path: string; folder?: boolean; size?: number }) {
  const name = (path.split(/[\\/]/).at(-1) ?? path).toLowerCase();
  const props = { width: size, height: size, className: "file-icon", "aria-hidden": true, focusable: false } as const;
  if (folder) return <SymbolsFolder folderName={name} {...props} />;
  if (name === ".env" || name.startsWith(".env.")) return <Gear {...props} />;
  return <SymbolsFile fileName={name} autoAssign editFileNameData={BY_NAME} {...props} />;
}
