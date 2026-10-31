// One definition per master list, shared by the server (validation, SQL)
// and the screens (table columns, forms). Adding a field here adds it everywhere.
import type { Perm } from './permissions';

export type FieldType = 'text' | 'longtext' | 'email' | 'phone' | 'date' | 'number' | 'int' | 'select' | 'ref' | 'bool';
export interface MasterField {
  key: string; label: string; type: FieldType; required?: boolean; max?: number;
  options?: { value: string; label: string }[];
  ref?: 'vehicle_types' | 'drivers' | 'customers' | 'subcontractors';   // dropdown source (from /api/lookups)
  list?: boolean;          // show as a column in the table
  expiry?: boolean;        // highlight when expired / expiring soon
  half?: boolean;          // half-width in the form
}
export interface MasterDef {
  key: string; table: string; title: string; singular: string; perm: Perm;
  softDelete: boolean; activeField: 'is_active' | 'status';
  orderBy: string; search: string[]; fields: MasterField[];
  joins?: string; joinCols?: string;       // server-side display columns
  display?: Record<string, string>;        // field key -> display column from join
  blurb: string;
  costly?: boolean;                        // holds transport cost: only cost viewers and managers may list it
}

const EMIRATES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah']
  .map((e) => ({ value: e, label: e }));

export const MASTERS: Record<string, MasterDef> = {
  drivers: {
    key: 'drivers', table: 'drivers', title: 'Drivers', singular: 'driver', perm: 'drivers.manage',
    softDelete: true, activeField: 'status', orderBy: 'e.full_name',
    search: ['e.full_name', 'e.mobile', 'e.driver_code', 'e.employee_id', 'e.license_number'],
    blurb: 'Availability for a specific job is checked against their other jobs when you assign. Use status for leave and days off.',
    fields: [
      { key: 'full_name', label: 'Name', type: 'text', required: true, list: true, max: 120 },
      { key: 'driver_code', label: 'Driver ID', type: 'text', list: true, max: 30, half: true },
      { key: 'mobile', label: 'Mobile', type: 'phone', list: true, max: 30, half: true },
      { key: 'email', label: 'Email', type: 'email', max: 120, half: true },
      { key: 'employee_id', label: 'Employee ID', type: 'text', max: 30, half: true },
      { key: 'license_number', label: 'Licence number', type: 'text', max: 40, half: true },
      { key: 'license_expiry', label: 'Licence expiry', type: 'date', list: true, expiry: true, half: true },
      { key: 'visa_expiry', label: 'Visa expiry', type: 'date', list: true, expiry: true, half: true },
      { key: 'joining_date', label: 'Joining date', type: 'date', half: true },
      { key: 'status', label: 'Status', type: 'select', required: true, list: true, options: [
        { value: 'available', label: 'Available' }, { value: 'on_leave', label: 'On leave' },
        { value: 'off_duty', label: 'Off duty' }, { value: 'inactive', label: 'Inactive' }] },
      { key: 'remarks', label: 'Remarks', type: 'longtext', max: 1000 },
    ],
  },
  vehicles: {
    key: 'vehicles', table: 'vehicles', title: 'Vehicles', singular: 'vehicle', perm: 'vehicles.manage',
    softDelete: true, activeField: 'status', orderBy: 'e.vehicle_number',
    search: ['e.vehicle_number', 'e.make', 'e.model', 'vt.name'],
    joins: 'left join vehicle_types vt on vt.id = e.vehicle_type_id left join drivers dd on dd.id = e.default_driver_id',
    joinCols: 'vt.name vehicle_type_name, dd.full_name default_driver_name',
    display: { vehicle_type_id: 'vehicle_type_name', default_driver_id: 'default_driver_name' },
    blurb: 'Capacity is compared with the cargo weight and volume when a vehicle is assigned.',
    fields: [
      { key: 'vehicle_number', label: 'Plate number', type: 'text', required: true, list: true, max: 30, half: true },
      { key: 'vehicle_type_id', label: 'Vehicle type', type: 'ref', ref: 'vehicle_types', required: true, list: true, half: true },
      { key: 'category', label: 'Category', type: 'text', max: 40, half: true },
      { key: 'make', label: 'Make', type: 'text', max: 40, half: true },
      { key: 'model', label: 'Model', type: 'text', max: 40, half: true },
      { key: 'year', label: 'Year', type: 'int', half: true },
      { key: 'weight_capacity_kg', label: 'Weight capacity (kg)', type: 'number', list: true, half: true },
      { key: 'volume_capacity_cbm', label: 'Volume capacity (cbm)', type: 'number', half: true },
      { key: 'registration_expiry', label: 'Registration expiry', type: 'date', list: true, expiry: true, half: true },
      { key: 'insurance_expiry', label: 'Insurance expiry', type: 'date', list: true, expiry: true, half: true },
      { key: 'default_driver_id', label: 'Usual driver', type: 'ref', ref: 'drivers', list: true, half: true },
      { key: 'status', label: 'Status', type: 'select', required: true, list: true, half: true, options: [
        { value: 'available', label: 'Available' }, { value: 'maintenance', label: 'In maintenance' }, { value: 'inactive', label: 'Inactive' }] },
      { key: 'remarks', label: 'Remarks', type: 'longtext', max: 1000 },
    ],
  },
  subcontractors: {
    key: 'subcontractors', table: 'subcontractors', title: 'Rental companies', singular: 'rental company', perm: 'vehicles.manage',
    softDelete: true, activeField: 'is_active', orderBy: 'e.name',
    search: ['e.name', 'e.contact_person', 'e.contact_number', 'e.trn'],
    blurb: 'Companies you hire trucks from when your own vehicles are not available. Hire one from the job page: "Hire rental truck".',
    fields: [
      { key: 'name', label: 'Company name', type: 'text', required: true, list: true, max: 160 },
      { key: 'contact_person', label: 'Contact person', type: 'text', list: true, max: 120, half: true },
      { key: 'contact_number', label: 'Phone', type: 'phone', list: true, max: 40, half: true },
      { key: 'email', label: 'Email', type: 'email', max: 120, half: true },
      { key: 'trn', label: 'TRN', type: 'text', list: true, max: 30, half: true },
      { key: 'address', label: 'Address', type: 'text', max: 300 },
      { key: 'is_active', label: 'In use', type: 'bool', list: true },
      { key: 'remarks', label: 'Remarks', type: 'longtext', max: 1000 },
    ],
  },
  rental_rates: {
    key: 'rental_rates', table: 'rental_rates', title: 'Rental rates', singular: 'rental rate', perm: 'vehicles.manage',
    softDelete: true, activeField: 'is_active', orderBy: 's.name, vt.name, e.from_place, e.to_place', costly: true,
    search: ['s.name', 'vt.name', 'e.from_place', 'e.to_place'],
    joins: 'join subcontractors s on s.id = e.subcontractor_id join vehicle_types vt on vt.id = e.vehicle_type_id',
    joinCols: 's.name subcontractor_name, vt.name vehicle_type_name',
    display: { subcontractor_id: 'subcontractor_name', vehicle_type_id: 'vehicle_type_name' },
    blurb: 'Standard price each rental company charges per truck type and route. When you hire a truck, the matching rate fills in the cost — you can still change it.',
    fields: [
      { key: 'subcontractor_id', label: 'Rental company', type: 'ref', ref: 'subcontractors', required: true, list: true, half: true },
      { key: 'vehicle_type_id', label: 'Truck type', type: 'ref', ref: 'vehicle_types', required: true, list: true, half: true },
      { key: 'from_place', label: 'From', type: 'text', required: true, list: true, max: 120, half: true },
      { key: 'to_place', label: 'To', type: 'text', required: true, list: true, max: 120, half: true },
      { key: 'standard_cost', label: 'Standard cost (AED, excl. VAT)', type: 'number', required: true, list: true, half: true },
      { key: 'is_active', label: 'In use', type: 'bool', list: true, half: true },
      { key: 'remarks', label: 'Remarks', type: 'longtext', max: 1000 },
    ],
  },
  customers: {
    key: 'customers', table: 'customers', title: 'Customers', singular: 'customer', perm: 'customers.manage',
    softDelete: true, activeField: 'is_active', orderBy: 'e.name',
    search: ['e.name', 'e.code', 'e.contact_person', 'e.contact_number', 'e.trn'],
    blurb: 'Customers that are made inactive stay on their past jobs but no longer appear on new requests.',
    fields: [
      { key: 'name', label: 'Customer name', type: 'text', required: true, list: true, max: 200 },
      { key: 'code', label: 'Code', type: 'text', list: true, max: 30, half: true },
      { key: 'trn', label: 'TRN', type: 'text', max: 30, half: true },
      { key: 'contact_person', label: 'Contact person', type: 'text', list: true, max: 120, half: true },
      { key: 'contact_number', label: 'Contact number', type: 'phone', list: true, max: 30, half: true },
      { key: 'email', label: 'Email', type: 'email', max: 120, half: true },
      { key: 'is_active', label: 'Active', type: 'bool', list: true, half: true },
      { key: 'address', label: 'Address', type: 'longtext', max: 500 },
      { key: 'remarks', label: 'Remarks', type: 'longtext', max: 1000 },
    ],
  },
  locations: {
    key: 'locations', table: 'locations', title: 'Locations', singular: 'location', perm: 'locations.manage',
    softDelete: true, activeField: 'is_active', orderBy: 'e.name',
    search: ['e.name', 'e.address', 'e.emirate', 'e.contact_person', 'c.name'],
    joins: 'left join customers c on c.id = e.customer_id', joinCols: 'c.name customer_name',
    display: { customer_id: 'customer_name' },
    blurb: 'Saved pickup and delivery points. A job keeps its own copy, so editing a location never changes past jobs.',
    fields: [
      { key: 'name', label: 'Location name', type: 'text', required: true, list: true, max: 200 },
      { key: 'emirate', label: 'Emirate', type: 'select', list: true, options: EMIRATES, half: true },
      { key: 'customer_id', label: 'Belongs to customer', type: 'ref', ref: 'customers', list: true, half: true },
      { key: 'address', label: 'Address', type: 'longtext', list: true, max: 500 },
      { key: 'contact_person', label: 'Contact person', type: 'text', max: 120, half: true },
      { key: 'contact_number', label: 'Contact number', type: 'phone', max: 30, half: true },
      { key: 'latitude', label: 'Latitude', type: 'number', half: true },
      { key: 'longitude', label: 'Longitude', type: 'number', half: true },
      { key: 'is_active', label: 'Active', type: 'bool', list: true, half: true },
    ],
  },
  vehicle_types: {
    key: 'vehicle_types', table: 'vehicle_types', title: 'Vehicle types', singular: 'vehicle type', perm: 'settings.manage',
    softDelete: false, activeField: 'is_active', orderBy: 'e.sort_order, e.name', search: ['e.name'],
    blurb: 'Shown in requests and on vehicles. Capacities are used for "vehicle too small" warnings.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true, max: 60, half: true },
      { key: 'sort_order', label: 'Order in lists', type: 'int', list: true, half: true },
      { key: 'weight_capacity_kg', label: 'Weight capacity (kg)', type: 'number', list: true, half: true },
      { key: 'volume_capacity_cbm', label: 'Volume capacity (cbm)', type: 'number', list: true, half: true },
      { key: 'is_active', label: 'Active', type: 'bool', list: true, half: true },
    ],
  },
};
