const PLAN: Record<string, [string, number, string]> = {
  drivers: ['Drivers', 2, 'Driver master with licence and visa expiry, status and availability.'],
  vehicles: ['Vehicles', 2, 'Vehicle master with type, capacity, registration and insurance expiry.'],
  customers: ['Customers', 2, 'Customer master. New customers can already be added from the request form.'],
  locations: ['Locations', 2, 'Saved pickup and delivery points with contacts and coordinates.'],
  financials: ['Financials', 5, 'Revenue, cost and profit by month, customer, driver and vehicle type.'],
  reports: ['Reports', 6, 'Operational, financial, driver, vehicle, customer and POD-pending reports with Excel/CSV/PDF export.'],
  documents: ['Documents', 4, 'All job documents in one place. Commercial documents stay hidden from Transport.'],
  settings: ['Settings', 2, 'VAT, currency, company details, statuses and configurable lists.'],
};
export default function Soon({ params }: { params: { section: string } }) {
  const p = PLAN[params.section];
  if (!p) return <div className="page"><h1>Page not found</h1></div>;
  return (
    <div className="page">
      <div className="page-head"><h1>{p[0]}</h1></div>
      <div className="panel"><p style={{ marginTop: 0 }}>{p[2]}</p><p className="muted" style={{ marginBottom: 0 }}>Scheduled for Phase {p[1]}. The database tables for this module already exist.</p></div>
    </div>
  );
}
