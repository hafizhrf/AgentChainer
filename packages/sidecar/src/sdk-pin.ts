/** The exact SDK build the packaged app downloads and verifies on first run (ADR-0003, M0-03). */
export type SdkPin = { name: string; version: string; tarball: string; integrity: string };

/** Reads a package's integrity from pnpm-lock.yaml and derives its npm registry tarball URL. */
export function pinFromLockfile(lock: string, name: string, version: string): SdkPin {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${name} must be pinned to an exact version, got "${version}"`);
  const key = `'${name}@${version}':`;
  const at = lock.indexOf(`\n  ${key}`);
  if (at < 0) throw new Error(`${name}@${version} not found in pnpm-lock.yaml`);
  const integrity = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(lock.slice(at, at + 400))?.[1];
  if (!integrity) throw new Error(`No sha512 integrity for ${name}@${version} in pnpm-lock.yaml`);
  const bare = name.split("/").pop() ?? name;
  return { name, version, tarball: `https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`, integrity };
}
