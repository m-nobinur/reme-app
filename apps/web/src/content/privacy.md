# Reme privacy policy

Last updated: 17 October 2026

This policy explains what Reme does with personal data when you use the Reme app at preview.remeai.co.uk, and when someone visits a website Reme publishes for a business at a remeai.co.uk address.

## Who we are

Reme (remeai.co.uk) is operated from the United Kingdom. We are the controller of the personal data described here.

For anything about your data, email privacy@remeai.co.uk.

## What we collect

**Your account.** Your name and email address. If you sign in with Google, Google tells our sign-in provider your name and email. If you use a password, our sign-in provider stores it. We never see or store it. If you sign in with a one-time code, our sign-in provider emails it to you.

**Your business.** The business name you give at sign-up and the web address made from it. The facts you tell the assistant, such as your phone number, email, opening hours, service area and prices. We keep each earlier version of a fact when you change it, with a note of where it came from.

**Your conversations.** Every message you send in the chat and every reply. Any reminders you or the assistant set.

**Your website.** Each version the AI Developer builds, the screenshots it takes of it, your approve or reject decisions, and a record of each time a version went live or was rolled back.

**The work log.** A record of what the assistant and the Developer did for your business. It includes what each AI model was sent and what it answered, the steps it took, and how much each step cost.

**Technical data.** Your IP address and browser details reach Cloudflare with every request. Our service logs record error codes and internal ids, such as your workspace id and build ids. We limit how many sign-in and sign-up attempts one email address can make in a short time.

We do not ask for payment details. There is no payment feature today.

## Why we use it, and our lawful basis

We use your account, business, conversation, website and work log data to provide Reme to you. That means signing you in, answering you in the chat, building your website and publishing it once you approve it. The lawful basis is **contract**. We need the data to provide the service you signed up for.

We use technical data and service logs to keep Reme secure, stop abuse such as repeated sign-in attempts, and find and fix faults. The lawful basis is **legitimate interests**. We need a working, secure service, and the data we use for this is limited to ids, error codes and request details.

We do not sell your data. We do not use it for advertising. We do not use it to train AI models of our own.

## How AI is involved

Reme's assistant and its website builder are AI models. To reply to you, we send the conversation so far, your business facts and your workspace details to an AI model. To build your website, we send your business facts and the build instructions to an AI model. We send these through OpenRouter, which passes each request to a company that runs the chosen model. We tell OpenRouter to use only companies that do not keep or train on what we send, and none based in China.

The models we use today are DeepSeek V4.1 Flash, GLM 5.3 Flash from Z.ai, and Grok 4.6 from xAI, which we fall back to when the first choice fails. We may change models. We will update this list when we do.

AI replies can be wrong. Nothing the Developer builds goes live until you approve it. Reme makes no decision about you that has a legal or similarly significant effect.

## Google Search Console

If you connect Google, Reme reads how your own website performs in Google Search: the searches it appeared for, clicks, impressions, and whether Google has indexed its pages. It also adds your website to your Search Console and sends Google its sitemap. We do this so the assistant can tell you how your website is doing and keep it findable. The lawful basis is **contract**, because you asked for it by connecting.

We keep your Google account email, a summary of those results for your website, and a refresh token that lets us keep reading them. The refresh token is encrypted, and only the part of Reme that talks to Google can decrypt it. We read nothing else from your Google account.

You can disconnect at any time by removing Reme at myaccount.google.com/permissions, which stops our access straight away. To have us delete what we stored, email privacy@remeai.co.uk.

Reme's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.

## Who else handles your data

These companies process data for us under contract, and only to provide Reme:

| Provider | What it does | Where |
| --- | --- | --- |
| Cloudflare | Runs the app and published websites, stores website files, runs the build environment, keeps service logs | Worldwide network. Website files and screenshots are stored in the European Union |
| Neon | Hosts our database | Frankfurt, Germany, on Amazon Web Services |
| WorkOS | Sign-in, and the sign-in code, verification and password reset emails | United States |
| OpenRouter | Routes requests to AI models | United States |
| AI model providers reached through OpenRouter | Produce chat replies and website code | Depends on the provider OpenRouter selects, which can be in the United States or other countries. We exclude providers based in China |
| Google | Only if you choose Sign in with Google or connect Google Search Console | United States |

Where your data leaves the UK, we rely on UK adequacy regulations where they exist. Otherwise we rely on the UK International Data Transfer Addendum or the UK Extension to the EU-US Data Privacy Framework, as applicable.

We may also share data if the law requires it, or to protect Reme or its users from fraud or harm.

## How long we keep it

We keep your account, business, conversation, website and work log data while your account is open.

Service logs are kept for the period Cloudflare's plan sets, and then deleted by Cloudflare.

After we erase data from our database, a copy can remain in its restore history for up to six hours, and in any snapshot we took before a software release until we delete that snapshot.

## What "Delete account" does

You can delete your account from the Account page in the app, if you are the only member of your workspace. When you do:

1. Your website goes offline at once. Some Cloudflare locations can keep serving a cached copy for up to about a minute.
2. Any build in progress stops.
3. We replace your email address with a meaningless placeholder and remove your name from your account record.
4. Your access to the workspace ends.
5. We delete your sign-in identity and your workspace's organisation at WorkOS. This ends all your sessions.

Today this does not yet erase your business data. Your business facts, conversations, reminders, website versions and files, work log, and the display name shown on your workspace stay in our database and storage. Nobody can sign in to that workspace and the website stays offline. This data stays until we erase it. To have it erased, email privacy@remeai.co.uk and we will act on your request within one month.

You can sign up again later with the same email address. You start with a new, empty workspace.

## Your rights

Under UK data protection law you have the right to:

- get a copy of your personal data
- have inaccurate data corrected
- have your data erased
- restrict how we use your data
- receive the data you gave us in a machine-readable format, or have it sent to another company
- object to our use of your data where we rely on legitimate interests

You can correct most business facts yourself by telling the assistant. For anything else, email privacy@remeai.co.uk. We may ask you to confirm your identity. We will reply within one month. If a request is complex we can extend this by up to two more months, and we will tell you if we do.

If you are unhappy with how we handle your data, please tell us first. You also have the right to complain to the Information Commissioner's Office at ico.org.uk or on 0303 123 1113.

## Cookies

We use only cookies needed to sign you in, keep you signed in and remember choices you make. We use no analytics or advertising cookies, and no tracking tools of any kind. That is why we do not show a cookie banner.

| Name | Purpose | How long |
| --- | --- | --- |
| __Host-wos-session | Keeps you signed in. Its contents are encrypted | Up to 400 days, or until you sign out |
| __Host-reme-auth-flow | Carries a sign-in or sign-up through its steps. Encrypted | 10 minutes |
| reme-oauth-state | Protects Sign in with Google against forged requests | 10 minutes |
| reme-google-state | Holds the sign-in state while you connect Google, and protects it against forged requests | 10 minutes |
| __Host-reme-org-intent | Remembers your business name if sign-up stopped before your workspace was created. Encrypted | 30 days |
| reme-notifications-seen-... | Remembers which notifications you have already seen | 1 year |
| reme_preview | Opens a preview of an unpublished website version from a preview link | Up to 24 hours |

The app also stores two settings in your browser rather than in cookies. `reme-theme` holds your light or dark choice. `reme-mode` holds the chat mode for the current browser tab and is cleared when you close it.

Websites Reme publishes set no cookies and run no analytics. Cloudflare handles each visit to them and records the technical data described above.

## Visitors to a published website

Each business decides what its website says and is responsible for the personal data it publishes there. Published websites have no forms today, so Reme collects nothing from visitors beyond what Cloudflare records to serve the page.

## Children

Reme is for businesses. You must be 18 or over to use it. We do not knowingly collect data from anyone under 18.

## Changes to this policy

When we change this policy, we will update the date at the top. If a change affects how we use your data, we will email you or tell you in the app before it takes effect.
