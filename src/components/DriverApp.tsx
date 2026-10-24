// Shared by the driver's phone screens (My jobs).

/** What the driver should do next, in plain words. */
export function nextStep(j: any) {
  if (['assigned', 'confirmed'].includes(j.status_code)) return 'Start the trip when you leave';
  if (j.status_code === 'dispatched') return 'Go to the pickup';
  if (['picked_up', 'in_transit'].includes(j.status_code)) return 'Deliver the goods';
  if (['delivered', 'pod_pending'].includes(j.status_code) && ['pending', 'rejected'].includes(j.pod_status))
    return j.pod_status === 'rejected' ? 'POD rejected — take a new photo' : 'Take the POD photo';
  return '';
}

