export function applyPlatformFlags(doc: Document, isNative: boolean): void {
  if (isNative) {
    doc.documentElement.dataset.native = '1';
  } else {
    delete doc.documentElement.dataset.native;
  }
}
