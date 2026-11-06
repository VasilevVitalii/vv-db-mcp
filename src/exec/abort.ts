/**
 * Связывание AbortSignal'ов вручную (Node 18 без AbortSignal.any).
 * Аборт `source` приводит к аборту `target` с тем же reason.
 */
export function linkSignals(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason)
    return () => {}
  }
  const onAbort = () => target.abort(source.reason)
  source.addEventListener('abort', onAbort, { once: true })
  return () => source.removeEventListener('abort', onAbort)
}
