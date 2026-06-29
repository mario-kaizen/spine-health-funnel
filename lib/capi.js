// Summarize a Meta CAPI /events response into a stored lead status.
function summarizeCapi(resp) {
  if (!resp) return { status: 'skipped', received: 0 };
  if (resp.error) return { status: 'error', received: 0 };
  return { status: 'sent', received: Number(resp.events_received || 0) };
}
module.exports = { summarizeCapi };
