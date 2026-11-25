// Messages between the app and its worker.
export type ToWorker =
  | { kind: 'call'; id: number; name: string; args: string } // args: JSON
  | { kind: 'photo'; id: number; rgba: ArrayBuffer; width: number; height: number; args: string }

export type FromWorker =
  | { kind: 'progress'; fraction: number } // of the download
  | { kind: 'ready' } // the photo reader too
  | { kind: 'failed'; message: string; rules: boolean } // couldn't load; rules: those did
  | ({ kind: 'answer'; id: number } & ({ result: unknown } | { error: string } | { crashed: string } | { notLoaded: true }))
