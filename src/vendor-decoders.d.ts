declare module "pngjs" {
  export const PNG: { sync: { read(bytes: Buffer, options?: { checkCRC?: boolean }): { width: number; height: number; data: Buffer } } };
}
declare module "jpeg-js" {
  const jpeg: { decode(bytes: Buffer, options?: { useTArray?: boolean; maxResolutionInMP?: number; maxMemoryUsageInMB?: number }): { width: number; height: number; data: Uint8Array } };
  export default jpeg;
}
