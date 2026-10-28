// postject ships no type definitions; this covers the one function build-sea.ts uses.
declare module "postject" {
  export function inject(
    filename: string,
    resourceName: string,
    resourceData: Uint8Array,
    options: { sentinelFuse: string; machoSegmentName?: string; overwrite?: boolean },
  ): Promise<void>;
}
