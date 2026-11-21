// The persisted batch state survives restarts; this in-process gate closes the
// small gap between the final database check and starting an HTTP request.
const halted = new Set();

export function haltBatch(batchId) { halted.add(batchId); }
export function unhaltBatch(batchId) { halted.delete(batchId); }
export function batchHalted(batchId) { return halted.has(batchId); }
