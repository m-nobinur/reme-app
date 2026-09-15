/**
 * Every string the site shows comes from here, and everything here comes
 * from a canonical fact. An empty string means "no fact": the page leaves
 * that part out rather than showing a placeholder, and the Developer asks
 * for the fact instead of inventing one.
 */
export const site = {
  /** business.name */
  name: "",
  /** A one-line description of what the business does, from its facts. */
  tagline: "",
  /** business.phone, E.164, shown as given. */
  phone: "",
  /** business.email */
  email: "",
  /** hours.weekday, as "08:00 to 17:00". */
  weekdayHours: "",
  /** service_area.radius, as "within 25 km of Fairhaven". */
  serviceArea: "",
  /** pricing.standard_clean_hourly, as "$35 an hour". */
  standardCleanHourly: "",
}
