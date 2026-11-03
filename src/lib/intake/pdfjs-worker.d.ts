// pdfjs-dist ships type declarations for the engine (pdf.d.mts) but none
// for its worker module. device-print.ts imports the worker only for what
// it does when it loads: it sets globalThis.pdfjsWorker, the hook pdf.js
// checks before it would start a Worker. A literal import keeps the load
// visible to the device path's boundary check, and this declaration lets
// the compiler accept it.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
