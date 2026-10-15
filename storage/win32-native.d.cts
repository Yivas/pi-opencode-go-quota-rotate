export interface NativeStorageApi {
  directory(path: string): null;
  file(path: string): null;
  crypt(operation: "protect" | "unprotect", encoded: string): string;
  dispose(): void;
}
export function nativeApi(): NativeStorageApi;
