/**
 * Every string the site shows comes from here. A fact field holds the
 * rendered form of a canonical fact, and an empty string means there is no
 * such fact: the page leaves that part out rather than showing a placeholder,
 * and the Developer asks for the fact instead of inventing one.
 *
 * This file imports nothing, so it builds anywhere the site does.
 */
export const site = {
  businessName: "",
  tagline: "",
  skipLink: "Skip to content",
  notFoundHeading: "Page not found",
  notFoundBody: "The page you asked for is not here.",
  homeLink: "Go to the home page",
}
